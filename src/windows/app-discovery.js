import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
    appCatalogPath,
    loadAppCatalog,
    normalizeAppName,
    saveAppCatalog,
} from './app-catalog.js';
import { resolveShortcutTarget } from './shortcut.js';
import { discoverAppxApps } from './appx-discovery.js';

const maxShortcutFiles = 2_000;
const maxFolderDepth = 8;
const maxShortcutSize = 1024 * 1024;

function identityForApp(app) {
    if (typeof app?.appUserModelId === 'string') return `appx:${app.appUserModelId.toLowerCase()}`;
    if (typeof app?.path === 'string') return `lnk:${path.win32.resolve(app.path).toLowerCase()}`;
    return null;
}

export function mergeDiscoveredApps(...sources) {
    const byIdentity = new Map();
    for (const apps of sources) {
        for (const app of apps ?? []) {
            const key = identityForApp(app);
            if (!key) continue;
            const existing = byIdentity.get(key);
            if (!existing) {
                const normalized = {
                    ...app,
                    aliases: [...new Set(Array.isArray(app.aliases) ? app.aliases : [])],
                };
                if (Array.isArray(app.processNames)) {
                    normalized.processNames = [...new Set(app.processNames)];
                }
                byIdentity.set(key, normalized);
                continue;
            }
            existing.aliases = [...new Set([
                ...existing.aliases,
                ...(Array.isArray(app.aliases) ? app.aliases : []),
                app.name,
                app.displayName,
            ].filter(Boolean))];
            existing.processNames = [...new Set([
                ...existing.processNames,
                ...(Array.isArray(app.processNames) ? app.processNames : []),
            ])];
        }
    }
    return [...byIdentity.values()].sort((left, right) =>
        (left.displayName ?? left.name).localeCompare(right.displayName ?? right.name)
    );
}

function getStartMenuDirectories(environment) {
    const programData = environment.ProgramData ?? 'C:\\ProgramData';
    const userAppData = environment.APPDATA;
    const directories = [
        path.win32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];

    if (userAppData) {
        directories.push(path.win32.join(
            userAppData,
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs'
        ));
    }

    return directories;
}

function isWithin(root, target) {
    const relative = path.win32.relative(root, target);
    return relative === '' || (
        relative !== '..' &&
        !relative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(relative)
    );
}

export function isTrustedAppPath(target, environment = process.env) {
    if (typeof target !== 'string' || !path.win32.isAbsolute(target)) {
        return false;
    }

    if (path.win32.extname(target).toLowerCase() !== '.exe') {
        return false;
    }

    const executableName = path.win32.basename(target).toLowerCase();
    const blockedExecutables = new Set([
        'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe',
        'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'reg.exe', 'schtasks.exe',
        'bash.exe', 'sh.exe', 'zsh.exe', 'fish.exe', 'wsl.exe', 'git-bash.exe',
        'python.exe', 'pythonw.exe', 'node.exe', 'bun.exe', 'deno.exe',
        'ruby.exe', 'perl.exe', 'php.exe', 'java.exe',
    ]);
    if (blockedExecutables.has(executableName)) {
        return false;
    }

    const trustedRoots = [
        environment.ProgramFiles,
        environment['ProgramFiles(x86)'],
        environment.LOCALAPPDATA
            ? path.win32.join(environment.LOCALAPPDATA, 'Programs')
            : null,
        environment.ProgramData,
    ].filter(Boolean);

    return trustedRoots.some(root => isWithin(path.win32.resolve(root), path.win32.resolve(target)));
}

function uniqueAliases(values) {
    return [...new Set(values.map(normalizeAppName).filter(Boolean))];
}

async function collectShortcuts(directory, {
    fileSystem,
    depth,
    parentAliases,
    onShortcut,
    counter,
}) {
    if (depth > maxFolderDepth || counter.value >= maxShortcutFiles) return;

    let entries;
    try {
        entries = await fileSystem.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') {
            return;
        }
        throw error;
    }

    for (const entry of entries) {
        if (counter.value >= maxShortcutFiles) return;
        const entryPath = path.win32.join(directory, entry.name);

        if (entry.isDirectory() && !entry.isSymbolicLink()) {
            await collectShortcuts(entryPath, {
                fileSystem,
                depth: depth + 1,
                parentAliases: [...parentAliases, path.win32.basename(entry.name)],
                onShortcut,
                counter,
            });
            continue;
        }

        if (!entry.isFile() || path.win32.extname(entry.name).toLowerCase() !== '.lnk') {
            continue;
        }

        counter.value += 1;
        await onShortcut(entryPath, entry.name, parentAliases);
    }
}

