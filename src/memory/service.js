import { canonicalSubject, normalizeEntityName, projectPerson, isEntityName, eligibleNameAssertions } from './entities.js';
import { resolveEntities } from './entity-resolver.js';
import { createMemoryRetriever } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { COMPATIBILITY_CATEGORIES, assertExactObject, validateId, validateMemoryRecord, validateTimestamp } from './schema.js';
import { consumeMemoryAuthorization, validateRememberProposal } from './authorization.js';
import { validateForgetTarget, validatePersonCreation, validateRelationRequest, validateRelationForget } from './commands.js';
import { getRelationPredicate } from './relation-predicates.js';
import { screenMemorySecret } from './secret-screening.js';
import { MemoryRepositoryError } from './repository.js';

const publicErrors = Object.freeze({
    memory_write_not_authorized: 'A matching explicit direct-user memory command is required.',
    memory_secret_suspected: 'This value looks like a credential and was not stored.',
    memory_invalid_input: 'The memory request is invalid.',
    memory_not_found: 'No memory matched the exact target.',
    memory_ambiguous: 'The memory target is ambiguous; no records were changed.',
    memory_operation_failed: 'The memory operation could not be completed.',
});
function failure(code) { return { success: false, error: { code, message: publicErrors[code] ?? publicErrors.memory_operation_failed } }; }
function safeFailure(error) {
    if (error?.code === 'memory_write_not_authorized') return failure('memory_write_not_authorized');
    if (error?.code === 'memory_secret_suspected') return failure('memory_secret_suspected');
    if (error instanceof MemoryRepositoryError) return { success: false, error: error.toJSON() };
    return failure('memory_invalid_input');
}
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function same(a, b) { return canonical(a) === canonical(b); }
function sameSlot(a, b, store) {
    return same(canonicalSubject(a.subject, store), canonicalSubject(b.subject, store))
        && a.predicate === b.predicate && same(a.compatibility, b.compatibility)
        && (a.predicate !== 'entity.alias' || normalizeEntityName(a.object.value) === normalizeEntityName(b.object.value));
}
function equivalent(a, b, store) {
    return a.kind === b.kind && sameSlot(a, b, store)
        && (a.predicate === 'entity.alias' ? normalizeEntityName(a.object.value) === normalizeEntityName(b.object.value) : same(a.object, b.object))
        && same(a.valid_from, b.valid_from) && same(a.valid_to, b.valid_to);
}
function newId(prefix) { return prefix + '_' + randomUUID(); }
function validateProposal(proposal) { validateRememberProposal(proposal); }
/** Domain service over the repository contract; it never constructs trusted prompts. */
export function createMemoryService({ repository, now = () => new Date().toISOString(), idFactory = newId, secretScreen = screenMemorySecret } = {}) {
    if (!repository || !['open', 'readSnapshot', 'commit', 'close'].every(name => typeof repository[name] === 'function')) {
        throw new TypeError('memory_repository_contract_invalid');
    }
    if (typeof now !== 'function' || typeof idFactory !== 'function' || typeof secretScreen !== 'function') throw new TypeError('memory_service_dependency_invalid');
    const retriever = createMemoryRetriever({ readSnapshot: () => repository.readSnapshot() });

    function timestamp() {
        const value = now();
        validateTimestamp(value, 'memory.now');
        return value;
    }
    async function snapshot() { return repository.readSnapshot(); }

    function relationRecord(assertion) { return Boolean(getRelationPredicate(assertion.predicate)) && assertion.object?.type === 'entity_reference'; }
    function relationKey(assertion) { return [assertion.predicate, assertion.subject.id, assertion.object.id].join(':'); }
    function relationProjection(assertion, entityId) {
        return { assertion: structuredClone(assertion), entityId, predicate: assertion.predicate,
            otherEntityId: assertion.subject.id === entityId ? assertion.object.id : assertion.subject.id,
            valid_from: structuredClone(assertion.valid_from), valid_to: structuredClone(assertion.valid_to), trust: { authority: 'data_only' } };
    }

    async function removeAssertions(current, selected) {
        const deletedIds = new Set(selected.map(record => record.id));
        const removedEvidence = current.snapshot.evidence.filter(record => deletedIds.has(record.assertion_id));
        const remainingEvidence = current.snapshot.evidence.filter(record => !deletedIds.has(record.assertion_id));
        const stillUsedSources = new Set(remainingEvidence.map(record => record.source_id));
        const removedSourceIds = new Set(removedEvidence.map(record => record.source_id));
        const orphanSources = current.snapshot.sources.filter(record => removedSourceIds.has(record.id) && !stillUsedSources.has(record.id));
        const changes = [
            ...removedEvidence.map(record => ({ type: 'delete', collection: 'evidence', id: record.id })),
            ...orphanSources.map(record => ({ type: 'delete', collection: 'sources', id: record.id })),
            ...selected.map(record => ({ type: 'delete', collection: 'assertions', id: record.id })),
        ];
        const unlinked = current.snapshot.assertions.filter(record => !deletedIds.has(record.id) && record.supersedes.some(id => deletedIds.has(id)));
        for (const record of unlinked) changes.push({ type: 'put', collection: 'assertions', record: {
            ...record, supersedes: record.supersedes.filter(id => !deletedIds.has(id)),
        } });
        const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes });
        return { success: true, outcome: 'deleted', removedCount: selected.length,
            revision: committed.revision, changedIds: [...deletedIds, ...unlinked.map(record => record.id)],
            invalidateContext: true, trust: { authority: 'data_only' } };
    }

    async function remember(input, authorization) {
        try {
            assertExactObject(input, ['proposal'], 'input');
            validateProposal(input.proposal);
            const proposal = structuredClone(input.proposal);
            consumeMemoryAuthorization(authorization, 'remember', proposal, service);
            const screened = secretScreen(proposal.object.value);
            if (!screened?.safe) return failure('memory_secret_suspected');
            const current = await snapshot();
            const candidates = current.snapshot.assertions.filter(record => record.status === 'active' && sameSlot(record, proposal, current.snapshot));
            if (candidates.length > 1) return failure('memory_ambiguous');
            if (candidates.length === 1 && equivalent(candidates[0], proposal, current.snapshot)
                && (!isEntityName(proposal.predicate) || eligibleNameAssertions(current.snapshot).some(record => record.id === candidates[0].id))) {
                return { success: true, outcome: 'equivalent', id: candidates[0].id, revision: current.revision, changedIds: [], trust: { authority: 'data_only' } };
            }
            const learnedAt = timestamp();
            const assertionId = idFactory('mem'), sourceId = idFactory('src'), evidenceId = idFactory('ev');
            const changes = [];
            if (candidates.length === 1) {
                const previous = candidates[0];
                changes.push({ type: 'put', collection: 'assertions', record: { ...previous, status: 'superseded' } });
            }
            const assertion = {
                id: assertionId, ...structuredClone(proposal),
                status: 'active', recorded_at: learnedAt,
                supersedes: candidates.length === 1 ? [candidates[0].id] : [],
            };
            const source = {
                id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: learnedAt, precision: 'instant' }, recorded_at: learnedAt,
            };
            const evidence = {
                id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
                extraction_confidence: null, learned_at: learnedAt, last_confirmed_at: null, legacy_ref: null,
            };
            validateMemoryRecord('assertions', assertion);
            validateMemoryRecord('sources', source);
            validateMemoryRecord('evidence', evidence);
            changes.push({ type: 'put', collection: 'assertions', record: assertion },
                { type: 'put', collection: 'sources', record: source }, { type: 'put', collection: 'evidence', record: evidence });
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes });
            return {
                success: true, outcome: candidates.length ? 'superseded' : 'created', id: assertionId,
                previousId: candidates[0]?.id ?? null, revision: committed.revision,
                changedIds: [assertionId, sourceId, evidenceId, ...(candidates[0] ? [candidates[0].id] : [])],
                trust: { authority: 'data_only' },
            };
        } catch (error) { return safeFailure(error); }
    }

    async function forget(target, authorization) {
        try {
            validateForgetTarget(target);
            target = structuredClone(target);
            consumeMemoryAuthorization(authorization, 'forget', target, service);
            const current = await snapshot();
            let selected;
            if (target.type === 'assertion') selected = current.snapshot.assertions.filter(record => record.id === target.id);
            else selected = current.snapshot.assertions.filter(record => record.compatibility
                && record.compatibility.category === target.compatibility.category
                && record.compatibility.key === target.compatibility.key);
            if (!selected.length) return failure('memory_not_found');
            if (target.type === 'slot' && new Set(selected.map(record => canonical([canonicalSubject(record.subject, current.snapshot), record.predicate]))).size > 1) return failure('memory_ambiguous');
            return await removeAssertions(current, selected);
        } catch (error) { return safeFailure(error); }
    }

    async function getById(input) {
        try {
            assertExactObject(input, ['id'], 'input');
            const { id } = input;
            validateId(id, 'assertions', 'id');
            const current = await snapshot();
            const record = current.snapshot.assertions.find(item => item.id === id);
            if (!record) return failure('memory_not_found');
            const evidence = current.snapshot.evidence.filter(item => item.assertion_id === id).map(item => ({
                evidence: structuredClone(item), source: structuredClone(current.snapshot.sources.find(source => source.id === item.source_id)),
            }));
            return { success: true, record: structuredClone(record), evidence, revision: current.revision, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function find(query) {
        try {
            assertExactObject(query, ['category', 'key', 'subject', 'predicate', 'includeSuperseded'], 'query');
            const { category, key, subject, predicate, includeSuperseded } = query;
            if (category !== null && !COMPATIBILITY_CATEGORIES.includes(category)) throw new Error();
            if (key !== null && (typeof key !== 'string' || !key.length || !key.isWellFormed() || [...key].length > 128)) throw new Error();
            if (predicate !== null && (typeof predicate !== 'string' || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(predicate))) throw new Error();
            if (subject !== null) validateRememberProposal({
                kind: 'fact', subject, predicate: predicate ?? 'query.subject', object: { type: 'text', value: 'synthetic query' },
                valid_from: null, valid_to: null, compatibility: null,
            });
            if (typeof includeSuperseded !== 'boolean') throw new Error();
            const current = await snapshot();
            const records = current.snapshot.assertions.filter(record => (includeSuperseded || record.status === 'active')
                && (category === null || record.compatibility?.category === category)
                && (key === null || record.compatibility?.key === key)
                && (subject === null || same(canonicalSubject(record.subject, current.snapshot), canonicalSubject(subject, current.snapshot)))
                && (predicate === null || record.predicate === predicate))
                .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            const result = records.map(record => ({
                record: structuredClone(record),
                evidence: current.snapshot.evidence.filter(item => item.assertion_id === record.id).map(item => ({
                    evidence: structuredClone(item), source: structuredClone(current.snapshot.sources.find(source => source.id === item.source_id)),
                })),
            }));
            return { success: true, results: result, revision: current.revision, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function createPerson(request, authorization) {
        try {
            validatePersonCreation(request);
            request = structuredClone(request);
            consumeMemoryAuthorization(authorization, 'create_person', request, service);
            if (!secretScreen(request.preferredName)?.safe) return failure('memory_secret_suspected');
            const current = await snapshot();
            const resolution = resolveEntities(current, { text: request.preferredName });
            if (!request.allowDuplicate && resolution.match === 'exact' && resolution.total > 0) return failure('memory_ambiguous');
            const recordedAt = timestamp();
            const entityId = idFactory('person'), assertionId = idFactory('mem'), sourceId = idFactory('src'), evidenceId = idFactory('ev');
            // Never turn an ID collision into an update of an existing person or record.
            const ids = current.snapshot.entities.concat(current.snapshot.assertions, current.snapshot.sources, current.snapshot.evidence).map(item => item.id);
            if ([entityId, assertionId, sourceId, evidenceId].some(id => ids.includes(id))) return failure('memory_invalid_input');
            const entity = { id: entityId, type: 'person', created_at: recordedAt };
            const assertion = { id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: entityId },
                predicate: 'entity.preferred_name', object: { type: 'text', value: request.preferredName },
                status: 'active', valid_from: null, valid_to: null, recorded_at: recordedAt, supersedes: [], compatibility: null };
            const source = { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only', locator: null,
                occurred_at: { value: recordedAt, precision: 'instant' }, recorded_at: recordedAt };
            const evidence = { id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
                extraction_confidence: null, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null };
            const changes = [['entities', entity], ['assertions', assertion], ['sources', source], ['evidence', evidence]]
                .map(([collection, record]) => ({ type: 'put', collection, record }));
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes });
            return { success: true, outcome: 'created', person: projectPerson(committed.snapshot, entityId),
                revision: committed.revision, changedIds: [entityId, assertionId, sourceId, evidenceId], trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }
    async function getPerson(input) {
        try {
            assertExactObject(input, ['id']); const id = input.id; validateId(id, 'person');
            const current = await snapshot();
            const person = projectPerson(current.snapshot, id);
            return person ? { success: true, person, revision: current.revision, digest: current.digest, trust: { authority: 'data_only' } } : failure('memory_not_found');
        } catch (error) { return safeFailure(error); }
    }
    async function getSelf() {
        try {
            const current = await snapshot();
            return { success: true, person: projectPerson(current.snapshot, current.snapshot.self_person_id),
                revision: current.revision, digest: current.digest, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }
    async function resolvePerson(input) {
        try {
            assertExactObject(input, ['text']); const text = input.text; normalizeEntityName(text);
            return { success: true, ...resolveEntities(await snapshot(), { text }) };
        }
        catch (error) { return safeFailure(error); }
    }

    async function resolveEntityMentions(input) {
        try {
            assertExactObject(input, ['text']);
            return { success: true, ...await retriever.resolveEntityMentions(input.text) };
        } catch (error) { return safeFailure(error); }
    }

    async function retrieveCandidates(query) {
        try { return { success: true, ...await retriever.retrieveCandidates(query) }; }
        catch (error) { return safeFailure(error); }
    }

    async function createRelation(input, authorization) {
        try {
            const request = validateRelationRequest(input);
            consumeMemoryAuthorization(authorization, 'create_relation', request, service);
            const current = await snapshot();
            const entities = new Map(current.snapshot.entities.map(item => [item.id, item]));
            if (entities.get(request.subject.id)?.type !== request.subject.entity_type
                || entities.get(request.object.id)?.type !== request.object.entity_type) return failure('memory_invalid_input');
            const matches = current.snapshot.assertions.filter(record => record.status === 'active' && relationRecord(record)
                && relationKey(record) === relationKey({ ...request, object: { ...request.object, type: 'entity_reference' } })
                && same(record.valid_from, request.valid_from) && same(record.valid_to, request.valid_to));
            if (matches.length > 1) return failure('memory_ambiguous');
            if (matches.length === 1) return { success: true, outcome: 'equivalent', id: matches[0].id,
                revision: current.revision, changedIds: [], trust: { authority: 'data_only' } };
            const recordedAt = timestamp();
            const assertion = { id: idFactory('mem'), kind: 'fact', subject: structuredClone(request.subject),
                predicate: request.predicate, object: structuredClone(request.object), status: 'active',
                valid_from: structuredClone(request.valid_from), valid_to: structuredClone(request.valid_to),
                recorded_at: recordedAt, supersedes: [], compatibility: null };
            const source = { id: idFactory('src'), kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: recordedAt, precision: 'instant' }, recorded_at: recordedAt };
            const evidence = { id: idFactory('ev'), assertion_id: assertion.id, source_id: source.id, derivation: 'explicit',
                extraction_confidence: null, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null };
            const additions = [assertion, source, evidence];
            const knownIds = new Set(current.snapshot.entities.concat(current.snapshot.assertions, current.snapshot.sources, current.snapshot.evidence).map(item => item.id));
            if (additions.some(item => knownIds.has(item.id)) || new Set(additions.map(item => item.id)).size !== additions.length) return failure('memory_invalid_input');
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
                changes: [['assertions', assertion], ['sources', source], ['evidence', evidence]]
                    .map(([collection, record]) => ({ type: 'put', collection, record })) });
            return { success: true, outcome: 'created', id: assertion.id, revision: committed.revision,
                changedIds: additions.map(item => item.id), trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function correctRelation(input, authorization) {
        try {
            const request = validateRelationRequest(input, { correction: true });
            consumeMemoryAuthorization(authorization, 'correct_relation', request, service);
            const current = await snapshot();
            const target = current.snapshot.assertions.find(item => item.id === request.supersedes && item.status === 'active' && relationRecord(item));
            if (!target || target.predicate !== request.predicate) return failure('memory_not_found');
            const endpoints = new Set([request.subject.id, request.object.id]);
            if (!endpoints.has(target.subject.id) && !endpoints.has(target.object.id)) return failure('memory_invalid_input');
            const entities = new Map(current.snapshot.entities.map(item => [item.id, item]));
            if (entities.get(request.subject.id)?.type !== request.subject.entity_type
                || entities.get(request.object.id)?.type !== request.object.entity_type) return failure('memory_invalid_input');
            const existing = current.snapshot.assertions.find(item => item.status === 'active' && item.id !== target.id && relationRecord(item)
                && relationKey(item) === relationKey({ ...request, object: { ...request.object, type: 'entity_reference' } })
                && same(item.valid_from, request.valid_from) && same(item.valid_to, request.valid_to));
            if (existing) return failure('memory_ambiguous');
            const recordedAt = timestamp();
            const assertion = { id: idFactory('mem'), kind: 'fact', subject: structuredClone(request.subject),
                predicate: request.predicate, object: structuredClone(request.object), status: 'active',
                valid_from: structuredClone(request.valid_from), valid_to: structuredClone(request.valid_to), recorded_at: recordedAt,
                supersedes: [target.id], compatibility: null };
            const source = { id: idFactory('src'), kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: recordedAt, precision: 'instant' }, recorded_at: recordedAt };
            const evidence = { id: idFactory('ev'), assertion_id: assertion.id, source_id: source.id, derivation: 'explicit',
                extraction_confidence: null, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null };
            const ids = new Set(current.snapshot.entities.concat(current.snapshot.assertions, current.snapshot.sources, current.snapshot.evidence).map(item => item.id));
            const newIds = [assertion.id, source.id, evidence.id];
            if (newIds.some(id => ids.has(id)) || new Set(newIds).size !== newIds.length) return failure('memory_invalid_input');
            const previous = { ...target, status: 'superseded' };
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
                changes: [['assertions', previous], ['assertions', assertion], ['sources', source], ['evidence', evidence]]
                    .map(([collection, record]) => ({ type: 'put', collection, record })) });
            return { success: true, outcome: 'superseded', id: assertion.id, previousId: target.id,
                revision: committed.revision, changedIds: [assertion.id, source.id, evidence.id, target.id], trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function forgetRelation(input, authorization) {
        try {
            validateRelationForget(input); input = structuredClone(input);
            consumeMemoryAuthorization(authorization, 'forget_relation', input, service);
            const current = await snapshot();
            const selected = current.snapshot.assertions.filter(item => item.id === input.assertionId && relationRecord(item));
            if (!selected.length) return failure('memory_not_found');
            return await removeAssertions(current, selected);
        } catch (error) { return safeFailure(error); }
    }

    async function relationsForEntity(input) {
        try {
            assertExactObject(input, ['entityId', 'predicate']);
            const entityId = input.entityId, predicate = input.predicate;
            validateId(entityId, 'person');
            if (predicate !== null && !getRelationPredicate(predicate)) throw new Error();
            const current = await snapshot();
            if (!current.snapshot.entities.some(item => item.id === entityId)) return failure('memory_not_found');
            const relationships = current.snapshot.assertions.filter(item => item.status === 'active' && relationRecord(item)
                && (predicate === null || item.predicate === predicate) && (item.subject.id === entityId || item.object.id === entityId))
                .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
                .map(item => relationProjection(item, entityId));
            return { success: true, relationships, revision: current.revision, digest: current.digest, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    const service = Object.freeze({ createPerson, getPerson, getSelf, resolvePerson, resolveEntityMentions, retrieveCandidates, createRelation, correctRelation,
        forgetRelation, relationsForEntity, remember, forget, getById, find, open: () => repository.open(), close: () => repository.close() });
    return service;
}
