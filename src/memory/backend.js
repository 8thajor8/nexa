import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMemoryStore } from './schema.js';
import { createJsonMemoryRepository } from './json-repository.js';
import { createMemoryService } from './service.js';
import { createMemoryContextProvider } from './context-provider.js';
import { loadMemory } from './memory.js';

function publicStartupError(code) {
    const error = new Error(`Selected Memory 2 store could not be opened (${code}). No fallback was performed.`);
    error.name = 'MemoryBackendStartupError'; error.code = code;
    return error;
}

/** Initialize only a missing store with exclusive creation. Existing bytes are
 * never rewritten here: the repository validates them and startup fails closed.
 */
export async function initializeEmptyMemoryStore({ storePath, now = () => new Date().toISOString() } = {}) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw publicStartupError('memory_repository_invalid');
    let parent;
    try { parent = await fs.realpath(path.dirname(storePath)); }
    catch { throw publicStartupError('memory_store_unreadable'); }
    const destination = path.join(parent, path.basename(storePath));
    try {
        await fs.lstat(destination);
        return { created: false, path: destination };
    } catch (error) {
        if (error?.code !== 'ENOENT') throw publicStartupError('memory_store_unreadable');
    }
    const timestamp = now();
    const selfId = 'person_' + randomUUID();
    const store = { schema_version: 3, self_person_id: selfId,
        entities: [{ id: selfId, type: 'person', created_at: timestamp }], store_id: 'store_' + randomUUID(), revision: 0,
        created_at: timestamp, updated_at: timestamp, assertions: [], sources: [], evidence: [], migrations: [] };
    try { validateMemoryStore(store); }
    catch { throw publicStartupError('memory_store_initialization_failed'); }
    let handle;
    try {
        handle = await fs.open(destination, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(store, null, 2) + '\n', 'utf8');
        await handle.sync();
        await handle.close(); handle = undefined;
        return { created: true, path: destination };
    } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error?.code === 'EEXIST') return { created: false, path: destination };
        throw publicStartupError(error?.code === 'ENOENT' ? 'memory_store_unreadable' : 'memory_store_initialization_failed');
    }
}

export async function openMemoryBackend({ backend, storePath, loadLegacy = loadMemory,
    repositoryFactory = createJsonMemoryRepository, now } = {}) {
    if (backend === 'memory1') return { backend, memory: await loadLegacy(), close: async () => {} };
    if (backend !== 'memory2') throw publicStartupError('memory_backend_invalid');
    await initializeEmptyMemoryStore({ storePath, ...(now ? { now } : {}) });
    const repository = repositoryFactory({ storePath, ...(now ? { now } : {}) });
    try {
        await repository.open();
        return { backend, repository, memory: { user: {}, preferences: {}, facts: [] },
            service: createMemoryService({ repository, ...(now ? { now } : {}) }),
            contextProvider: createMemoryContextProvider({ repository }),
            close: () => repository.close() };
    } catch (error) {
        try { await repository.close(); } catch { /* Preserve the original startup failure. */ }
        const code = typeof error?.code === 'string' ? error.code : 'memory_store_unreadable';
        throw publicStartupError(code);
    }
}
