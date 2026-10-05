import path from 'node:path';

import {
    loadAppCatalog,
    normalizeAppName,
} from './app-catalog.js';
import { isTrustedAppPath } from './app-discovery.js';
import { windowsAppWhitelist } from './app-whitelist.js';
import { listRunningProcesses } from './processes.js';

const maxTargetLength = 120;
const maxWindowTitleLength = 512;
const showNormal = 1;
const showMinimized = 6;
const showMaximized = 3;
const windowMessageClose = 0x0010;

function failure(code, message, extra = {}) {
    return { success: false, error: { code, message }, ...extra };
}

function windowTool(name, description, argumentName = null) {
    const properties = argumentName
        ? {
            [argumentName]: {
                type: 'string',
                minLength: 1,
                maxLength: maxTargetLength,
                description: argumentName === 'app'
                    ? 'Nombre lógico de una aplicación del catálogo o de la lista conocida.'
                    : 'Nombre lógico de una aplicación o criterio de título de ventana.',
            },
        }
        : {};
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        },
        strict: true,
    };
}

export const isAppRunningTool = windowTool(
    'is_app_running',
    'Comprueba si está ejecutándose una aplicación conocida por su nombre lógico.',
    'app'
);
export const getActiveWindowTool = windowTool(
    'get_active_window',
    'Indica cuál es la ventana activa de Windows.'
);
export const listWindowsTool = windowTool(
    'list_windows',
    'Lista las ventanas visibles de Windows con título, proceso, PID e identificador interno.'
);
export const focusWindowTool = windowTool(
    'focus_window',
    'Pone al frente una ventana encontrada por nombre lógico de aplicación o título.',
    'target'
);
export const maximizeWindowTool = windowTool(
    'maximize_window',
    'Maximiza una ventana encontrada por nombre lógico de aplicación o título.',
    'target'
);
export const minimizeWindowTool = windowTool(
    'minimize_window',
    'Minimiza una ventana encontrada por nombre lógico de aplicación o título.',
    'target'
);
export const restoreWindowTool = windowTool(
    'restore_window',
    'Restaura una ventana a su tamaño normal por nombre lógico de aplicación o título.',
    'target'
);
export const closeWindowTool = windowTool(
    'close_window',
    'Solicita el cierre normal de una ventana por nombre lógico de aplicación o título.',
    'target'
);

function getWindowsApiFactory() {
    let cachedPromise;
    return async function loadWindowsApi() {
        if (cachedPromise) return cachedPromise;
        cachedPromise = (async () => {
            const { default: koffi } = await import('koffi');
            const user32 = koffi.load('user32.dll');
            const EnumWindowsProc = koffi.proto(
                '__stdcall',
                'EnumWindowsProc',
                'int32_t',
                ['void *', 'intptr_t']
            );
            const enumWindows = user32.func(
                '__stdcall', 'EnumWindows', 'int32_t', [koffi.pointer(EnumWindowsProc), 'intptr_t']
            );
            const isWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int32_t', ['void *']);
            const getWindowText = user32.func(
                'int __stdcall GetWindowTextW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)'
            );
            const getWindowThreadProcessId = user32.func(
                'uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)'
            );
            const getForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void *', []);
            const isWindow = user32.func('__stdcall', 'IsWindow', 'int32_t', ['void *']);
            const isIconic = user32.func('__stdcall', 'IsIconic', 'int32_t', ['void *']);
            const isZoomed = user32.func('__stdcall', 'IsZoomed', 'int32_t', ['void *']);
            const setForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'int32_t', ['void *']);
            const showWindow = user32.func('__stdcall', 'ShowWindow', 'int32_t', ['void *', 'int']);
            const postMessage = user32.func(
                '__stdcall', 'PostMessageW', 'int32_t', ['void *', 'uint32_t', 'uintptr_t', 'intptr_t']
            );

            return {
                enumerateHandles() {
                    const handles = [];
                    const callback = handle => {
                        handles.push(handle);
                        return 1;
                    };
                    if (!enumWindows(callback, 0) && handles.length > 0) {
                        throw new Error('EnumWindows failed');
                    }
                    return handles;
                },
                isWindowVisible,
                getWindowInfo(handle) {
                    const buffer = Buffer.alloc(maxWindowTitleLength * 2);
                    const titleLength = getWindowText(handle, buffer, maxWindowTitleLength);
                    const title = titleLength > 0
                        ? koffi.decode(buffer, 'char16_t', titleLength)
                        : '';
                    const processId = [0];
                    getWindowThreadProcessId(handle, processId);
                    return { title, pid: processId[0] };
                },
                getForegroundHandle: getForegroundWindow,
                focus(handle) {
                    if (isIconic(handle)) showWindow(handle, showNormal);
                    return setForegroundWindow(handle);
                },
                show(handle, command) {
                    const showCommand = {
                        maximize: showMaximized,
                        minimize: showMinimized,
                        restore: showNormal,
                    }[command];
                    if (showCommand === undefined) return false;
                    showWindow(handle, showCommand);
                    if (!isWindow(handle)) return false;
                    if (command === 'maximize') return Boolean(isZoomed(handle));
                    if (command === 'minimize') return Boolean(isIconic(handle));
                    return !isIconic(handle);
                },
                close(handle) {
                    return postMessage(handle, windowMessageClose, 0, 0);
                },
            };
        })();
        return cachedPromise;
    };
}

