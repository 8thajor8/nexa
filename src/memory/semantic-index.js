import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const MEMORY_EMBEDDING_MODEL = 'text-embedding-3-small';
const FORMAT = 'nexa-memory2-semantic-index';
const VERSION = 2;
const EMBEDDING_BATCH_SIZE = 64;
const MAX_VECTOR_DIMENSIONS = 2048;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function validVector(vector) {
    return Array.isArray(vector) && vector.length > 0 && vector.length <= MAX_VECTOR_DIMENSIONS
        && vector.every(value => typeof value === 'number' && Number.isFinite(value));
}
function validIndex(value) {
    return value && value.format === FORMAT && value.version === VERSION
        && typeof value.storeId === 'string' && typeof value.model === 'string'
        && Array.isArray(value.entries) && value.entries.every(entry => entry
            && typeof entry.assertionId === 'string' && typeof entry.fingerprint === 'string'
            && typeof entry.subjectId === 'string' && typeof entry.status === 'string'
            && validVector(entry.vector));
}
function dot(left, right) {
    if (!validVector(left) || !validVector(right) || left.length !== right.length) return null;
    let product = 0, leftNorm = 0, rightNorm = 0;
    for (let index = 0; index < left.length; index++) {
        product += left[index] * right[index];
        leftNorm += left[index] ** 2;
        rightNorm += right[index] ** 2;
    }
    return leftNorm && rightNorm ? product / Math.sqrt(leftNorm * rightNorm) : null;
}