export async function discoverApps({
    platform = process.platform,
    environment = process.env,
    directories = getStartMenuDirectories(environment),
    fileSystem = { readdir, readFile, stat: lstat },
    catalogPath = appCatalogPath,
    loadCatalog = loadAppCatalog,
    saveCatalog = saveAppCatalog,
    readAppxApps = discoverAppxApps,
} = {}) {
    if (platform !== 'win32') {
        return {
            success: false,
            error: {
                code: 'unsupported_platform',
                message: 'discover_apps solo está disponible en Windows.',
            },
        };
    }

    try {
        const previousCatalog = await loadCatalog({ catalogPath });
        const discoveredByPath = new Map();
        const counter = { value: 0 };
        const commonStartMenu = path.win32.resolve(
            environment.ProgramData ?? 'C:\\ProgramData',
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs'
        ).toLowerCase();

        for (const directory of directories) {
            const source = path.win32.resolve(directory).toLowerCase() === commonStartMenu
                ? 'common_start_menu'
                : 'user_start_menu';

            await collectShortcuts(directory, {
                fileSystem,
                depth: 0,
                parentAliases: [],
                counter,
                onShortcut: async (shortcutPath, filename, parentAliases) => {
                    let shortcutInfo;
                    try {
                        shortcutInfo = await fileSystem.stat(shortcutPath);
                    } catch {
                        return;
                    }
                    if (!shortcutInfo.isFile() || shortcutInfo.size > maxShortcutSize) return;

                    let shortcutContents;
                    try {
                        shortcutContents = await fileSystem.readFile(shortcutPath);
                    } catch {
                        return;
                    }

                    const target = resolveShortcutTarget(shortcutContents, environment);
                    if (!target || !isTrustedAppPath(target, environment)) return;

                    let targetInfo;
                    try {
                        targetInfo = await fileSystem.stat(target);
                    } catch {
                        return;
                    }
                    if (!targetInfo.isFile()) return;

                    const name = path.win32.basename(filename, path.win32.extname(filename));
                    const aliases = uniqueAliases([name, ...parentAliases]);
                    const key = path.win32.resolve(target).toLowerCase();
                    const existing = discoveredByPath.get(key);

                    if (existing) {
                        existing.aliases = uniqueAliases([...existing.aliases, ...aliases]);
                    } else {
                        discoveredByPath.set(key, {
                            name,
                            aliases,
                            path: target,
                            source,
                        });
                    }
                },
            });
        }

        const shortcutApps = [...discoveredByPath.values()];
        const appxResult = await readAppxApps({ platform, environment });
        // If AppX inventory temporarily fails, retain the last known modern apps.
        // A successful empty inventory is meaningful and removes stale entries.
        const appxApps = appxResult.success
            ? appxResult.apps
            : previousCatalog.apps.filter(app => app.source === 'appx');
        const apps = mergeDiscoveredApps(shortcutApps, appxApps);
        const oldIdentities = new Set(previousCatalog.apps.map(identityForApp).filter(Boolean));
        const newCount = apps.filter(app => !oldIdentities.has(identityForApp(app))).length;
        await saveCatalog(apps, { catalogPath });

        return {
            success: true,
            count: apps.length,
            newCount,
            updated: true,
        };
    } catch {
        return {
            success: false,
            error: {
                code: 'app_discovery_failed',
                message: 'No se pudo actualizar el catálogo de aplicaciones.',
            },
        };
    }
}

export const discoverAppsTool = {
    type: 'function',
    name: 'discover_apps',
    description: 'Actualiza el catálogo local con aplicaciones de accesos directos del menú Inicio.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
    },
    strict: true,
};

export const discoverAppsRegistration = {
    definition: discoverAppsTool,
    execute: discoverApps,
};