const loadNativeWindowsApi = getWindowsApiFactory();

function toWindowId(handle) {
    const numericHandle = typeof handle === 'bigint' ? handle : BigInt(handle);
    return `0x${numericHandle.toString(16)}`;
}

function validateTarget(value) {
    if (
        typeof value !== 'string' ||
        value.trim().length === 0 ||
        value.length > maxTargetLength ||
        /[\u0000-\u001f\u007f]/u.test(value)
    ) return null;
    return value.trim();
}

function toProcessNameMap(processes) {
    return new Map(processes.map(processInfo => [processInfo.pid, processInfo.name]));
}

export async function readWindowsSnapshot({
    platform = process.platform,
    windowsApi,
    listProcesses,
} = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'La consulta de ventanas solo está disponible en Windows.');
    }

    const processes = await listRunningProcesses({ platform, listProcesses });
    if (!processes.success) return processes;

    try {
        const api = windowsApi ?? await loadNativeWindowsApi();
        const processNames = toProcessNameMap(processes.processes);
        const windows = [];

        for (const handle of api.enumerateHandles()) {
            if (!api.isWindowVisible(handle)) continue;
            const info = api.getWindowInfo(handle);
            const title = typeof info?.title === 'string' ? info.title.trim() : '';
            const process = processNames.get(info?.pid);
            if (!title || !process || !Number.isSafeInteger(info.pid) || info.pid <= 0) continue;

            windows.push({
                id: toWindowId(handle),
                title,
                process,
                pid: info.pid,
                _handle: handle,
            });
        }
        return { success: true, windows, api };
    } catch {
        return failure('window_query_failed', 'No se pudieron consultar las ventanas de Windows.');
    }
}

function publicWindow(window) {
    if (!window) return null;
    return {
        id: window.id,
        title: window.title,
        process: window.process,
        pid: window.pid,
    };
}

export async function getActiveWindow(options = {}) {
    const snapshot = await readWindowsSnapshot(options);
    if (!snapshot.success) return snapshot;

    try {
        const handle = snapshot.api.getForegroundHandle();
        if (handle === null || handle === undefined || handle === 0 || handle === 0n) {
            return { success: true, window: null };
        }
        const active = snapshot.windows.find(window => window.id === toWindowId(handle));
        return { success: true, window: publicWindow(active) };
    } catch {
        return failure('window_query_failed', 'No se pudo identificar la ventana activa de Windows.');
    }
}

export async function listWindows(options = {}) {
    const snapshot = await readWindowsSnapshot(options);
    if (!snapshot.success) return snapshot;
    const windows = snapshot.windows.map(publicWindow);
    return { success: true, count: windows.length, windows };
}

function targetApplication(requestedName, catalog, environment = process.env) {
    const query = normalizeAppName(requestedName);
    const builtIn = Object.entries(windowsAppWhitelist)
        .find(([name]) => normalizeAppName(name) === query);
    if (builtIn) {
        const processNames = builtIn[1].map(item => path.win32.basename(item.executable).toLowerCase());
        if (processNames.length === 0) processNames.push(`${query.replace(/\s+/gu, '')}.exe`);
        return { kind: 'application', name: builtIn[0], processNames };
    }

    const apps = Array.isArray(catalog?.apps) ? catalog.apps : [];
    const aliasesFor = app => [app.name, ...(Array.isArray(app.aliases) ? app.aliases : [])];
    const byAlias = app => aliasesFor(app).some(alias => normalizeAppName(alias) === query);
    let matches = apps.filter(byAlias);
    if (matches.length === 0 && query) {
        matches = apps.filter(app => aliasesFor(app)
            .some(alias => normalizeAppName(alias).startsWith(`${query} `)));
    }
    if (matches.length > 1) return { kind: 'ambiguous_application' };
    if (
        matches.length === 1 &&
        typeof matches[0].path === 'string' &&
        isTrustedAppPath(matches[0].path, environment)
    ) {
        return {
            kind: 'application',
            name: matches[0].name,
            processNames: [path.win32.basename(matches[0].path).toLowerCase()],
        };
    }
    return null;
}

export function matchWindows(windows, target, catalog, environment = process.env) {
    const application = targetApplication(target, catalog, environment);
    if (application?.kind === 'ambiguous_application') {
        return { kind: 'ambiguous', matches: [] };
    }

    if (application) {
        const processNames = new Set(application.processNames);
        const matches = windows.filter(window => processNames.has(window.process.toLowerCase()));
        return { kind: 'application', app: application.name, matches };
    }

    const query = normalizeAppName(target);
    const matches = windows.filter(window => normalizeAppName(window.title).includes(query));
    return { kind: 'title', app: target, matches };
}

