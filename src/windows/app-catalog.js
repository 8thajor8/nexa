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

export function findAppInCatalog(catalog, requestedName) {
    const query = normalizeAppName(requestedName);

    if (!query) {
        return null;
    }

    const matches = catalog.apps.filter(app =>
        [app.name, ...(Array.isArray(app.aliases) ? app.aliases : [])]
            .some(alias => normalizeAppName(alias) === query)
    );

    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;

    const prefixMatches = catalog.apps.filter(app =>
        [app.name, ...(Array.isArray(app.aliases) ? app.aliases : [])]
            .some(alias => normalizeAppName(alias).startsWith(`${query} `))
    );

    return prefixMatches.length === 1 ? prefixMatches[0] : null;
}
