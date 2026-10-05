import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
const programFiles = process.env.ProgramFiles;
const programFilesX86 = process.env['ProgramFiles(x86)'];
const localAppData = process.env.LOCALAPPDATA;
const roamingAppData = process.env.APPDATA;

const windowsPath = (root, ...parts) => root
    ? path.win32.join(root, ...parts)
    : null;

const target = (executable, args = []) => Object.freeze({
    executable,
    args: Object.freeze(args),
});

const fixedTargets = (...executables) => Object.freeze(
    executables
        .filter(Boolean)
        .map(executable => target(executable))
);

export const windowsAppWhitelist = Object.freeze({
    chrome: fixedTargets(
        windowsPath(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        windowsPath(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        windowsPath(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ),
    edge: fixedTargets(
        windowsPath(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        windowsPath(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ),
    notepad: fixedTargets(windowsPath(systemRoot, 'System32', 'notepad.exe')),
    calculator: fixedTargets(windowsPath(systemRoot, 'System32', 'calc.exe')),
    explorer: fixedTargets(windowsPath(systemRoot, 'explorer.exe')),
    spotify: fixedTargets(
        windowsPath(localAppData, 'Programs', 'Spotify', 'Spotify.exe'),
        windowsPath(roamingAppData, 'Spotify', 'Spotify.exe'),
        windowsPath(programFiles, 'Spotify', 'Spotify.exe')
    ),
    discord: Object.freeze([
        ...(windowsPath(localAppData, 'Discord', 'Update.exe')
            ? [target(
                windowsPath(localAppData, 'Discord', 'Update.exe'),
                ['--processStart', 'Discord.exe']
            )]
            : []),
    ]),
});

const appNames = Object.keys(windowsAppWhitelist);
const maxListedProcesses = 100;
const processListTimeoutMs = 5_000;
const processListMaxBuffer = 256 * 1024;

export const openAppTool = {
    type: 'function',
    name: 'open_app',
    description: 'Abre una aplicación de Windows conocida y permitida.',
    parameters: {
        type: 'object',
        properties: {
            app: {
                type: 'string',
                enum: appNames,
                description: 'Aplicación permitida que se quiere abrir.',
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

export async function openApp({ args, launchProcess = launchDetachedProcess, platform = process.platform } = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'open_app solo está disponible en Windows.');
    }

    const app = typeof args?.app === 'string' ? args.app.trim().toLowerCase() : '';
    const appTargets = windowsAppWhitelist[app];

    if (!appTargets) {
        return failure(
            'app_not_allowed',
            `La aplicación solicitada no está en la whitelist: ${args?.app ?? ''}.`
        );
    }

    for (const appTarget of appTargets) {
        try {
            await launchProcess(appTarget.executable, [...appTarget.args]);
            return {
                success: true,
                app,
                message: `Se inició ${app}.`,
            };
        } catch {
            // Probar la siguiente ruta permitida para la misma aplicación.
        }
    }

    return failure(
        'app_launch_failed',
        `No se pudo iniciar ${app}. Revisá que esté instalada.`
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

function runTaskList() {
    return new Promise((resolve, reject) => {
        execFile(
            windowsPath(systemRoot, 'System32', 'tasklist.exe'),
            ['/FO', 'CSV', '/NH'],
            {
                encoding: 'utf8',
                timeout: processListTimeoutMs,
                maxBuffer: processListMaxBuffer,
                windowsHide: true,
                shell: false,
            },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve(stdout);
            }
        );
    });
}

function parseCsvRow(line) {
    const fields = [];
    let field = '';
    let insideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];

        if (character === '"') {
            if (insideQuotes && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (character === ',' && !insideQuotes) {
            fields.push(field);
            field = '';
        } else {
            field += character;
        }
    }

    fields.push(field);
    return fields;
}

function parseTaskList(output) {
    return output
        .split(/\r?\n/u)
        .filter(line => line.trim())
        .map(parseCsvRow)
        .map(([name, rawPid]) => ({
            name: name?.replace(/^\uFEFF/u, ''),
            pid: Number(rawPid),
        }))
        .filter(processInfo =>
            typeof processInfo.name === 'string' &&
            processInfo.name.length > 0 &&
            Number.isSafeInteger(processInfo.pid) &&
            processInfo.pid > 0
        );
}

export async function getOpenApps({ listProcesses = runTaskList, platform = process.platform } = {}) {
    if (platform !== 'win32') {
        return failure('unsupported_platform', 'get_open_apps solo está disponible en Windows.');
    }

    try {
        const allProcesses = parseTaskList(await listProcesses());
        const processes = allProcesses.slice(0, maxListedProcesses);

        return {
            success: true,
            count: processes.length,
            totalCount: allProcesses.length,
            truncated: allProcesses.length > maxListedProcesses,
            processes,
        };
    } catch {
        return failure(
            'process_list_failed',
            'No se pudieron consultar los procesos de Windows.'
        );
    }
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
