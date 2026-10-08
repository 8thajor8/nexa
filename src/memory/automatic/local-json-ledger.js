import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const LOCK_WAIT_MS = 1000;
const LOCK_RETRY_MS = 10;
const MAX_LEDGER_BYTES = 1024 * 1024;

export function getAutomaticMemoryLocalPath(fileName, { platform = process.platform,
    localAppData = process.env.LOCALAPPDATA, home = os.homedir(), dataHome = process.env.XDG_DATA_HOME } = {}) {
    if (typeof fileName !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,80}\.json$/u.test(fileName))
        throw new Error('automatic_memory_storage_path_invalid');
    let root;
    if (platform === 'win32') {
        root = typeof localAppData === 'string' && path.win32.isAbsolute(localAppData)
            ? localAppData : path.win32.join(home, 'AppData', 'Local');
        return path.win32.join(root, 'Nexa', 'AutomaticMemory', fileName);
    }
    root = typeof dataHome === 'string' && path.posix.isAbsolute(dataHome)
        ? dataHome : path.posix.join(home, '.local', 'share');
    return path.posix.join(root, 'nexa', 'automatic-memory', fileName);
}

function fileIdentity(stat) { return process.platform === 'win32' ? String(stat.ino) : `${stat.dev}:${stat.ino}`; }

async function ensureSafeDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('automatic_memory_storage_path_invalid');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
        await fs.chmod(directory, 0o700);
}

async function readValidated(filePath, validate, { missing = null } = {}) {
    let info;
    try { info = await fs.lstat(filePath); }
    catch (error) { if (error?.code === 'ENOENT') return structuredClone(missing); throw new Error('automatic_memory_storage_unavailable'); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LEDGER_BYTES)
        throw new Error('automatic_memory_storage_corrupt');
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return validate(parsed);
    } catch (error) {
        if (error?.message?.startsWith('automatic_memory_')) throw error;
        throw new Error('automatic_memory_storage_corrupt');
    }
}

async function acquireLock(lockPath) {
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() <= deadline) {
        let handle;
        try {
            handle = await fs.open(lockPath, 'wx', 0o600);
            await handle.writeFile(JSON.stringify({ token }) + '\n', 'utf8');
            await handle.sync();
            const identity = fileIdentity(await handle.stat());
            return { handle, token, identity };
        } catch (error) {
            if (handle) {
                try {
                    const own = fileIdentity(await handle.stat());
                    await handle.close(); handle = null;
                    const current = await fs.stat(lockPath);
                    const bytes = await fs.readFile(lockPath, 'utf8');
                    if (fileIdentity(current) === own && JSON.parse(bytes).token === token) await fs.unlink(lockPath);
                } catch { /* leave an uncertain lock in place; fail closed */ }
            }
            if (error?.code !== 'EEXIST') throw new Error('automatic_memory_storage_unavailable');
            if (Date.now() >= deadline) throw new Error('automatic_memory_storage_busy');
            await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }
    throw new Error('automatic_memory_storage_busy');
}

async function releaseLock(lockPath, lock) {
    let releaseError = null;
    try { await lock.handle.close(); } catch { releaseError = new Error('automatic_memory_storage_lock_release_failed'); }
    try {
        const current = await fs.stat(lockPath);
        const bytes = await fs.readFile(lockPath, 'utf8');
        if (fileIdentity(current) !== lock.identity || JSON.parse(bytes).token !== lock.token)
            throw new Error('automatic_memory_storage_lock_release_failed');
        await fs.unlink(lockPath);
    } catch { releaseError = new Error('automatic_memory_storage_lock_release_failed'); }
    if (releaseError) throw releaseError;
}

async function writeAtomically(filePath, value, validate) {
    const normalized = validate(value);
    const bytes = Buffer.from(JSON.stringify(normalized, null, 2) + '\n', 'utf8');
    if (bytes.length > MAX_LEDGER_BYTES) throw new Error('automatic_memory_storage_too_large');
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle, identity = null, published = false;
    try {
        handle = await fs.open(temporaryPath, 'wx', 0o600);
        identity = fileIdentity(await handle.stat());
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temporaryPath, filePath);
        published = true;
    } catch {
        if (handle) await handle.close().catch(() => {});
        if (!published && identity) {
            try {
                const current = await fs.stat(temporaryPath);
                if (fileIdentity(current) === identity) await fs.unlink(temporaryPath);
            } catch { /* leave an unidentified residue for manual inspection */ }
        }
        throw new Error('automatic_memory_storage_write_failed');
    }
    return normalized;
}

/** Small local ledger. Reads are atomic-rename safe and never create files.
 * Mutations use an exclusive cooperative lock; stale locks are never stolen.
 */
export function createLocalJsonLedger({ filePath, validate, initialValue = null } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || typeof validate !== 'function')
        throw new Error('automatic_memory_storage_path_invalid');
    const resolved = path.resolve(filePath);
    const lockPath = `${resolved}.lock`;

    async function read() { return readValidated(resolved, validate, { missing: initialValue }); }

    async function withLock(action) {
        await ensureSafeDirectory(path.dirname(resolved));
        const lock = await acquireLock(lockPath);
        let result, actionError;
        try { result = await action(); } catch (error) { actionError = error; }
        try { await releaseLock(lockPath, lock); }
        catch (error) { if (!actionError) actionError = error; }
        if (actionError) throw actionError;
        return result;
    }

    return Object.freeze({
        read,
        write: value => withLock(() => writeAtomically(resolved, value, validate)),
        update: mutator => withLock(async () => {
            const before = await read();
            const candidate = await mutator(structuredClone(before));
            const after = validate(candidate);
            if (JSON.stringify(before) === JSON.stringify(after)) return structuredClone(after);
            return writeAtomically(resolved, after, validate);
        }),
    });
}
