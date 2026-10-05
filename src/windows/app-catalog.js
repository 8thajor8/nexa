import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const appCatalogPath = path.join(projectRoot, 'data', 'apps.json');

function emptyCatalog() {
    return { version: 1, updatedAt: null, apps: [] };
}

export async function loadAppCatalog({ catalogPath = appCatalogPath, read = readFile } = {}) {
    try {
        const contents = await read(catalogPath, 'utf8');
        const catalog = JSON.parse(contents);

        if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.apps)) {
            throw new Error('El catálogo local de aplicaciones no tiene un formato válido.');
        }

        return catalog;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return emptyCatalog();
        }

        throw error;
    }
}

export async function saveAppCatalog(apps, {
    catalogPath = appCatalogPath,
    makeDirectory = mkdir,
    write = writeFile,
    move = rename,
} = {}) {
    const catalog = {
        version: 1,
        updatedAt: new Date().toISOString(),
        apps,
    };
    const temporaryPath = `${catalogPath}.tmp`;

    await makeDirectory(path.dirname(catalogPath), { recursive: true });
    await write(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    await move(temporaryPath, catalogPath);

    return catalog;
}

export function normalizeAppName(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, ' ')
        .trim()
        .replace(/\s+app$/u, '');
}

export function resolveAppInCatalog(catalog, requestedName) {
    const query = normalizeAppName(requestedName);

    if (!query) {
        return { status: 'not_found', app: null, matches: [] };
    }

    const apps = Array.isArray(catalog?.apps) ? catalog.apps : [];
    const namesFor = app => [app.name, app.displayName, ...(Array.isArray(app.aliases) ? app.aliases : [])];
    const uniqueApps = matches => [...new Map(matches.map(app => [app, app])).values()];
    const matches = uniqueApps(apps.filter(app =>
        namesFor(app)
            .some(alias => normalizeAppName(alias) === query)
    ));

    if (matches.length === 1) return { status: 'found', app: matches[0], matches };
    if (matches.length > 1) return { status: 'ambiguous', app: null, matches };

    const prefixMatches = uniqueApps(apps.filter(app =>
        namesFor(app)
            .some(alias => normalizeAppName(alias).startsWith(query))
    ));

    if (prefixMatches.length === 1) {
        return { status: 'found', app: prefixMatches[0], matches: prefixMatches };
    }
    return {
        status: prefixMatches.length > 1 ? 'ambiguous' : 'not_found',
        app: null,
        matches: prefixMatches,
    };
}

export function findAppInCatalog(catalog, requestedName) {
    const result = resolveAppInCatalog(catalog, requestedName);
    return result.status === 'found' ? result.app : null;
}
