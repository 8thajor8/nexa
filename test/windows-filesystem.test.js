import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    listDirectory,
    readTextFile,
    resolveAllowedPath,
} from '../src/windows/filesystem.js';

const environment = { USERPROFILE: 'C:\\Users\\jor' };
const desktop = 'C:\\Users\\jor\\Desktop';
const notes = path.win32.join(desktop, 'notes.txt');
const folder = path.win32.join(desktop, 'folder');
const sample = Buffer.from('hola Nexa', 'utf8');

function stat({ type, size = 0, symlink = false } = {}) {
    return {
        size,
        mtime: new Date('2026-01-02T03:04:05.000Z'),
        isDirectory: () => type === 'directory',
        isFile: () => type === 'file',
        isSymbolicLink: () => symlink,
    };
}

function makeFileSystem({ files = new Map([[notes, sample]]), directories = new Set([desktop, folder]), aliases = new Map() } = {}) {
    const canonical = value => aliases.get(path.win32.resolve(value).toLowerCase()) ?? path.win32.resolve(value);
    const entries = new Map([
        [desktop, [
            { name: 'notes.txt', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
            { name: 'folder', isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false },
            { name: 'outside-link', isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true },
        ]],
    ]);
    const symlinkPath = path.win32.join(desktop, 'outside-link');

    return {
        realpath: async value => {
            const resolved = path.win32.resolve(value);
            if (!directories.has(resolved) && !files.has(resolved) && resolved.toLowerCase() !== symlinkPath.toLowerCase()) {
                const error = new Error('missing');
                error.code = 'ENOENT';
                throw error;
            }
            return canonical(resolved);
        },
        lstat: async value => {
            const resolved = path.win32.resolve(value);
            if (directories.has(resolved)) return stat({ type: 'directory' });
            if (files.has(resolved)) return stat({ type: 'file', size: files.get(resolved).length });
            if (resolved.toLowerCase() === path.win32.join(desktop, 'outside-link').toLowerCase()) {
                return stat({ type: 'file', symlink: true });
            }
            const error = new Error('missing');
            error.code = 'ENOENT';
            throw error;
        },
        readdir: async value => entries.get(path.win32.resolve(value)) ?? [],
        open: async value => {
            const file = files.get(path.win32.resolve(value));
            if (!file) {
                const error = new Error('missing');
                error.code = 'ENOENT';
                throw error;
            }
            return {
                stat: async () => stat({ type: 'file', size: file.length }),
                read: async (buffer, offset, length) => {
                    const bytesRead = Math.min(length, file.length);
                    file.copy(buffer, offset, 0, bytesRead);
                    return { bytesRead };
                },
                close: async () => {},
            };
        },
    };
}

test('filesystem tools resolve an allowed root and reject an outside root', async () => {
    const fileSystem = makeFileSystem();
    const allowed = await resolveAllowedPath('Desktop\\notes.txt', {
        platform: 'win32', environment, fileSystem,
    });
    assert.equal(allowed.success, true);
    assert.equal(allowed.path, notes);

    const outside = await resolveAllowedPath('C:\\Users\\jor\\Desktop2\\notes.txt', {
        platform: 'win32', environment, fileSystem,
    });
    assert.equal(outside.success, false);
    assert.equal(outside.error.code, 'path_not_allowed');
});

test('filesystem tools reject traversal and symlink escapes', async () => {
    const fileSystem = makeFileSystem({
        aliases: new Map([[path.win32.join(desktop, 'outside-link').toLowerCase(), 'C:\\Windows\\win.ini']]),
    });
    const traversal = await resolveAllowedPath('Desktop\\..\\secret.txt', {
        platform: 'win32', environment, fileSystem,
    });
    assert.equal(traversal.error.code, 'path_not_allowed');

    const link = await resolveAllowedPath('Desktop\\outside-link', {
        platform: 'win32', environment, fileSystem,
    });
    assert.equal(link.error.code, 'path_not_allowed');
});

test('filesystem tools report missing directories and files', async () => {
    const fileSystem = makeFileSystem();
    assert.equal((await listDirectory({ args: { path: 'Desktop\\missing' }, platform: 'win32', environment, fileSystem })).error.code, 'path_not_found');
    assert.equal((await readTextFile({ args: { path: 'Desktop\\missing.txt' }, platform: 'win32', environment, fileSystem })).error.code, 'path_not_found');
});

test('list_directory returns bounded structured entries and skips symlinks', async () => {
    const result = await listDirectory({
        args: { path: 'Desktop' }, platform: 'win32', environment, fileSystem: makeFileSystem(),
    });
    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.entries.map(entry => entry.name), ['notes.txt', 'folder']);
    assert.equal(result.entries[0].type, 'file');
    assert.equal(result.entries[1].type, 'directory');
});

test('read_file reads UTF-8 text, rejects directories and caps content at 1 MiB', async () => {
    const fileSystem = makeFileSystem();
    const result = await readTextFile({
        args: { path: 'Desktop\\notes.txt' }, platform: 'win32', environment, fileSystem,
    });
    assert.equal(result.success, true);
    assert.equal(result.content, 'hola Nexa');

    const directory = await readTextFile({
        args: { path: 'Desktop\\folder' }, platform: 'win32', environment, fileSystem,
    });
    assert.equal(directory.error.code, 'not_a_file');

    const largeContents = Buffer.alloc(1024 * 1024 + 1);
    const largePath = path.win32.join(desktop, 'large.txt');
    const largeFileSystem = makeFileSystem({ files: new Map([[largePath, largeContents]]) });
    const large = await readTextFile({
        args: { path: 'Desktop\\large.txt' }, platform: 'win32', environment, fileSystem: largeFileSystem,
    });
    assert.equal(large.error.code, 'file_too_large');
});