async function loadCatalogSafely(loadCatalog, catalogPath) {
    try {
        return await loadCatalog({ catalogPath });
    } catch {
        return { version: 1, apps: [] };
    }
}

export async function isAppRunning({
    args,
    platform = process.platform,
    listProcesses,
    loadCatalog = loadAppCatalog,
    catalogPath,
    environment = process.env,
} = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'is_app_running solo está disponible en Windows.');
    }
    const requested = validateTarget(args?.app);
    if (!requested) return failure('invalid_app', 'Indicá el nombre de una aplicación conocida.');

    const [catalog, processResult] = await Promise.all([
        loadCatalogSafely(loadCatalog, catalogPath),
        listRunningProcesses({ platform, listProcesses }),
    ]);
    if (!processResult.success) return processResult;

    const application = targetApplication(requested, catalog, environment);
    if (!application || application.kind === 'ambiguous_application') {
        return failure(
            application?.kind === 'ambiguous_application' ? 'ambiguous_app' : 'app_not_found',
            application?.kind === 'ambiguous_application'
                ? 'El nombre coincide con varias aplicaciones del catálogo.'
                : 'No se encontró esa aplicación en el catálogo ni en la lista conocida.'
        );
    }

    const processNames = new Set(application.processNames);
    const processes = processResult.processes.filter(processInfo =>
        processNames.has(processInfo.name.toLowerCase())
    );
    return {
        success: true,
        running: processes.length > 0,
        app: application.name,
        processes,
    };
}

async function findWindowTarget(args, options) {
    const requested = validateTarget(args?.target);
    if (!requested) return { error: failure('invalid_target', 'Indicá un nombre de aplicación o título de ventana.') };

    const snapshot = await readWindowsSnapshot(options);
    if (!snapshot.success) return { error: snapshot };
    const catalog = await loadCatalogSafely(options.loadCatalog ?? loadAppCatalog, options.catalogPath);
    const match = matchWindows(snapshot.windows, requested, catalog, options.environment);

    if (match.matches.length === 0) {
        return { error: failure('window_not_found', `No se encontró una ventana para «${requested}».`) };
    }
    if (match.matches.length > 1) {
        return {
            error: failure('ambiguous_window', 'Hay varias ventanas compatibles; especificá un título más preciso.', {
                matches: match.matches.map(publicWindow),
            }),
        };
    }
    return { window: match.matches[0], api: snapshot.api };
}

export async function controlWindow({
    args,
    action,
    platform = process.platform,
    windowsApi,
    listProcesses,
    loadCatalog,
    catalogPath,
    environment = process.env,
} = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'El control de ventanas solo está disponible en Windows.');
    }
    const found = await findWindowTarget(args, {
        platform, windowsApi, listProcesses, loadCatalog, catalogPath, environment,
    });
    if (found.error) return found.error;

    try {
        let succeeded;
        if (action === 'focus') succeeded = found.api.focus(found.window._handle);
        else if (action === 'close') succeeded = found.api.close(found.window._handle);
        else succeeded = found.api.show(found.window._handle, action);

        if (!succeeded) {
            return failure(
                action === 'focus' ? 'focus_denied' : 'window_action_failed',
                action === 'focus'
                    ? 'Windows no permitió poner esa ventana al frente.'
                    : 'Windows no pudo aplicar la acción solicitada a la ventana.'
            );
        }
        return {
            success: true,
            action: action === 'close' ? 'close_requested' : action,
            message: action === 'close' ? 'Se envió una solicitud de cierre normal.' : undefined,
            window: publicWindow(found.window),
        };
    } catch {
        return failure('window_action_failed', 'No se pudo aplicar la acción solicitada a la ventana.');
    }
}

export const getActiveWindowRegistration = { definition: getActiveWindowTool, execute: getActiveWindow };
export const listWindowsRegistration = { definition: listWindowsTool, execute: listWindows };
export const isAppRunningRegistration = { definition: isAppRunningTool, execute: isAppRunning };
export const focusWindowRegistration = {
    definition: focusWindowTool,
    execute: args => controlWindow({ ...args, action: 'focus' }),
};
export const maximizeWindowRegistration = {
    definition: maximizeWindowTool,
    execute: args => controlWindow({ ...args, action: 'maximize' }),
};
export const minimizeWindowRegistration = {
    definition: minimizeWindowTool,
    execute: args => controlWindow({ ...args, action: 'minimize' }),
};
export const restoreWindowRegistration = {
    definition: restoreWindowTool,
    execute: args => controlWindow({ ...args, action: 'restore' }),
};
export const closeWindowRegistration = {
    definition: closeWindowTool,
    execute: args => controlWindow({ ...args, action: 'close' }),
};
