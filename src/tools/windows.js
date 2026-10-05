import { spawn } from 'node:child_process';
import path from 'node:path';
import {
    findAppInCatalog,
    loadAppCatalog,
    normalizeAppName,
} from '../windows/app-catalog.js';
import { isTrustedAppPath } from '../windows/app-discovery.js';
import { listRunningProcesses } from '../windows/processes.js';
import { windowsAppWhitelist } from '../windows/app-whitelist.js';

const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
export { windowsAppWhitelist };

const windowsPath = (root, ...parts) => root
    ? path.win32.join(root, ...parts)
    : null;

const maxListedProcesses = 100;

export const openAppTool = {
    type: 'function',
    name: 'open_app',
    description: 'Abre una aplicación de Windows conocida y permitida.',
    parameters: {
        type: 'object',
        properties: {
            app: {
                type: 'string',
                minLength: 1,
                maxLength: 120,
                description: 'Nombre lógico de una aplicación descubierta o incluida en la whitelist.',
            },
        },
        required: ['app'],
        additionalProperties: false,
    },
    strict: true,
};

export const openUrlTool = {
    type: 'function',
    name: 'open_url',
    description: 'Abre una URL web http o https en el navegador predeterminado de Windows.',
    parameters: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'URL absoluta http:// o https:// que se quiere abrir.',
            },
        },
        required: ['url'],
        additionalProperties: false,
    },
    strict: true,
};

export const getOpenAppsTool = {
    type: 'function',
    name: 'get_open_apps',
    description: 'Lista hasta 100 procesos que están ejecutándose en Windows.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
    },
    strict: true,
};

function failure(code, message) {
    return {
        success: false,
        error: { code, message },
    };
}

export function launchDetachedProcess(executable, args = [], spawnProcess = spawn) {
    return new Promise((resolve, reject) => {
        let child;

        try {
            child = spawnProcess(executable, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                shell: false,
            });
        } catch (error) {
            reject(error);
            return;
        }

        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

export async function openApp({
    args,
    launchProcess = launchDetachedProcess,
    platform = process.platform,
    environment = process.env,
    catalogPath,
    loadCatalog = loadAppCatalog,
} = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'open_app solo está disponible en Windows.');
    }

    const requestedName = typeof args?.app === 'string' ? args.app.trim() : '';
    const normalizedName = normalizeAppName(requestedName);

    if (!normalizedName || /[\\/:]/u.test(requestedName)) {
        return failure('app_not_found', 'No se encontró esa aplicación en el catálogo local.');
    }

    let appTargets = [];
    let appName = normalizedName;

    try {
        const catalog = await loadCatalog({ catalogPath });
        const discoveredApp = findAppInCatalog(catalog, requestedName);

        if (discoveredApp && isTrustedAppPath(discoveredApp.path, environment)) {
            appTargets = [{ executable: discoveredApp.path, args: [] }];
            appName = discoveredApp.name;
        }
    } catch {
        // Un catálogo que no se puede leer no impide usar la whitelist explícita.
    }

    if (appTargets.length === 0) {
        appTargets = windowsAppWhitelist[normalizedName]?.map(item => ({
            executable: item.executable,
            args: [...item.args],
        })) ?? [];
    }

    if (appTargets.length === 0) {
        return failure('app_not_found', 'No se encontró esa aplicación en el catálogo local.');
    }

    for (const appTarget of appTargets) {
        try {
            await launchProcess(appTarget.executable, [...appTarget.args]);
            return {
                success: true,
                app: appName,
                message: `Se inició ${appName}.`,
            };
        } catch {
            // Probar la siguiente ruta permitida para la misma aplicación.
        }
    }

    return failure(
        'app_launch_failed',
        `No se pudo iniciar ${appName}. Revisá que esté instalada.`
    );
}

function validateWebUrl(value) {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > 2048 ||
        /[\s\\\u0000-\u001F\u007F]/u.test(value) ||
        !/^https?:\/\//i.test(value)
    ) {
        return null;
    }

    try {
        const url = new URL(value);

        if (
            !['http:', 'https:'].includes(url.protocol) ||
            !url.hostname ||
            url.username ||
            url.password
        ) {
            return null;
        }

        return url.href;
    } catch {
        return null;
    }
}

export async function openUrl({ args, launchProcess = launchDetachedProcess, platform = process.platform } = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'open_url solo está disponible en Windows.');
    }

    const url = validateWebUrl(args?.url);

    if (!url) {
        return failure(
            'invalid_url',
            'La dirección debe ser una URL absoluta http:// o https:// válida.'
        );
    }

    try {
        await launchProcess(
            windowsPath(systemRoot, 'System32', 'rundll32.exe'),
            ['url.dll,FileProtocolHandler', url]
        );
        return {
            success: true,
            url,
            message: 'Se abrió la URL en el navegador predeterminado.',
        };
    } catch {
        return failure('url_open_failed', 'Windows no pudo abrir la URL solicitada.');
    }
}

export async function getOpenApps({ listProcesses, platform = process.platform } = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'get_open_apps solo está disponible en Windows.');
    }
    const result = await listRunningProcesses({ listProcesses, platform });
    if (!result.success) return result;

    const processes = result.processes.slice(0, maxListedProcesses);
    return {
        success: true,
        count: processes.length,
        totalCount: result.processes.length,
        truncated: result.processes.length > maxListedProcesses,
        processes,
    };
}

export const openAppRegistration = {
    definition: openAppTool,
    execute: openApp,
};

export const openUrlRegistration = {
    definition: openUrlTool,
    execute: openUrl,
};

export const getOpenAppsRegistration = {
    definition: getOpenAppsTool,
    execute: getOpenApps,
};