/** Rebuildable local vector index. The Memory2 Store remains the source of truth. */
export function createMemorySemanticIndex({ indexPath = null, storeId, embeddingProvider,
    fileSystem = {}, now = () => new Date().toISOString() } = {}) {
    if (typeof storeId !== 'string' || !storeId || !embeddingProvider
        || typeof embeddingProvider.embedMany !== 'function'
        || (indexPath !== null && (typeof indexPath !== 'string' || !path.isAbsolute(indexPath)))
        || typeof now !== 'function') throw new TypeError('memory_semantic_index_options_invalid');
    const fs = { ...nativeFs, ...fileSystem };
    const model = embeddingProvider.model ?? MEMORY_EMBEDDING_MODEL;
    let state = { format: FORMAT, version: VERSION, storeId, model, updatedAt: now(), entries: [] };
    let loaded = false;
    let queue = Promise.resolve();

    function serialized(operation) {
        const result = queue.then(operation);
        queue = result.catch(() => {});
        return result;
    }
    async function load() {
        if (loaded) return;
        loaded = true;
        if (!indexPath) return;
        try {
            const info = await fs.lstat(indexPath);
            if (!info.isFile() || info.isSymbolicLink()) return;
            const parsed = JSON.parse(await fs.readFile(indexPath, 'utf8'));
            if (validIndex(parsed) && parsed.storeId === storeId && parsed.model === model) state = parsed;
        } catch { /* A missing or corrupt derived index is rebuilt from Memory2. */ }
    }
    async function save() {
        if (!indexPath) return;
        state.updatedAt = now();
        const temporaryPath = `${indexPath}.${randomUUID()}.tmp`;
        let handle;
        try {
            handle = await fs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(JSON.stringify(state), 'utf8');
            await handle.sync();
            await handle.close(); handle = undefined;
            await fs.rename(temporaryPath, indexPath);
        } catch (error) {
            if (handle) await handle.close().catch(() => {});
            await fs.unlink(temporaryPath).catch(() => {});
            throw error;
        }
    }
    async function synchronize(records, { subjectId, signal } = {}) {
        return serialized(async () => {
            await load();
            if (!Array.isArray(records) || typeof subjectId !== 'string' || !subjectId
                || records.some(record => record?.subjectId !== subjectId))
                return { status: 'invalid_records', indexed: state.entries.length };
            const current = new Map(records.map(record => [record.assertionId, record]));
            state.entries = state.entries.filter(entry => entry.subjectId !== subjectId || (() => {
                const record = current.get(entry.assertionId);
                return record && record.fingerprint === entry.fingerprint
                    && record.subjectId === entry.subjectId && record.status === entry.status;
            })());
            const present = new Set(state.entries.filter(entry => entry.subjectId === subjectId)
                .map(entry => entry.assertionId));
            const missing = records.filter(record => !present.has(record.assertionId));
            let failureCode = null;
            for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
                if (signal?.aborted) {
                    const currentIds = new Set(current.keys());
                    state.entries = state.entries.filter(entry => entry.subjectId !== subjectId || currentIds.has(entry.assertionId));
                    try { await save(); } catch { /* A stale derived index is rebuilt next time. */ }
                    return { status: 'cancelled', indexed: state.entries.length };
                }
                const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
                try {
                    const vectors = await embeddingProvider.embedMany(batch.map(record => record.text), { signal });
                    if (!Array.isArray(vectors) || vectors.length !== batch.length || !vectors.every(validVector)
                        || (vectors.length > 1 && vectors.some(vector => vector.length !== vectors[0].length))) {
                        failureCode = 'invalid_embedding_response';
                        break;
                    }
                    for (let index = 0; index < batch.length; index++) {
                        const record = batch[index];
                        state.entries.push({ assertionId: record.assertionId, fingerprint: record.fingerprint,
                            subjectId: record.subjectId, status: record.status, vector: vectors[index] });
                    }
                    try { await save(); } // Preserve completed work if a later batch fails.
                    catch (error) { failureCode = ['EACCES', 'EPERM', 'EROFS', 'EXDEV', 'EEXIST'].includes(error?.code)
                        ? `index_storage_${error.code.toLowerCase()}` : 'index_storage_error'; break; }
                } catch {
                    failureCode = 'embedding_provider_error';
                    break;
                }
            }
            const currentIds = new Set(current.keys());
            state.entries = state.entries.filter(entry => entry.subjectId !== subjectId || currentIds.has(entry.assertionId));
            const indexedForSubject = state.entries.filter(entry => entry.subjectId === subjectId).length;
            if (failureCode || missing.length && indexedForSubject < records.length) {
                try { await save(); } catch { /* Keep in-memory results; next call can rebuild. */ }
                return { status: 'incomplete', reasonCode: failureCode ?? 'vectors_missing',
                    indexed: indexedForSubject, missing: records.length - indexedForSubject };
            }
            try { await save(); }
            catch { return { status: 'index_write_failed', indexed: indexedForSubject }; }
            return { status: 'ready', indexed: indexedForSubject, addedOrUpdated: missing.length };
        });
    }
    // Incremental path for a just-confirmed assertion. Unlike synchronize(),
    // this never evicts unrelated vectors or embeds the Store's full history.
    async function upsert(records, { subjectId, signal } = {}) {
        return serialized(async () => {
            await load();
            if (!Array.isArray(records) || typeof subjectId !== 'string' || !subjectId
                || records.some(record => !record || record.subjectId !== subjectId
                    || typeof record.assertionId !== 'string' || typeof record.fingerprint !== 'string'
                    || typeof record.status !== 'string' || typeof record.text !== 'string' || !record.text.trim()))
                return { status: 'invalid_records', indexed: state.entries.length };
            if (signal?.aborted) return { status: 'cancelled', indexed: state.entries.length };
            try {
                const vectors = await embeddingProvider.embedMany(records.map(record => record.text), { signal });
                if (!Array.isArray(vectors) || vectors.length !== records.length || !vectors.every(validVector)
                    || (vectors.length > 1 && vectors.some(vector => vector.length !== vectors[0].length)))
                    return { status: 'invalid_embedding_response', indexed: state.entries.length };
                const replacements = new Map(records.map((record, index) => [record.assertionId,
                    { assertionId: record.assertionId, fingerprint: record.fingerprint, subjectId,
                        status: record.status, vector: vectors[index] }]));
                state.entries = state.entries.filter(entry => entry.subjectId !== subjectId
                    || !replacements.has(entry.assertionId));
                state.entries.push(...replacements.values());
                await save();
                return { status: 'ready', indexed: state.entries.filter(entry => entry.subjectId === subjectId).length,
                    addedOrUpdated: records.length };
            } catch (error) {
                return { status: signal?.aborted ? 'cancelled' : 'incomplete',
                    reasonCode: error?.code === 'ENOENT' ? 'index_storage_missing' : 'embedding_or_index_write_failed',
                    indexed: state.entries.filter(entry => entry.subjectId === subjectId).length };
            }
        });
    }
    async function rank(queryVector, { subjectId, statuses = ['active'], limit = 12 } = {}) {
        return serialized(async () => {
            await load();
            if (!validVector(queryVector) || typeof subjectId !== 'string' || !Array.isArray(statuses)
                || statuses.some(status => typeof status !== 'string')
                || !Number.isInteger(limit) || limit < 1 || limit > 100) return [];
            const ranked = state.entries.filter(entry => entry.subjectId === subjectId && statuses.includes(entry.status))
                .map(entry => ({ assertionId: entry.assertionId, score: dot(queryVector, entry.vector) }))
                .filter(entry => typeof entry.score === 'number')
                .sort((a, b) => b.score - a.score || a.assertionId.localeCompare(b.assertionId));
            return ranked.slice(0, limit);
        });
    }
    async function clear() {
        return serialized(async () => {
            state = { format: FORMAT, version: VERSION, storeId, model, updatedAt: now(), entries: [] };
            loaded = true;
            if (indexPath) await fs.unlink(indexPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
            return true;
        });
    }
    async function removeSubject(subjectId) {
        if (typeof subjectId !== 'string' || !subjectId) return false;
        return serialized(async () => {
            await load();
            const before = state.entries.length;
            state.entries = state.entries.filter(entry => entry.subjectId !== subjectId);
            if (state.entries.length !== before) await save();
            return true;
        });
    }
    async function retain(records) {
        if (!Array.isArray(records) || records.some(record => !record
            || typeof record.assertionId !== 'string' || typeof record.subjectId !== 'string'
            || typeof record.fingerprint !== 'string' || typeof record.status !== 'string')) return false;
        const valid = new Map(records.map(record => [`${record.subjectId}\0${record.assertionId}`,
            `${record.fingerprint}\0${record.status}`]));
        return serialized(async () => {
            await load();
            const before = state.entries.length;
            state.entries = state.entries.filter(entry => valid.get(`${entry.subjectId}\0${entry.assertionId}`)
                === `${entry.fingerprint}\0${entry.status}`);
            if (state.entries.length !== before) await save();
            return true;
        });
    }
    return Object.freeze({ synchronize, upsert, rank, clear, removeSubject, retain, get model() { return model; } });
}

export function memoryEmbeddingFingerprint({ predicate, value, status, validFrom, validTo, subjectId }) {
    return digest(JSON.stringify({ predicate, value, status, validFrom, validTo, subjectId }));
}

export function cosineSimilarity(left, right) { return dot(left, right); }
