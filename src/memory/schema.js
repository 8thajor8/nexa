import { canonicalSubject, normalizeEntityName, isEntityName } from './entities.js';
import { getRelationPredicate } from './relation-predicates.js';
// Memory is inert data. This module performs no I/O and never interprets values.
export const SCHEMA_VERSION = 5;
export const PREVIOUS_SCHEMA_VERSION = 4;
export const COLLECTIONS_V4 = Object.freeze(['entities', 'assertions', 'sources', 'evidence', 'migrations']);
export const COLLECTIONS_V5 = Object.freeze([...COLLECTIONS_V4, 'automatic_operations']);
// Latest collections are used for new stores; validation selects the exact set
// from the stored version so v4 repositories remain readable and writable.
export const COLLECTIONS = COLLECTIONS_V5;
export const COMPATIBILITY_CATEGORIES = Object.freeze(['fact', 'preference', 'person', 'project', 'routine', 'user']);
export const SOURCE_TRUST = Object.freeze({
    user_statement: 'user_asserted', legacy_memory_1: 'unknown',
    chatgpt_history: 'external_untrusted', email: 'external_untrusted',
    calendar: 'external_untrusted', crm: 'external_untrusted', inference: 'derived_untrusted',
});
// Lowercase namespace segments: letter followed by letters, digits or underscores.
export const PREDICATE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const prefixes = { assertions: 'mem', sources: 'src', evidence: 'ev', store: 'store', person: 'person', entities: 'person' };
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class MemorySchemaError extends Error {
    constructor(path, code = 'memory_schema_invalid') {
        super(code === 'memory_schema_unsupported' ? 'Unsupported memory schema version.' : 'Invalid memory data structure.');
        this.name = 'MemorySchemaError';
        this.code = code;
        this.path = path; // Only validator-owned property names and array indices.
    }
    toJSON() { return { code: this.code, message: this.message, path: this.path }; }
}
function requireValue(condition, path) { if (!condition) throw new MemorySchemaError(path); }

