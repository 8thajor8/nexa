import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const maxDirectoryEntries = 200;
const maxReadableFileBytes = 1024 * 1024;
const maxPathLength = 2048;

function getProfilePath(environment) {
    if (environment.USERPROFILE) return environment.USERPROFILE;
    if (environment.HOMEDRIVE && environment.HOMEPATH) {
        return path.win32.join(environment.HOMEDRIVE, environment.HOMEPATH);
    }
    return null;
}

export function getAllowedRoots(environment = process.env) {
    const profile = getProfilePath(environment);
    if (!profile) return [];

    const oneDriveRoots = [
        environment.OneDriveCommercial,
        environment.OneDriveConsumer,
        environment.OneDrive,
    ].filter(Boolean);

    return ['Desktop', 'Documents', 'Downloads'].flatMap(name => [
        { name: name.toLowerCase(), path: path.win32.join(profile, name) },
        ...oneDriveRoots.map(oneDrive => ({
            name: name.toLowerCase(),
            path: path.win32.join(oneDrive, name),
        })),
    ]);
}

export function isPathWithinRoot(targetPath, rootPath) {
    const relative = path.win32.relative(
        path.win32.resolve(rootPath),
        path.win32.resolve(targetPath)
    );
    const normalizedRelative = relative.toLowerCase();

    return normalizedRelative === '' || (
        normalizedRelative !== '..' &&
        !normalizedRelative.startsWith(`..${path.win32.sep}`) &&
        !path.win32.isAbsolute(relative)
    );
}

function containsTraversalSegment(value) {
    return value.split(/[\\/]+/u).includes('..');
}

function invalidPathResult(code = 'path_not_allowed') {
    const messages = {
        path_not_found: 'La ruta solicitada no existe.',
        unsupported_platform: 'Estas herramientas de archivos solo están disponibles en Windows.',
        path_not_allowed: 'La ruta está fuera de las carpetas permitidas.',
    };
    return {
        success: false,
        error: {
            code,
            message: messages[code] ?? messages.path_not_allowed,
        },
    };
}

export async function resolveAllowedPath(value, {
    environment = process.env,
    platform = process.platform,
    fileSystem = { realpath },
} = {}) {
    if (platform !== 'win32') return invalidPathResult('unsupported_platform');

    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > maxPathLength ||
        /[\u0000-\u001f\u007f]/u.test(value) ||
        containsTraversalSegment(value)
    ) {
        return invalidPathResult();
    }

    const roots = getAllowedRoots(environment);
    const trimmedPath = value.trim();
    if (!trimmedPath || trimmedPath.startsWith('\\\\') || trimmedPath.startsWith('//')) {
        return invalidPathResult();
    }

    const firstPart = trimmedPath.split(/[\\/]/u, 1)[0].toLowerCase();
    const rootAliases = roots.filter(root => root.name === firstPart);
    let candidates;

    if (rootAliases.length > 0 && (trimmedPath.length === firstPart.length || /^[\\/]/u.test(trimmedPath[firstPart.length]))) {
        const remainder = trimmedPath.slice(firstPart.length).replace(/^[\\/]+/u, '');
        candidates = rootAliases.map(rootAlias => ({
            name: rootAlias.name,
            path: remainder
                ? path.win32.resolve(rootAlias.path, remainder)
                : path.win32.resolve(rootAlias.path),
            rootPath: rootAlias.path,
        }));
    } else {
        if (!/^[a-z]:[\\/]/iu.test(trimmedPath)) return invalidPathResult();
        const absolutePath = path.win32.resolve(trimmedPath);
        candidates = roots
            .filter(root => isPathWithinRoot(absolutePath, root.path))
            .map(root => ({ ...root, path: absolutePath, rootPath: root.path }));
    }

    let pathWasMissing = false;
    for (const candidate of candidates) {
        if (!isPathWithinRoot(candidate.path, candidate.rootPath)) continue;

        try {
            const [canonicalRoot, canonicalPath] = await Promise.all([
                fileSystem.realpath(candidate.rootPath),
                fileSystem.realpath(candidate.path),
            ]);

            if (isPathWithinRoot(canonicalPath, canonicalRoot)) {
                return {
                    success: true,
                    path: canonicalPath,
                    root: candidate.name,
                };
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                pathWasMissing = true;
                continue;
            }
            if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
        }
    }

    return invalidPathResult(pathWasMissing ? 'path_not_found' : 'path_not_allowed');
}

