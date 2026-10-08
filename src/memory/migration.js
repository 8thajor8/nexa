import { createHash } from 'node:crypto';
import { SCHEMA_VERSION, assertDenseArray, assertExactObject, validateMemoryStore, validateTimestamp } from './schema.js';
import { MemoryRepositoryError } from './repository.js';
import { screenMemorySecret } from './secret-screening.js';

const allowedCategories = new Set(['user', 'preference', 'preferences', 'person', 'project', 'routine']);
const emptyCode = 'memory_migration_invalid_legacy';
const publicMessages = Object.freeze({
    [emptyCode]: 'Legacy memory is malformed or contains an unsupported value; no migration was applied.',
    memory_secret_suspected: 'Legacy memory contains a value that looks like a credential; no migration was applied.',
    memory_migration_destination_not_empty: 'The v2 destination already contains data; migration did not overwrite it.',
    memory_migration_already_applied: 'This legacy source has already been migrated.',
    memory_migration_failed: 'The migration could not be completed.',
});
export class MemoryMigrationError extends Error {
    constructor(code, { cause } = {}) {
        if (!Object.hasOwn(publicMessages, code)) code = 'memory_migration_failed';
        super(publicMessages[code], cause === undefined ? undefined : { cause });
        this.name = 'MemoryMigrationError'; this.code = code;
    }
    toJSON() { return { code: this.code, message: this.message }; }
}
function invalid(cause) { throw new MemoryMigrationError(emptyCode, { cause }); }
function keysOf(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) invalid();
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
    }
    return keys;
}
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function deterministicId(prefix, seed) {
    const bytes = Buffer.from(createHash('sha256').update(seed).digest('hex').slice(0, 32), 'hex');
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return prefix + '_' + [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
function validateLegacy(legacy, secretScreen) {
    const rootKeys = keysOf(legacy, 'legacy');
    if (!rootKeys.includes('facts') || rootKeys.some(key => key !== 'facts' && !allowedCategories.has(key))) invalid();
    assertDenseArray(legacy.facts, 'legacy.facts');
    const entries = [];
    for (const category of rootKeys.filter(key => key !== 'facts').sort()) {
        keysOf(legacy[category], 'legacy.category');
        for (const key of Object.keys(legacy[category])) {
            if (!key.isWellFormed() || [...key].length < 1 || [...key].length > 128 || typeof legacy[category][key] !== 'string'
                || !legacy[category][key].isWellFormed() || [...legacy[category][key]].length < 1 || [...legacy[category][key]].length > 4000) invalid();
            const scanned = secretScreen(legacy[category][key]);
            if (!scanned?.safe) throw new MemoryMigrationError('memory_secret_suspected');
            entries.push({ sourceCategory: category, compatibilityCategory: category === 'preferences' || category === 'preference' ? 'preference' : category,
                key, index: null, value: legacy[category][key] });
        }
    }
    for (let index = 0; index < legacy.facts.length; index++) {
        const item = legacy.facts[index];
        try { assertExactObject(item, ['key', 'value'], `legacy.facts[${index}]`); }
        catch (cause) { invalid(cause); }
        if (typeof item.key !== 'string' || !item.key.isWellFormed() || [...item.key].length < 1 || [...item.key].length > 128
            || typeof item.value !== 'string' || !item.value.isWellFormed() || [...item.value].length < 1 || [...item.value].length > 4000) invalid();
        const scanned = secretScreen(item.value);
        if (!scanned?.safe) throw new MemoryMigrationError('memory_secret_suspected');
        entries.push({ sourceCategory: 'facts', compatibilityCategory: 'fact', key: item.key, index, value: item.value });
    }
    return entries;
}

/** Pure and deterministic Memory 1 → 2 conversion; returned values remain data. */
export function planMemory1Migration({ legacy, now = () => new Date().toISOString(), secretScreen = screenMemorySecret } = {}) {
    let entries;
    try { entries = validateLegacy(legacy, secretScreen); }
    catch (error) {
        if (error instanceof MemoryMigrationError) throw error;
        throw new MemoryMigrationError(emptyCode, { cause: error });
    }
    const serialized = canonical(legacy);
    const source_sha256 = createHash('sha256').update(serialized).digest('hex');
    const recordedAt = now();
    try { validateTimestamp(recordedAt, 'migration.now'); }
    catch (cause) { throw new MemoryMigrationError('memory_migration_failed', { cause }); }
    const sourceId = deterministicId('src', `memory1:${source_sha256}`);
    const assertions = entries.map(entry => {
        const seed = `${source_sha256}:${entry.sourceCategory}:${entry.key}:${entry.index ?? ''}`;
        const subject = ['user', 'preference', 'preferences'].includes(entry.sourceCategory) ? { type: 'owner' } : { type: 'unspecified' };
        const kind = entry.sourceCategory === 'facts' ? 'fact' : entry.compatibilityCategory === 'preference' ? 'preference' : 'legacy';
        const predicateCategory = entry.compatibilityCategory === 'fact' ? 'fact' : entry.compatibilityCategory;
        return {
            id: deterministicId('mem', `assertion:${seed}`), kind, subject,
            predicate: `legacy.${predicateCategory}`, object: { type: 'text', value: entry.value },
            status: 'active', valid_from: null, valid_to: null, recorded_at: recordedAt, supersedes: [],
            compatibility: { category: entry.compatibilityCategory, key: entry.key },
        };
    });
    const sources = entries.length ? [{ id: sourceId, kind: 'legacy_memory_1', origin_trust: 'unknown', authority: 'data_only',
        locator: null, occurred_at: null, recorded_at: recordedAt }] : [];
    const evidence = entries.map((entry, index) => ({
        id: deterministicId('ev', `evidence:${source_sha256}:${entry.sourceCategory}:${entry.key}:${entry.index ?? ''}`),
        assertion_id: assertions[index].id, source_id: sourceId, derivation: 'unknown', extraction_confidence: null,
        learned_at: null, last_confirmed_at: null,
        legacy_ref: { category: entry.sourceCategory, key: entry.key, index: entry.index },
    }));
    const receipt = { source_sha256, conversion_version: 1, applied_at: recordedAt,
        source_entry_count: entries.length, created_assertion_count: assertions.length };
    try {
        const skeleton = { schema_version: SCHEMA_VERSION, self_person_id: 'person_00000000-0000-4000-8000-000000000000', entities: [{ id: 'person_00000000-0000-4000-8000-000000000000', type: 'person', created_at: '2000-01-01T00:00:00.000Z' }], store_id: 'store_00000000-0000-4000-8000-000000000000', revision: 0,
            created_at: recordedAt, updated_at: recordedAt, assertions, sources, evidence, migrations: [receipt], automatic_operations: [] };
        validateMemoryStore(skeleton);
    } catch (cause) { throw new MemoryMigrationError('memory_migration_failed', { cause }); }
    return Object.freeze({ source_sha256, assertions: Object.freeze(assertions),
        sources: Object.freeze(sources), evidence: Object.freeze(evidence), receipt: Object.freeze(receipt),
        outcome: 'planned', trust: Object.freeze({ authority: 'data_only' }) });
}

/** Apply only to a separately initialized, empty v2 store; never initializes or reads a personal path. */
export async function applyMemory1Migration({ legacy, repository, now = () => new Date().toISOString(), secretScreen = screenMemorySecret } = {}) {
    let plan;
    try { plan = planMemory1Migration({ legacy, now, secretScreen }); }
    catch (error) { return { success: false, error: error instanceof MemoryMigrationError ? error.toJSON() : new MemoryMigrationError(emptyCode).toJSON() }; }
    try {
        if (!repository || typeof repository.readSnapshot !== 'function' || typeof repository.commit !== 'function') throw new Error();
        const current = await repository.readSnapshot();
        const existingReceipt = current.snapshot.migrations.find(item => item.source_sha256 === plan.source_sha256);
        if (existingReceipt) return { success: true, outcome: 'already_applied', revision: current.revision,
            receipt: structuredClone(existingReceipt), trust: { authority: 'data_only' } };
        const empty = current.snapshot.entities.length === 1 && current.snapshot.entities[0].id === current.snapshot.self_person_id
            && current.revision === 0 && ['assertions', 'sources', 'evidence', 'migrations',
                ...(Array.isArray(current.snapshot.automatic_operations) ? ['automatic_operations'] : [])]
                .every(name => current.snapshot[name].length === 0);
        if (!empty) throw new MemoryMigrationError('memory_migration_destination_not_empty');
        const changes = [
            ...plan.sources.map(record => ({ type: 'put', collection: 'sources', record })),
            ...plan.assertions.map(record => ({ type: 'put', collection: 'assertions', record })),
            ...plan.evidence.map(record => ({ type: 'put', collection: 'evidence', record })),
            { type: 'put', collection: 'migrations', record: plan.receipt },
        ];
        const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes });
        return { success: true, outcome: 'migrated', revision: committed.revision, receipt: structuredClone(plan.receipt),
            assertionIds: plan.assertions.map(item => item.id), trust: { authority: 'data_only' } };
    } catch (error) {
        if (error instanceof MemoryMigrationError) return { success: false, error: error.toJSON() };
        if (error instanceof MemoryRepositoryError) return { success: false, error: error.toJSON() };
        return { success: false, error: new MemoryMigrationError('memory_migration_failed', { cause: error }).toJSON() };
    }
}