// Reject accessors, symbols, prototypes and extra properties before reading values.
export function assertExactObject(value, keys, path = 'input') {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path);
    const prototype = Object.getPrototypeOf(value);
    requireValue(prototype === Object.prototype || prototype === null, path);
    const own = Reflect.ownKeys(value);
    requireValue(own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)), path);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValue(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, path + '.' + key);
    }
}
export function assertDenseArray(value, path = 'input') {
    requireValue(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, path);
    requireValue(Reflect.ownKeys(value).length === value.length + 1, path);
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        requireValue(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable, path + '[' + i + ']');
    }
}
function text(value, min, max, path) {
    requireValue(typeof value === 'string' && value.isWellFormed() && [...value].length >= min && [...value].length <= max, path);
}
function integer(value, path) { requireValue(Number.isSafeInteger(value) && value >= 0, path); }
export function validateId(value, collection, path = 'id') {
    requireValue(Object.hasOwn(prefixes, collection) && typeof value === 'string'
        && new RegExp('^' + prefixes[collection] + '_' + uuid + '$', 'u').test(value), path);
}
function date(value) {
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return false;
    const [, y, m, d] = match.map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
export function validateTimestamp(value, path = 'timestamp') {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
    requireValue(match && date(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60, path);
}
function nullableTimestamp(value, path) { if (value !== null) validateTimestamp(value, path); }
export function validateTemporal(value, path = 'temporal') {
    if (value === null) return;
    assertExactObject(value, ['value', 'precision'], path);
    switch (value.precision) {
        case 'year': requireValue(typeof value.value === 'string' && /^\d{4}$/u.test(value.value) && Number(value.value) >= 1, path); break;
        case 'month': requireValue(typeof value.value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/u.test(value.value) && Number(value.value.slice(0, 4)) >= 1, path); break;
        case 'day': requireValue(date(value.value), path); break;
        case 'instant': validateTimestamp(value.value, path + '.value'); break;
        default: throw new MemorySchemaError(path + '.precision');
    }
}
function temporalRange(value) {
    if (value.precision === 'instant') return [Date.parse(value.value), Date.parse(value.value)];
    const start = value.value + ({ year: '-01-01', month: '-01', day: '' }[value.precision]);
    const low = new Date(start + 'T00:00:00.000Z');
    const high = new Date(low);
    if (value.precision === 'year') high.setUTCFullYear(high.getUTCFullYear() + 1);
    else if (value.precision === 'month') high.setUTCMonth(high.getUTCMonth() + 1);
    else high.setUTCDate(high.getUTCDate() + 1);
    return [low.getTime(), high.getTime() - 1];
}
export function validateTemporalInterval(start, end, path = 'temporal') {
    if (start !== null && end !== null) requireValue(temporalRange(start)[0] < temporalRange(end)[1], path);
}
function assertion(value, path) {
    assertExactObject(value, ['id', 'kind', 'subject', 'predicate', 'object', 'status', 'valid_from', 'valid_to', 'recorded_at', 'supersedes', 'compatibility'], path);
    validateId(value.id, 'assertions', path + '.id');
    requireValue(['fact', 'preference', 'legacy'].includes(value.kind), path + '.kind');
    const subjectType = Object.getOwnPropertyDescriptor(value.subject ?? {}, 'type')?.value;
    if (subjectType === 'entity') {
        assertExactObject(value.subject, ['type', 'entity_type', 'id'], path + '.subject');
        requireValue(value.subject.entity_type === 'person', path + '.subject.entity_type');
        validateId(value.subject.id, 'person', path + '.subject.id');
    } else {
        assertExactObject(value.subject, ['type'], path + '.subject');
        requireValue(['owner', 'unspecified'].includes(value.subject.type), path + '.subject.type');
    }
    text(value.predicate, 1, 128, path + '.predicate');
    requireValue(PREDICATE_PATTERN.test(value.predicate), path + '.predicate');
    const relationPredicate = getRelationPredicate(value.predicate);
    if (relationPredicate) {
        requireValue(value.kind === 'fact' && value.compatibility === null, path);
        assertExactObject(value.object, ['type', 'entity_type', 'id'], path + '.object');
        requireValue(value.object.type === 'entity_reference', path + '.object.type');
        requireValue(relationPredicate.subjectTypes.includes(value.subject.entity_type)
            && relationPredicate.objectTypes.includes(value.object.entity_type), path + '.predicate');
        validateId(value.object.id, value.object.entity_type, path + '.object.id');
        requireValue(value.subject.type === 'entity', path + '.subject');
        if (!relationPredicate.allowSelf) requireValue(value.subject.id !== value.object.id, path + '.object.id');
        if (relationPredicate.symmetric) requireValue(value.subject.id < value.object.id, path + '.subject.id');
    } else {
        assertExactObject(value.object, ['type', 'value'], path + '.object');
        requireValue(value.object.type === 'text', path + '.object.type');
        text(value.object.value, 1, 4000, path + '.object.value');
    }
    if (isEntityName(value.predicate)) {
        requireValue(value.subject.type !== 'unspecified' && value.kind === 'fact'
            && value.compatibility === null && value.valid_from === null && value.valid_to === null, path);
        try { normalizeEntityName(value.object.value); } catch { throw new MemorySchemaError(path + '.object.value'); }
    }
    requireValue(['active', 'superseded'].includes(value.status), path + '.status');
    validateTemporal(value.valid_from, path + '.valid_from');
    validateTemporal(value.valid_to, path + '.valid_to');
    validateTemporalInterval(value.valid_from, value.valid_to, path + '.valid_to');
    validateTimestamp(value.recorded_at, path + '.recorded_at');
    assertDenseArray(value.supersedes, path + '.supersedes');
    value.supersedes.forEach((id, i) => validateId(id, 'assertions', path + '.supersedes[' + i + ']'));
    requireValue(new Set(value.supersedes).size === value.supersedes.length, path + '.supersedes');
    if (value.compatibility !== null) {
        assertExactObject(value.compatibility, ['category', 'key'], path + '.compatibility');
        requireValue(COMPATIBILITY_CATEGORIES.includes(value.compatibility.category), path + '.compatibility.category');
        text(value.compatibility.key, 1, 128, path + '.compatibility.key');
    }
}
function entity(value, path) {
    assertExactObject(value, ['id', 'type', 'created_at'], path);
    validateId(value.id, 'entities', path + '.id');
    requireValue(value.type === 'person', path + '.type');
    validateTimestamp(value.created_at, path + '.created_at');
}
function source(value, path) {
    assertExactObject(value, ['id', 'kind', 'origin_trust', 'authority', 'locator', 'occurred_at', 'recorded_at'], path);
    validateId(value.id, 'sources', path + '.id');
    requireValue(typeof value.kind === 'string' && Object.hasOwn(SOURCE_TRUST, value.kind), path + '.kind');
    requireValue(value.origin_trust === SOURCE_TRUST[value.kind], path + '.origin_trust');
    requireValue(value.authority === 'data_only', path + '.authority');
    // Opaque tokens only; paths/URLs and their dereferencing are outside this layer.
    requireValue(value.locator === null || (typeof value.locator === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value.locator)), path + '.locator');
    validateTemporal(value.occurred_at, path + '.occurred_at');
    validateTimestamp(value.recorded_at, path + '.recorded_at');
}
function evidence(value, path) {
    assertExactObject(value, ['id', 'assertion_id', 'source_id', 'derivation', 'extraction_confidence', 'learned_at', 'last_confirmed_at', 'legacy_ref'], path);
    validateId(value.id, 'evidence', path + '.id');
    validateId(value.assertion_id, 'assertions', path + '.assertion_id');
    validateId(value.source_id, 'sources', path + '.source_id');
    requireValue(['explicit', 'inferred', 'unknown'].includes(value.derivation), path + '.derivation');
    requireValue(value.extraction_confidence === null || (typeof value.extraction_confidence === 'number'
        && Number.isFinite(value.extraction_confidence) && value.extraction_confidence >= 0 && value.extraction_confidence <= 1), path + '.extraction_confidence');
    nullableTimestamp(value.learned_at, path + '.learned_at');
    nullableTimestamp(value.last_confirmed_at, path + '.last_confirmed_at');
    if (value.legacy_ref !== null) {
        assertExactObject(value.legacy_ref, ['category', 'key', 'index'], path + '.legacy_ref');
        text(value.legacy_ref.category, 1, 128, path + '.legacy_ref.category');
        text(value.legacy_ref.key, 1, 128, path + '.legacy_ref.key');
        if (value.legacy_ref.index !== null) integer(value.legacy_ref.index, path + '.legacy_ref.index');
    }
}
function migration(value, path) {
    assertExactObject(value, ['source_sha256', 'conversion_version', 'applied_at', 'source_entry_count', 'created_assertion_count'], path);
    requireValue(typeof value.source_sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.source_sha256), path + '.source_sha256');
    requireValue(value.conversion_version === 1, path + '.conversion_version');
    validateTimestamp(value.applied_at, path + '.applied_at');
    integer(value.source_entry_count, path + '.source_entry_count');
    integer(value.created_assertion_count, path + '.created_assertion_count');
}
const SAFE_AUTOMATIC_RESULT_CODES = Object.freeze(['policy_rejected', 'target_conflict', 'operation_invalid']);
function automaticOperation(value, path) {
    assertExactObject(value, ['operation_key', 'operation_fingerprint_sha256', 'operation_kind', 'status',
        'authorization_request_id', 'expected_revision', 'expected_digest', 'result_revision',
        'result_assertion_id', 'target_assertion_id', 'result_code', 'recorded_at'], path);
    requireValue(SHA256.test(value.operation_key), path + '.operation_key');
    requireValue(SHA256.test(value.operation_fingerprint_sha256), path + '.operation_fingerprint_sha256');
    requireValue(['ADD', 'REPLACE'].includes(value.operation_kind), path + '.operation_kind');
    requireValue(['applied', 'rejected_terminal'].includes(value.status), path + '.status');
    requireValue(typeof value.authorization_request_id === 'string' && REQUEST_ID.test(value.authorization_request_id), path + '.authorization_request_id');
    integer(value.expected_revision, path + '.expected_revision');
    requireValue(SHA256.test(value.expected_digest), path + '.expected_digest');
    integer(value.result_revision, path + '.result_revision');
    requireValue(value.result_revision === value.expected_revision + 1, path + '.result_revision');
    requireValue(value.target_assertion_id === null || (() => { try { validateId(value.target_assertion_id, 'assertions', path + '.target_assertion_id'); return true; } catch { return false; } })(), path + '.target_assertion_id');
    if (value.operation_kind === 'ADD') requireValue(value.target_assertion_id === null, path + '.target_assertion_id');
    else requireValue(value.target_assertion_id !== null, path + '.target_assertion_id');
    if (value.status === 'applied') {
        validateId(value.result_assertion_id, 'assertions', path + '.result_assertion_id');
        requireValue(value.result_code === null, path + '.result_code');
    } else {
        requireValue(value.result_assertion_id === null && SAFE_AUTOMATIC_RESULT_CODES.includes(value.result_code), path + '.result_code');
    }
    validateTimestamp(value.recorded_at, path + '.recorded_at');
}
const validators = { entities: entity, assertions: assertion, sources: source, evidence, migrations: migration,
    automatic_operations: automaticOperation };