function failed(code, message) {
    return { success: false, error: { code, message } };
}

function getPathTool(name, description) {
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    minLength: 1,
                    maxLength: maxPathLength,
                    description: 'Ruta absoluta permitida o ruta relativa a Desktop, Documents o Downloads.',
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        strict: true,
    };
}

export const listDirectoryTool = getPathTool(
    'list_directory',
    'Lista archivos y carpetas de Desktop, Documents o Downloads.'
);

export const readFileTool = getPathTool(
    'read_file',
    'Lee un archivo de texto UTF-8 de hasta 1 MiB dentro de Desktop, Documents o Downloads.'
);

export async function listDirectory({
    args,
    platform = process.platform,
    environment = process.env,
    fileSystem = { realpath, readdir, lstat },
} = {}) {
    const resolved = await resolveAllowedPath(args?.path, { platform, environment, fileSystem });
    if (!resolved.success) return resolved;

    try {
        const directoryInfo = await fileSystem.lstat(resolved.path);
        if (!directoryInfo.isDirectory()) {
            return failed('not_a_directory', 'La ruta solicitada no es una carpeta.');
        }

        const entries = await fileSystem.readdir(resolved.path, { withFileTypes: true });
        const safeEntries = entries.filter(entry =>
            !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory())
        );
        const resultEntries = [];

        for (const entry of safeEntries.slice(0, maxDirectoryEntries)) {
            const entryPath = path.win32.join(resolved.path, entry.name);
            let entryInfo;
            try {
                entryInfo = await fileSystem.lstat(entryPath);
            } catch {
                continue;
            }

            if (entryInfo.isSymbolicLink() || (!entryInfo.isFile() && !entryInfo.isDirectory())) continue;

            resultEntries.push({
                name: entry.name,
                type: entryInfo.isDirectory() ? 'directory' : 'file',
                size: entryInfo.isFile() ? entryInfo.size : null,
                modifiedAt: entryInfo.mtime.toISOString(),
            });
        }

        return {
            success: true,
            path: resolved.path,
            count: resultEntries.length,
            truncated: safeEntries.length > maxDirectoryEntries,
            entries: resultEntries,
        };
    } catch (error) {
        if (error.code === 'ENOENT') return failed('path_not_found', 'La carpeta no existe.');
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            return failed('access_denied', 'Windows no permite consultar esa carpeta.');
        }
        return failed('directory_read_failed', 'No se pudo leer el contenido de la carpeta.');
    }
}

export async function readTextFile({
    args,
    platform = process.platform,
    environment = process.env,
    fileSystem = { realpath, lstat, open },
} = {}) {
    const resolved = await resolveAllowedPath(args?.path, { platform, environment, fileSystem });
    if (!resolved.success) return resolved;

    try {
        const fileInfo = await fileSystem.lstat(resolved.path);
        if (!fileInfo.isFile()) {
            return failed('not_a_file', 'La ruta solicitada no es un archivo.');
        }
        if (fileInfo.size > maxReadableFileBytes) {
            return failed('file_too_large', 'El archivo supera el límite de lectura de 1 MiB.');
        }

        const fileHandle = await fileSystem.open(resolved.path, 'r');
        let content;
        try {
            const fileInfo = await fileHandle.stat();
            if (!fileInfo.isFile()) {
                return failed('not_a_file', 'La ruta solicitada no es un archivo.');
            }
            if (fileInfo.size > maxReadableFileBytes) {
                return failed('file_too_large', 'El archivo supera el límite de lectura de 1 MiB.');
            }

            const buffer = Buffer.alloc(maxReadableFileBytes + 1);
            const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > maxReadableFileBytes) {
                return failed('file_too_large', 'El archivo supera el límite de lectura de 1 MiB.');
            }
            content = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
            await fileHandle.close();
        }

        return {
            success: true,
            path: resolved.path,
            content,
        };
    } catch (error) {
        if (error.code === 'ENOENT') return failed('path_not_found', 'El archivo no existe.');
        if (error.code === 'EACCES' || error.code === 'EPERM') {
            return failed('access_denied', 'Windows no permite leer ese archivo.');
        }
        return failed('file_read_failed', 'No se pudo leer el archivo como texto UTF-8.');
    }
}

export const listDirectoryRegistration = {
    definition: listDirectoryTool,
    execute: listDirectory,
};

export const readFileRegistration = {
    definition: readFileTool,
    execute: readTextFile,
};
