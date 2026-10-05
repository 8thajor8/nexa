import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const audioFileName = /^audio_[a-f0-9]{24}\.wav$/u;

function isInside(directory, target) {
    const relative = path.relative(path.resolve(directory), path.resolve(target));
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function isSafeDirectory(directory) {
    try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) return false;
        const resolved = path.resolve(await realpath(directory));
        const expected = path.resolve(directory);
        return process.platform === 'win32'
            ? resolved.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
            : resolved === expected;
    } catch { return false; }
}

export function createAudioStore({ temporaryDirectory, persistentDirectory, maxTemporaryAgeMs }) {
    const references = new Map();
    let initialized;
    let registryWrite = Promise.resolve();
    const registryPath = path.join(persistentDirectory, 'audio-registry.json');

    async function writePersistentRegistry() {
        registryWrite = registryWrite.catch(() => {}).then(async () => {
            const ids = [...references.values()].filter(item => !item.temporary).map(item => item.audioId).sort();
            const temporaryRegistry = path.join(persistentDirectory, `.registry-${randomBytes(8).toString('hex')}.tmp`);
            await writeFile(temporaryRegistry, JSON.stringify({ version: 1, audioIds: ids }), { flag: 'wx', mode: 0o600 });
            try { await rename(temporaryRegistry, registryPath); }
            catch (error) {
                await rm(temporaryRegistry, { force: true }).catch(() => {});
                throw error;
            }
        });
        return registryWrite;
    }

    async function loadPersistentRegistry() {
        try {
            if (!await isSafeDirectory(persistentDirectory)) return;
            const info = await lstat(registryPath);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) return;
            const registry = JSON.parse(await readFile(registryPath, 'utf8'));
            if (registry?.version !== 1 || !Array.isArray(registry.audioIds)) return;
            for (const audioId of registry.audioIds.slice(0, 10_000)) {
                if (typeof audioId !== 'string' || !/^audio_[a-f0-9]{24}$/u.test(audioId)) continue;
                const filePath = path.resolve(persistentDirectory, `${audioId}.wav`);
                if (!isInside(persistentDirectory, filePath)) continue;
                try {
                    const file = await lstat(filePath);
                    if (file.isFile() && !file.isSymbolicLink()) references.set(audioId, { audioId, filePath, temporary: false, format: 'wav' });
                } catch { /* Missing or unreadable entries are ignored. */ }
            }
        } catch { /* A missing or malformed local index does not expose a path or secret. */ }
    }

    async function cleanupOldTemporaryAudio(now = Date.now()) {
        const root = path.resolve(temporaryDirectory);
        if (!await isSafeDirectory(root)) {
            try { await lstat(root); return { success: false, removed: 0 }; }
            catch (error) {
                if (error.code === 'ENOENT') return { success: true, removed: 0 };
                return { success: false, removed: 0 };
            }
        }
        let entries;
        try { entries = await readdir(root, { withFileTypes: true }); }
        catch (error) {
            if (error.code === 'ENOENT') return { success: true, removed: 0 };
            return { success: false, removed: 0 };
        }
        let removed = 0;
        for (const entry of entries) {
            if (!entry.isFile() || !audioFileName.test(entry.name)) continue;
            const filePath = path.resolve(root, entry.name);
            if (!isInside(root, filePath)) continue;
            try {
                const info = await lstat(filePath);
                if (!info.isFile() || now - info.mtimeMs < maxTemporaryAgeMs) continue;
                await rm(filePath);
                removed++;
            } catch {
                // A stale temp file that cannot be inspected is left alone.
            }
        }
        return { success: true, removed };
    }

    async function initialize() {
        if (!initialized) {
            initialized = (async () => {
                await mkdir(temporaryDirectory, { recursive: true });
                if (!await isSafeDirectory(temporaryDirectory)) throw new Error('unsafe_audio_directory');
                await mkdir(persistentDirectory, { recursive: true });
                if (!await isSafeDirectory(persistentDirectory)) throw new Error('unsafe_audio_directory');
                await cleanupOldTemporaryAudio();
                await loadPersistentRegistry();
            })().catch(error => {
                initialized = undefined;
                throw error;
            });
        }
        return initialized;
    }

    async function save(buffer, persist) {
        await initialize();
        const directory = persist ? persistentDirectory : temporaryDirectory;
        await mkdir(directory, { recursive: true });
        if (!await isSafeDirectory(directory)) throw new Error('unsafe_audio_directory');
        for (let attempt = 0; attempt < 3; attempt++) {
            const audioId = `audio_${randomBytes(12).toString('hex')}`;
            const filePath = path.resolve(directory, `${audioId}.wav`);
            if (!isInside(directory, filePath)) throw new Error('unsafe_audio_path');
            try {
                await writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
                const reference = { audioId, filePath, temporary: !persist, format: 'wav' };
                references.set(audioId, reference);
                if (persist) {
                    try { await writePersistentRegistry(); }
                    catch (error) {
                        references.delete(audioId);
                        await rm(filePath, { force: true }).catch(() => {});
                        throw error;
                    }
                }
                return { audioId, temporary: !persist, format: 'wav' };
            } catch (error) {
                if (error.code !== 'EEXIST' || attempt === 2) throw error;
            }
        }
        throw new Error('audio_id_collision');
    }

    function get(audioId) {
        if (typeof audioId !== 'string' || !/^audio_[a-f0-9]{24}$/u.test(audioId)) return null;
        return references.get(audioId) ?? null;
    }

    async function isAvailable(audioId) {
        const reference = get(audioId);
        if (!reference) return false;
        try {
            if (!isInside(reference.temporary ? temporaryDirectory : persistentDirectory, reference.filePath)) return false;
            if (!await isSafeDirectory(path.dirname(reference.filePath))) return false;
            return (await lstat(reference.filePath)).isFile();
        } catch { return false; }
    }

    async function removeTemporary(audioId) {
        const reference = get(audioId);
        if (!reference?.temporary || !isInside(temporaryDirectory, reference.filePath)) return false;
        try {
            if (!await isSafeDirectory(temporaryDirectory)) return false;
            const info = await lstat(reference.filePath);
            if (!info.isFile() || info.isSymbolicLink()) return false;
            await rm(reference.filePath);
            references.delete(audioId);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') references.delete(audioId);
            return false;
        }
    }

    async function cleanupCurrentTemporaries() {
        let removed = 0;
        for (const [audioId, item] of references) {
            if (item.temporary && await removeTemporary(audioId)) removed++;
        }
        return { success: true, removed };
    }

    return { initialize, save, get, isAvailable, removeTemporary, cleanupOldTemporaryAudio, cleanupCurrentTemporaries };
}