export function validateMemoryRecord(collection, value, path = 'record') {
    requireValue(typeof collection === 'string' && Object.hasOwn(validators, collection), path);
    validators[collection](value, path);
    return value;
}
export function validateMemoryStore(store) {
    // Recognize incompatible versions before requiring version-specific fields.
    const version = Object.getOwnPropertyDescriptor(store ?? {}, 'schema_version');
    if (version && Object.hasOwn(version, 'value') && ![PREVIOUS_SCHEMA_VERSION, SCHEMA_VERSION].includes(version.value)) {
        throw new MemorySchemaError('store.schema_version', 'memory_schema_unsupported');
    }
    const collections = store?.schema_version === PREVIOUS_SCHEMA_VERSION ? COLLECTIONS_V4 : COLLECTIONS_V5;
    assertExactObject(store, ['schema_version', 'store_id', 'self_person_id', 'revision', 'created_at', 'updated_at', ...collections], 'store');
    validateId(store.store_id, 'store', 'store.store_id');
    integer(store.revision, 'store.revision');
    validateTimestamp(store.created_at, 'store.created_at');
    validateTimestamp(store.updated_at, 'store.updated_at');
    requireValue(Date.parse(store.updated_at) >= Date.parse(store.created_at), 'store.updated_at');
    const ids = new Set();
    for (const collection of collections) {
        assertDenseArray(store[collection], 'store.' + collection);
        store[collection].forEach((record, i) => {
            const path = 'store.' + collection + '[' + i + ']';
            validateMemoryRecord(collection, record, path);
            const key = collection === 'migrations' ? record.source_sha256
                : collection === 'automatic_operations' ? record.operation_key : record.id;
            const uniqueKey = collection + ':' + key;
            requireValue(!ids.has(uniqueKey), path);
            ids.add(uniqueKey);
        });
    }
    if (store.schema_version === SCHEMA_VERSION) {
        const fingerprints = new Set();
        store.automatic_operations.forEach((record, i) => {
            const path = 'store.automatic_operations[' + i + ']';
            requireValue(!fingerprints.has(record.operation_fingerprint_sha256), path + '.operation_fingerprint_sha256');
            requireValue(record.result_revision <= store.revision, path + '.result_revision');
            fingerprints.add(record.operation_fingerprint_sha256);
            if (record.operation_kind === 'REPLACE') {
                requireValue(store.assertions.some(assertion => assertion.id === record.target_assertion_id), path + '.target_assertion_id');
            }
            if (record.status === 'applied') {
                const result = store.assertions.find(assertion => assertion.id === record.result_assertion_id);
                requireValue(Boolean(result), path + '.result_assertion_id');
                if (record.operation_kind === 'REPLACE') requireValue(result.supersedes.includes(record.target_assertion_id), path + '.target_assertion_id');
                else requireValue(!result.supersedes.length, path + '.result_assertion_id');
            }
        });
    }
    validateId(store.self_person_id, 'person', 'store.self_person_id');
    const entities = new Map(store.entities.map(record => [record.id, record]));
    requireValue(entities.get(store.self_person_id)?.type === 'person', 'store.self_person_id');
    const nameSlots = new Set();
    const activeRelations = new Set();
    store.assertions.forEach((record, i) => {
        const subject = canonicalSubject(record.subject, store);
        if (subject.type === 'entity') requireValue(entities.get(subject.id)?.type === subject.entity_type, 'store.assertions[' + i + '].subject');
        const relation = getRelationPredicate(record.predicate);
        if (relation) {
            requireValue(entities.get(record.object.id)?.type === record.object.entity_type, 'store.assertions[' + i + '].object');
            if (record.status === 'active') {
                const key = JSON.stringify([record.predicate, record.subject.id, record.object.id, record.valid_from, record.valid_to]);
                requireValue(!activeRelations.has(key), 'store.assertions[' + i + ']');
                activeRelations.add(key);
            }
        }
        if (record.status === 'active' && isEntityName(record.predicate)) {
            const key = subject.id + ':' + record.predicate + (record.predicate === 'entity.alias' ? ':' + normalizeEntityName(record.object.value) : '');
            requireValue(!nameSlots.has(key), 'store.assertions[' + i + ']');
            nameSlots.add(key);
        }
    });
    const assertions = new Map(store.assertions.map(record => [record.id, record]));
    const sources = new Set(store.sources.map(record => record.id));
    const supported = new Set();
    store.evidence.forEach((record, i) => {
        requireValue(assertions.has(record.assertion_id) && sources.has(record.source_id), 'store.evidence[' + i + ']');
        supported.add(record.assertion_id);
    });
    const incoming = new Map(store.assertions.map(record => [record.id, 0]));
    store.assertions.forEach((record, i) => {
        requireValue(supported.has(record.id), 'store.assertions[' + i + ']');
        for (const target of record.supersedes) {
            requireValue(assertions.has(target) && target !== record.id, 'store.assertions[' + i + '].supersedes');
            const previous = assertions.get(target);
            const currentRelation = getRelationPredicate(record.predicate);
            const previousRelation = getRelationPredicate(previous.predicate);
            if (currentRelation || previousRelation) {
                requireValue(currentRelation && previousRelation && record.predicate === previous.predicate
                    && previous.status === 'superseded', 'store.assertions[' + i + '].supersedes');
                const endpoints = new Set([record.subject.id, record.object.id]);
                requireValue(endpoints.has(previous.subject.id) || endpoints.has(previous.object.id), 'store.assertions[' + i + '].supersedes');
            }
            incoming.set(target, incoming.get(target) + 1);
        }
    });
    // Iterative topological traversal avoids stack exhaustion for long histories.
    const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
    for (let i = 0; i < ready.length; i++) {
        for (const target of assertions.get(ready[i]).supersedes) {
            incoming.set(target, incoming.get(target) - 1);
            if (incoming.get(target) === 0) ready.push(target);
        }
    }
    requireValue(ready.length === assertions.size, 'store.assertions');
    return store;
}
