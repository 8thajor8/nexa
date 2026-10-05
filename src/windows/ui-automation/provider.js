import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppCatalog } from '../app-catalog.js';
import { matchWindows, readWindowsSnapshot } from '../window-control.js';

const providerScript = fileURLToPath(new URL('./uia-provider.ps1', import.meta.url));
const maxOutputBytes = 1_000_000;

function failure(code, message) {
    return { success: false, error: { code, message } };
}

export async function resolveAppWindow(app, {
    platform = process.platform,
    readSnapshot = readWindowsSnapshot,
    loadCatalog = loadAppCatalog,
    environment = process.env,
} = {}) {
    if (platform !== 'win32') return failure('ui_automation_unavailable', 'La automatización UI solo está disponible en Windows.');
    if (typeof app !== 'string' || !app.trim() || app.length > 120 || /[\u0000-\u001f\u007f]/u.test(app)) {
        return failure('invalid_app', 'Indicá el nombre de una aplicación conocida.');
    }

    let snapshot;
    try {
        snapshot = await readSnapshot({ platform });
    } catch {
        return failure('ui_automation_unavailable', 'No se pudo consultar la ventana de la aplicación.');
    }
    if (!snapshot?.success) return failure('ui_automation_unavailable', 'No se pudo consultar la ventana de la aplicación.');

    let catalog;
    try {
        catalog = await loadCatalog();
    } catch {
        catalog = { version: 1, apps: [] };
    }
    const match = matchWindows(snapshot.windows, app.trim(), catalog, environment);
    if (match.kind === 'ambiguous' || match.matches.length > 1) {
        return failure('ambiguous_window', 'Hay varias ventanas de esa aplicación; cerrá o seleccioná una para continuar.');
    }
    if (match.kind !== 'application') {
        return failure('app_not_found', 'La UI Automation solo puede resolver una aplicación conocida del catálogo o la lista segura.');
    }
    if (match.matches.length === 0) return failure('app_not_running', `No se encontró una ventana abierta para «${app.trim()}».`);
    return { success: true, app: match.app ?? app.trim(), window: match.matches[0] };
}

function getPowerShellPath(environment = process.env) {
    const systemRoot = environment.SystemRoot ?? environment.WINDIR;
    if (!systemRoot) return null;
    return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function runWindowsUiAutomation(request, {
    platform = process.platform,
    environment = process.env,
    spawnProcess = spawn,
    timeoutMs = 10_000,
} = {}) {
    const allowedOperations = new Set(['inspect', 'focus', 'invoke', 'set_value', 'get_value']);
    if (!request || !allowedOperations.has(request.operation) || !/^0x[0-9a-f]+$/iu.test(request.windowHandle ?? '')) {
        return Promise.resolve(failure('invalid_request', 'La solicitud UI Automation no es válida.'));
    }
    if (request.operation === 'set_value' && (typeof request.value !== 'string' || request.value.length > 2000)) {
        return Promise.resolve(failure('invalid_request', 'El texto supera el límite permitido.'));
    }
    if (request.operation !== 'inspect') {
        const locator = request.locator;
        const expected = request.expected;
        if (
            !Array.isArray(locator?.path) || locator.path.length === 0 || locator.path.length > 16 ||
            locator.path.some(index => !Number.isInteger(index) || index < 0 || index > 500) ||
            !Array.isArray(locator.runtimeId) || locator.runtimeId.length > 32 || locator.runtimeId.some(id => !Number.isInteger(id)) ||
            !Array.isArray(locator.ancestry) || locator.ancestry.length > 16 || locator.ancestry.some(parent =>
                !['name', 'controlType', 'automationId'].every(key => typeof parent?.[key] === 'string' && parent[key].length <= 300)
            ) ||
            !['name', 'controlType', 'automationId'].every(key => typeof expected?.[key] === 'string' && expected[key].length <= 300)
        ) return Promise.resolve(failure('invalid_request', 'La referencia interna UI Automation no es válida.'));
    }
    if (platform !== 'win32') {
        return Promise.resolve(failure('ui_automation_unavailable', 'La automatización UI solo está disponible en Windows.'));
    }
    const executable = getPowerShellPath(environment);
    if (!executable) {
        return Promise.resolve(failure('ui_automation_unavailable', 'No se encontró Windows PowerShell para UI Automation.'));
    }

    return new Promise(resolve => {
        let child;
        let stdout = '';
        let finished = false;
        let timer;
        const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve(result);
        };
        try {
            child = spawnProcess(executable, [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', providerScript,
            ], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        } catch {
            finish(failure('ui_automation_unavailable', 'No se pudo iniciar el proveedor UI Automation de Windows.'));
            return;
        }
        timer = setTimeout(() => {
            child.kill();
            finish(failure('ui_automation_unavailable', 'Windows UI Automation superó el tiempo máximo de respuesta.'));
        }, timeoutMs);

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
            if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
                child.kill();
                finish(failure('ui_automation_unavailable', 'La respuesta UI Automation excedió el límite permitido.'));
            }
        });
        child.once('error', () => finish(failure('ui_automation_unavailable', 'No se pudo iniciar el proveedor UI Automation de Windows.')));
        child.once('close', code => {
            if (finished) return;
            if (code !== 0) {
                finish(failure('ui_automation_unavailable', 'El proveedor UI Automation de Windows no pudo completar la consulta.'));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                finish(result && typeof result.success === 'boolean'
                    ? result
                    : failure('ui_automation_unavailable', 'El proveedor devolvió una respuesta no válida.'));
            } catch {
                finish(failure('ui_automation_unavailable', 'El proveedor devolvió una respuesta no válida.'));
            }
        });
        child.stdin.end(JSON.stringify(request));
    });
}

export async function inspectAppUi(app, options = {}) {
    const resolved = await (options.resolveWindow ?? resolveAppWindow)(app, options.windowOptions);
    if (!resolved.success) return resolved;
    const handle = resolved.window?._handle;
    if (handle === undefined || handle === null) return failure('window_not_found', 'No se pudo identificar la ventana resuelta.');
    const provider = options.provider ?? runWindowsUiAutomation;
    const result = await provider({
        operation: 'inspect',
        windowHandle: `0x${BigInt(handle).toString(16)}`,
        maxDepth: options.maxDepth,
        maxElements: options.maxElements,
        maxTextLength: options.maxTextLength,
    });
    return result.success ? { ...result, app: resolved.app, windowId: resolved.window.id } : result;
}

export async function useAppUiElement(app, locator, operation, value, options = {}) {
    const resolved = await (options.resolveWindow ?? resolveAppWindow)(app, options.windowOptions);
    if (!resolved.success) return resolved;
    if (options.windowId && resolved.window.id !== options.windowId) {
        return { ...failure('stale_ui_reference', 'La ventana cambió desde la inspección; inspeccioná nuevamente.'), reason: 'window_changed' };
    }
    const handle = resolved.window?._handle;
    if (handle === undefined || handle === null) return failure('window_not_found', 'No se pudo identificar la ventana resuelta.');
    const provider = options.provider ?? runWindowsUiAutomation;
    return provider({
        operation,
        windowHandle: `0x${BigInt(handle).toString(16)}`,
        locator,
        expected: options.expected,
        ...(value !== undefined ? { value } : {}),
    });
}
