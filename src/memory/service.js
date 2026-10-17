import { canonicalSubject, normalizeEntityName, projectPerson, isEntityName, eligibleNameAssertions } from './entities.js';
import { resolveEntities } from './entity-resolver.js';
import { createMemoryRetriever } from './retrieval.js';
import { randomUUID } from 'node:crypto';
import { COMPATIBILITY_CATEGORIES, assertExactObject, validateId, validateMemoryRecord, validateTimestamp } from './schema.js';
import { consumeMemoryAuthorization, validateRememberProposal } from './authorization.js';
import { validateForgetTarget, validatePersonCreation, validateRelationRequest, validateRelationForget } from './commands.js';
import { validateRelationshipType } from './schema.js';
import { getRelationPredicate } from './relation-predicates.js';
import { screenMemorySecret } from './secret-screening.js';
import { MemoryRepositoryError } from './repository.js';
import { getOrganicMemoryAttributePolicy, ORGANIC_RELATIONSHIP_ATTRIBUTE, ORGANIC_RELATIONSHIP_SCOPE,
    ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, ORGANIC_THIRD_PARTY_SCOPE, parseDirectOwnerPartnerStatement } from '../core/organic-memory-authorization.js';

const publicErrors = Object.freeze({
    memory_write_not_authorized: 'A matching explicit direct-user memory command is required.',
    memory_secret_suspected: 'This value looks like a credential and was not stored.',
    memory_invalid_input: 'The memory request is invalid.',
    memory_not_found: 'No memory matched the exact target.',
    memory_ambiguous: 'The memory target is ambiguous; no records were changed.',
    memory_operation_failed: 'The memory operation could not be completed.',
    memory_confirmation_expired: 'This memory confirmation expired; no memory was saved.',
    memory_confirmation_invalid: 'No matching memory confirmation is pending; no memory was saved.',
    memory_target_changed: 'The memory changed after review; no update was applied.',
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
function verifiedOrganicThirdPartySubject(current, proposal, evidence) {
    const subjectId = proposal.subject.id;
    if (subjectId === current.snapshot.self_person_id
        || !current.snapshot.entities.some(item => item.id === subjectId && item.type === 'person')) return false;
    if (evidence?.subjectReference) {
        const related = current.snapshot.assertions.filter(item => item.status === 'active'
            && ['partner_of', 'personal_relationship_of'].includes(item.predicate)
            && (item.subject.id === current.snapshot.self_person_id || item.object.id === current.snapshot.self_person_id)
            && (item.predicate === 'partner_of' ? evidence.subjectReference === 'pareja'
                : item.relationship_type?.label === evidence.subjectReference));
        const ids = new Set(related.map(item => item.subject.id === current.snapshot.self_person_id
            ? item.object.id : item.subject.id));
        return ids.size === 1 && ids.has(subjectId);
    }
    const resolution = resolveEntities(current, { text: evidence?.subjectName });
    return resolution.status === 'resolved' && resolution.entityId === subjectId;
}
/** Domain service over the repository contract; it never constructs trusted prompts. */
export function createMemoryService({ repository, now = () => new Date().toISOString(), idFactory = newId,
    secretScreen = screenMemorySecret, organicMemoryAuthorizationFactory = null } = {}) {
    if (!repository || !['open', 'readSnapshot', 'commit', 'close'].every(name => typeof repository[name] === 'function')) {
        throw new TypeError('memory_repository_contract_invalid');
    }
    if (typeof now !== 'function' || typeof idFactory !== 'function' || typeof secretScreen !== 'function'
        || (organicMemoryAuthorizationFactory !== null && typeof organicMemoryAuthorizationFactory !== 'function'))
        throw new TypeError('memory_service_dependency_invalid');
    const retriever = createMemoryRetriever({ readSnapshot: () => repository.readSnapshot(), now });
    let pendingExplicitRemember = null;
    let organicMemoryAuthorization = null;

    function timestamp() {
        const value = now();
        validateTimestamp(value, 'memory.now');
        return value;
    }
    async function snapshot() { return repository.readSnapshot(); }

    function relationRecord(assertion) { return Boolean(getRelationPredicate(assertion.predicate)) && assertion.object?.type === 'entity_reference'; }
    function relationKey(assertion) { return canonical([assertion.predicate, assertion.subject.id, assertion.object.id,
        assertion.relationship_type ?? null]); }
    function sameRelationshipIdentity(existing, requested) {
        if (relationKey(existing) === relationKey(requested)) return true;
        const legacyPartner = existing.predicate === 'partner_of' ? existing : requested.predicate === 'partner_of' ? requested : null;
        const typedPartner = existing.predicate === 'personal_relationship_of' ? existing
            : requested.predicate === 'personal_relationship_of' ? requested : null;
        if (!legacyPartner || !typedPartner || typedPartner.relationship_type?.category !== 'partner') return false;
        return [legacyPartner.subject.id, legacyPartner.object.id].sort().join(':')
            === [typedPartner.subject.id, typedPartner.object.id].sort().join(':');
    }
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

    async function persistRememberProposal(proposal, { derivation = 'explicit', extractionConfidence = null, preCommit = null,
        expectedActiveAssertionId = undefined } = {}) {
        try {
            const current = await snapshot();
            const candidates = current.snapshot.assertions.filter(record => record.status === 'active' && sameSlot(record, proposal, current.snapshot));
            if (candidates.length > 1) return failure('memory_ambiguous');
            if (expectedActiveAssertionId !== undefined
                && (expectedActiveAssertionId === null ? candidates.length !== 0
                    : typeof expectedActiveAssertionId !== 'string' || candidates.length !== 1
                        || candidates[0].id !== expectedActiveAssertionId)) return failure('memory_conflict');
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
            const assertion = { id: assertionId, ...structuredClone(proposal), status: 'active', recorded_at: learnedAt,
                supersedes: candidates.length === 1 ? [candidates[0].id] : [] };
            const source = { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: learnedAt, precision: 'instant' }, recorded_at: learnedAt };
            const evidence = { id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation,
                extraction_confidence: extractionConfidence, learned_at: learnedAt, last_confirmed_at: null, legacy_ref: null };
            validateMemoryRecord('assertions', assertion);
            validateMemoryRecord('sources', source);
            validateMemoryRecord('evidence', evidence);
            changes.push({ type: 'put', collection: 'assertions', record: assertion },
                { type: 'put', collection: 'sources', record: source }, { type: 'put', collection: 'evidence', record: evidence });
            if (preCommit) {
                let allowed = false;
                try { allowed = preCommit(current) === true; } catch { /* A stale grant fails closed. */ }
                if (!allowed) return failure('memory_write_not_authorized');
            }
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes });
            return { success: true, outcome: candidates.length ? 'superseded' : 'created', id: assertionId,
                previousId: candidates[0]?.id ?? null, revision: committed.revision,
                changedIds: [assertionId, sourceId, evidenceId, ...(candidates[0] ? [candidates[0].id] : [])],
                trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function persistOrganicProposal(input, authorization, evidence) {
        try {
            if (input?.operation === 'remember_relationship')
                return input.attribute === ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE
                    ? await persistOrganicTypedRelationship(input, authorization, evidence)
                    : await persistOrganicPartnerRelation(input, authorization, evidence);
            if ((authorization?.syntheticOnly !== true && authorization?.ownerOnly !== true)
                || !['remember', 'update'].includes(input?.operation)
                || !getOrganicMemoryAttributePolicy(input?.attribute)
                || (input.scope !== ORGANIC_THIRD_PARTY_SCOPE
                    && getOrganicMemoryAttributePolicy(input.attribute)?.scope !== input.scope))
                return failure('memory_write_not_authorized');
            const proposal = structuredClone(evidence?.proposal);
            validateProposal(proposal);
            const attributePolicy = getOrganicMemoryAttributePolicy(input.attribute);
            const thirdParty = input.scope === ORGANIC_THIRD_PARTY_SCOPE;
            if (!attributePolicy || proposal.kind !== attributePolicy.kind
                || (thirdParty ? proposal.subject?.type !== 'entity' || proposal.subject?.entity_type !== 'person'
                    : proposal.subject?.type !== 'owner')
                || proposal.predicate !== attributePolicy.predicate || proposal.compatibility?.category !== attributePolicy.category
                || proposal.compatibility?.key !== input.attribute || proposal.valid_from !== null || proposal.valid_to !== null
                || typeof evidence?.extractionConfidence !== 'number' || !Number.isFinite(evidence.extractionConfidence)
                || evidence.extractionConfidence < 0.9 || evidence.extractionConfidence > 1)
                return failure('memory_invalid_input');
            if (thirdParty) {
                const current = await snapshot();
                if (!verifiedOrganicThirdPartySubject(current, proposal, evidence)) return failure('memory_ambiguous');
            }
            if (!secretScreen(proposal.object.value)?.safe) return failure('memory_secret_suspected');
            const expectedActiveAssertionId = Object.hasOwn(evidence ?? {}, 'expectedPriorAssertionId')
                ? evidence.expectedPriorAssertionId : undefined;
            if (expectedActiveAssertionId !== undefined && expectedActiveAssertionId !== null
                && typeof expectedActiveAssertionId !== 'string') return failure('memory_invalid_input');
            return await persistRememberProposal(proposal, { derivation: 'inferred', extractionConfidence: evidence.extractionConfidence,
                expectedActiveAssertionId,
                preCommit: current => organicMemoryAuthorization?.verify(input)?.allowed === true
                    && (!thirdParty || verifiedOrganicThirdPartySubject(current, proposal, evidence)) });
        } catch (error) { return safeFailure(error); }
    }

    /** Persist a directly stated owner↔partner edge and, when needed, its person/name
     * records in one repository commit. The capability carries the verified literal
     * quote transiently; only opaque source metadata is persisted. */
    async function persistOrganicPartnerRelation(input, authorization, evidence) {
        if ((authorization?.syntheticOnly !== true && authorization?.ownerOnly !== true)
            || input?.scope !== ORGANIC_RELATIONSHIP_SCOPE || input?.attribute !== ORGANIC_RELATIONSHIP_ATTRIBUTE
            || evidence?.origin !== 'direct_user' || evidence?.subject !== 'owner' || evidence?.explicit !== true
            || evidence?.certain !== true || evidence?.sensitive !== false || evidence?.ambiguous !== false
            || evidence?.thirdParty !== false || evidence?.modelOriginated !== false
            || typeof evidence?.preferredName !== 'string' || typeof evidence?.sourceQuote !== 'string'
            || typeof evidence?.userMessage !== 'string' || !evidence.userMessage.includes(evidence.sourceQuote))
            return failure('memory_write_not_authorized');
        const parsed = parseDirectOwnerPartnerStatement(evidence.sourceQuote);
        if (!parsed || normalizeEntityName(parsed.preferredName) !== normalizeEntityName(evidence.preferredName)
            || !secretScreen(evidence.preferredName)?.safe) return failure('memory_invalid_input');

        try {
            const current = await snapshot();
            const resolution = resolveEntities(current, { text: evidence.preferredName });
            if (resolution.status === 'ambiguous' || resolution.status === 'insufficient_evidence') return failure('memory_ambiguous');
            let personId = resolution.status === 'resolved' ? resolution.entityId : null;
            const createPerson = personId === null;
            if (personId === current.snapshot.self_person_id) return failure('memory_invalid_input');
            const targetPersonId = personId ?? idFactory('person');
            const ownerId = current.snapshot.self_person_id;
            const activePartners = current.snapshot.assertions.filter(record => record.status === 'active'
                && record.predicate === 'partner_of' && (record.subject.id === ownerId || record.object.id === ownerId));
            const samePartner = activePartners.some(record => record.subject.id === targetPersonId || record.object.id === targetPersonId);
            if (activePartners.some(record => record.subject.id !== targetPersonId && record.object.id !== targetPersonId)) {
                return { success: false, outcome: 'needs_clarification',
                    error: { code: 'memory_relationship_conflict', message: 'An active partner relationship already exists.' } };
            }
            if (samePartner) {
                const matching = activePartners.filter(record => record.subject.id === targetPersonId || record.object.id === targetPersonId);
                if (matching.length !== 1) return failure('memory_ambiguous');
                return { success: true, outcome: 'equivalent', id: matching[0].id,
                    revision: current.revision, changedIds: [], trust: { authority: 'data_only' } };
            }

            const recordedAt = timestamp();
            const sourceId = idFactory('src');
            const relationId = idFactory('mem');
            const relationEvidenceId = idFactory('ev');
            const changes = [];
            const createdIds = [];
            if (createPerson) {
                const person = { id: targetPersonId, type: 'person', created_at: recordedAt };
                const nameAssertion = { id: idFactory('mem'), kind: 'fact',
                    subject: { type: 'entity', entity_type: 'person', id: targetPersonId }, predicate: 'entity.preferred_name',
                    object: { type: 'text', value: evidence.preferredName.trim().replace(/\s+/gu, ' ') }, status: 'active',
                    valid_from: null, valid_to: null, recorded_at: recordedAt, supersedes: [], compatibility: null };
                const nameEvidence = { id: idFactory('ev'), assertion_id: nameAssertion.id, source_id: sourceId,
                    derivation: 'explicit', extraction_confidence: null, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null };
                validateMemoryRecord('entities', person);
                validateMemoryRecord('assertions', nameAssertion);
                validateMemoryRecord('evidence', nameEvidence);
                changes.push({ type: 'put', collection: 'entities', record: person },
                    { type: 'put', collection: 'assertions', record: nameAssertion },
                    { type: 'put', collection: 'evidence', record: nameEvidence });
                createdIds.push(person.id, nameAssertion.id, nameEvidence.id);
                personId = targetPersonId;
            }
            const request = validateRelationRequest({ predicate: 'partner_of',
                subject: { type: 'entity', entity_type: 'person', id: ownerId },
                object: { type: 'entity_reference', entity_type: 'person', id: personId }, valid_from: null, valid_to: null });
            const relation = { id: relationId, kind: 'fact', subject: request.subject, predicate: request.predicate,
                object: request.object, status: 'active', valid_from: null, valid_to: null, recorded_at: recordedAt,
                supersedes: [], compatibility: null };
            const source = { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: recordedAt, precision: 'instant' }, recorded_at: recordedAt };
            const relationEvidence = { id: relationEvidenceId, assertion_id: relation.id, source_id: sourceId,
                derivation: 'explicit', extraction_confidence: null, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null };
            validateMemoryRecord('assertions', relation);
            validateMemoryRecord('sources', source);
            validateMemoryRecord('evidence', relationEvidence);
            changes.push({ type: 'put', collection: 'assertions', record: relation },
                { type: 'put', collection: 'sources', record: source },
                { type: 'put', collection: 'evidence', record: relationEvidence });
            const allIds = current.snapshot.entities.concat(current.snapshot.assertions, current.snapshot.sources, current.snapshot.evidence)
                .map(record => record.id);
            const newIds = changes.filter(change => change.type === 'put').map(change => change.record.id);
            if (newIds.some(id => allIds.includes(id)) || new Set(newIds).size !== newIds.length) return failure('memory_invalid_input');
            if (organicMemoryAuthorization?.verify(input)?.allowed !== true) return failure('memory_write_not_authorized');
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes });
            return { success: true, outcome: 'created', id: relation.id, personId,
                revision: committed.revision, changedIds: [...createdIds, source.id, relation.id, relationEvidence.id],
                trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    /**
     * Internal-only typed relationship writer. It requires an opaque capability
     * whose trusted issuer attests that a semantic verifier checked the exact
     * current-user evidence. No production issuer currently mints this proof;
     * 05D must add that verifier before agent-driven writes can be enabled.
     */
    async function persistOrganicTypedRelationship(input, authorization, evidence) {
        const relationshipType = evidence?.relationshipType;
        if ((authorization?.syntheticOnly !== true && authorization?.ownerOnly !== true)
            || input?.scope !== ORGANIC_RELATIONSHIP_SCOPE || input?.attribute !== ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE
            || evidence?.origin !== 'direct_user' || evidence?.subject !== 'owner' || evidence?.explicit !== true
            || evidence?.certain !== true || evidence?.sensitive !== false || evidence?.ambiguous !== false
            || evidence?.thirdParty !== false || evidence?.modelOriginated !== false
            || evidence?.semanticEvidenceVerified !== 'direct_owner_relationship_v1'
            || !['family', 'partner', 'friend'].includes(relationshipType?.category)
            || typeof evidence?.preferredName !== 'string' || typeof evidence?.sourceQuote !== 'string'
            || typeof evidence?.userMessage !== 'string' || evidence.sourceQuote.length < 3
            || evidence.sourceQuote.length > 500 || !evidence.userMessage.includes(evidence.sourceQuote))
            return failure('memory_write_not_authorized');

        try {
            validateRelationshipType(relationshipType, 'evidence.relationshipType');
            const quote = evidence.sourceQuote.trim();
            const standalone = evidence.userMessage.split(/(?<=[.!?])\s+|\r?\n/u)
                .some(sentence => sentence.trim() === quote);
            const normalizeEvidenceText = value => value.normalize('NFD').replace(/\p{M}/gu, '')
                .toLocaleLowerCase('es').replace(/\s+/gu, ' ').trim();
            const containsPhrase = (text, phrase) => {
                const normalizedText = normalizeEvidenceText(text), normalizedPhrase = normalizeEvidenceText(phrase);
                const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
                return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(normalizedText);
            };
            // The opaque evidence capability attests semantic verification of the
            // normalized label, including inflections absent from the literal quote.
            if (!secretScreen(evidence.preferredName)?.safe
                || !containsPhrase(quote, evidence.preferredName)
                || !/(?:^|[^\p{L}\p{N}])(?:mi|mis|me|yo|tengo|somos|soy)(?=$|[^\p{L}\p{N}])/iu.test(quote))
                return failure('memory_invalid_input');

            const current = await snapshot();
            const resolution = resolveEntities(current, { text: evidence.preferredName });
            if (resolution.status === 'ambiguous' || resolution.status === 'insufficient_evidence') return failure('memory_ambiguous');
            const ownerId = current.snapshot.self_person_id;
            const personId = resolution.status === 'resolved' ? resolution.entityId : idFactory('person');
            if (personId === ownerId) return failure('memory_invalid_input');

            const request = validateRelationRequest({ predicate: 'personal_relationship_of',
                subject: { type: 'entity', entity_type: 'person', id: ownerId },
                object: { type: 'entity_reference', entity_type: 'person', id: personId },
                relationship_type: structuredClone(relationshipType), valid_from: null, valid_to: null });
            const existing = current.snapshot.assertions.filter(record => record.status === 'active'
                && record.object?.type === 'entity_reference' && sameRelationshipIdentity(record, request)
                && same(record.valid_from, request.valid_from) && same(record.valid_to, request.valid_to));
            if (existing.length > 1) return failure('memory_ambiguous');
            if (existing.length === 1) return { success: true, outcome: 'equivalent', id: existing[0].id,
                revision: current.revision, changedIds: [], trust: { authority: 'data_only' } };
            if (relationshipType.category === 'partner') {
                const activePartners = current.snapshot.assertions.filter(record => record.status === 'active'
                    && (record.predicate === 'partner_of'
                        || (record.predicate === 'personal_relationship_of' && record.relationship_type?.category === 'partner'))
                    && (record.subject.id === ownerId || record.object.id === ownerId));
                if (activePartners.some(record => record.subject.id !== personId && record.object.id !== personId)) {
                    return { success: false, outcome: 'needs_clarification',
                        error: { code: 'memory_relationship_conflict', message: 'An active partner relationship already exists.' } };
                }
            }

            const recordedAt = timestamp();
            const sourceId = idFactory('src'), relationId = idFactory('mem'), relationEvidenceId = idFactory('ev');
            const changes = [], createdIds = [];
            if (resolution.status !== 'resolved') {
                const person = { id: personId, type: 'person', created_at: recordedAt };
                const nameAssertion = { id: idFactory('mem'), kind: 'fact',
                    subject: { type: 'entity', entity_type: 'person', id: personId }, predicate: 'entity.preferred_name',
                    object: { type: 'text', value: evidence.preferredName.trim().replace(/\s+/gu, ' ') }, status: 'active',
                    valid_from: null, valid_to: null, recorded_at: recordedAt, supersedes: [], compatibility: null };
                const nameEvidence = { id: idFactory('ev'), assertion_id: nameAssertion.id, source_id: sourceId,
                    derivation: 'explicit', extraction_confidence: null, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null };
                validateMemoryRecord('entities', person);
                validateMemoryRecord('assertions', nameAssertion);
                validateMemoryRecord('evidence', nameEvidence);
                changes.push({ type: 'put', collection: 'entities', record: person },
                    { type: 'put', collection: 'assertions', record: nameAssertion },
                    { type: 'put', collection: 'evidence', record: nameEvidence });
                createdIds.push(person.id, nameAssertion.id, nameEvidence.id);
            }
            const relation = { id: relationId, kind: 'fact', subject: request.subject, predicate: request.predicate,
                object: request.object, relationship_type: request.relationship_type, status: 'active',
                valid_from: null, valid_to: null, recorded_at: recordedAt, supersedes: [], compatibility: null };
            const source = { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: recordedAt, precision: 'instant' }, recorded_at: recordedAt };
            const relationEvidence = { id: relationEvidenceId, assertion_id: relationId, source_id: sourceId,
                derivation: 'explicit', extraction_confidence: null, learned_at: recordedAt,
                last_confirmed_at: null, legacy_ref: null };
            validateMemoryRecord('assertions', relation);
            validateMemoryRecord('sources', source);
            validateMemoryRecord('evidence', relationEvidence);
            changes.push({ type: 'put', collection: 'assertions', record: relation },
                { type: 'put', collection: 'sources', record: source },
                { type: 'put', collection: 'evidence', record: relationEvidence });
            const knownIds = new Set(current.snapshot.entities.concat(current.snapshot.assertions, current.snapshot.sources, current.snapshot.evidence)
                .map(record => record.id));
            const newIds = changes.filter(change => change.type === 'put').map(change => change.record.id);
            if (newIds.some(id => knownIds.has(id)) || new Set(newIds).size !== newIds.length) return failure('memory_invalid_input');
            const grantInput = { scope: ORGANIC_RELATIONSHIP_SCOPE, operation: 'remember_relationship',
                attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, evidenceCapability: input.evidenceCapability };
            if (organicMemoryAuthorization?.verify(grantInput)?.allowed !== true) return failure('memory_write_not_authorized');
            const committed = await repository.commit({ expectedRevision: current.revision,
                expectedDigest: current.digest, changes });
            return { success: true, outcome: 'created', id: relationId, personId,
                revision: committed.revision, changedIds: [...createdIds, sourceId, relationId, relationEvidenceId],
                trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function rememberOrganic(input) {
        if (!organicMemoryAuthorization) return failure('memory_write_not_authorized');
        try {
            const result = await organicMemoryAuthorization.persistIfAuthorized(input);
            return result.success ? result.result : failure('memory_write_not_authorized');
        } catch { return failure('memory_operation_failed'); }
    }

    /** Internal service entry point for a future trusted extractor. Not registered as an agent tool. */
    async function rememberOrganicRelationship(evidenceCapability) {
        if (!organicMemoryAuthorization) return failure('memory_write_not_authorized');
        return rememberOrganic({ scope: ORGANIC_RELATIONSHIP_SCOPE, operation: 'remember_relationship',
            attribute: ORGANIC_RELATIONSHIP_ATTRIBUTE, evidenceCapability });
    }

    /** Closed internal entry point for a future semantically verified relationship extractor. */
    async function rememberOrganicTypedRelationship(evidenceCapability) {
        if (!organicMemoryAuthorization) return failure('memory_write_not_authorized');
        return rememberOrganic({ scope: ORGANIC_RELATIONSHIP_SCOPE, operation: 'remember_relationship',
            attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, evidenceCapability });
    }

    async function remember(input, authorization) {
        try {
            assertExactObject(input, ['proposal'], 'input');
            validateProposal(input.proposal);
            const proposal = structuredClone(input.proposal);
            consumeMemoryAuthorization(authorization, 'remember', proposal, service);
            if (!secretScreen(proposal.object.value)?.safe) return failure('memory_secret_suspected');
            return await persistRememberProposal(proposal);
        } catch (error) { return safeFailure(error); }
    }

    /** One pending proposal per service, which is scoped to one Runtime agent/session.
     * This is only for explicit direct-user confirmation and is not a model tool. */
    function prepareConfirmedRemember(proposalInput) {
        try {
            validateProposal(proposalInput);
            const proposal = structuredClone(proposalInput);
            if (!secretScreen(proposal.object.value)?.safe) return failure('memory_secret_suspected');
            if (/[\p{Cc}\p{Cf}]/u.test(proposal.object.value)) return failure('memory_invalid_input');
            const proposalId = 'memprop_' + randomUUID();
            pendingExplicitRemember = { operation: 'remember', proposalId, proposal, expiresAt: Date.now() + 120_000 };
            return { success: true, proposalId, value: proposal.object.value };
        } catch (error) { return safeFailure(error); }
    }

    async function prepareConfirmedUpdate(input) {
        try {
            assertExactObject(input, ['targetId', 'value'], 'update');
            validateId(input.targetId, 'assertions', 'update.targetId');
            if (typeof input.value !== 'string' || !input.value.isWellFormed()) throw new Error();
            if (!secretScreen(input.value)?.safe || /[\p{Cc}\p{Cf}]/u.test(input.value)) return failure('memory_secret_suspected');
            const current = await snapshot();
            const target = current.snapshot.assertions.find(record => record.id === input.targetId && record.status === 'active');
            if (!target) return failure('memory_not_found');
            if (target.object?.type !== 'text') return failure('memory_invalid_input');
            const candidates = current.snapshot.assertions.filter(record => record.status === 'active'
                && sameSlot(record, target, current.snapshot));
            if (candidates.length !== 1 || candidates[0].id !== target.id) return failure('memory_ambiguous');
            const proposal = { kind: target.kind, subject: structuredClone(target.subject), predicate: target.predicate,
                object: { type: 'text', value: input.value }, valid_from: structuredClone(target.valid_from),
                valid_to: structuredClone(target.valid_to), compatibility: structuredClone(target.compatibility) };
            validateProposal(proposal);
            if (equivalent(target, proposal, current.snapshot)) {
                return { success: true, outcome: 'equivalent', targetId: target.id,
                    previousValue: target.object.value, value: input.value, revision: current.revision };
            }
            const proposalId = 'memupd_' + randomUUID();
            pendingExplicitRemember = { operation: 'update', proposalId, proposal, target: structuredClone(target),
                expiresAt: Date.now() + 120_000 };
            return { success: true, proposalId, targetId: target.id, previousValue: target.object.value, value: input.value };
        } catch (error) { return safeFailure(error); }
    }

    async function confirmPreparedUpdate(proposalId) {
        if (!pendingExplicitRemember || pendingExplicitRemember.operation !== 'update'
            || pendingExplicitRemember.proposalId !== proposalId) return failure('memory_confirmation_invalid');
        const pending = pendingExplicitRemember;
        pendingExplicitRemember = null;
        if (Date.now() >= pending.expiresAt) return failure('memory_confirmation_expired');
        try {
            const current = await snapshot();
            const target = current.snapshot.assertions.find(record => record.id === pending.target.id && record.status === 'active');
            if (!target || !same(target, pending.target)) return failure('memory_target_changed');
            const candidates = current.snapshot.assertions.filter(record => record.status === 'active'
                && sameSlot(record, target, current.snapshot));
            if (candidates.length !== 1 || candidates[0].id !== target.id) return failure('memory_ambiguous');
            const learnedAt = timestamp();
            const assertionId = idFactory('mem'), sourceId = idFactory('src'), evidenceId = idFactory('ev');
            const knownIds = new Set(current.snapshot.entities.concat(current.snapshot.assertions, current.snapshot.sources, current.snapshot.evidence).map(item => item.id));
            if ([assertionId, sourceId, evidenceId].some(id => knownIds.has(id))
                || new Set([assertionId, sourceId, evidenceId]).size !== 3) return failure('memory_invalid_input');
            const assertion = { id: assertionId, ...structuredClone(pending.proposal), status: 'active', recorded_at: learnedAt,
                supersedes: [target.id] };
            const previous = { ...target, status: 'superseded' };
            const source = { id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: { value: learnedAt, precision: 'instant' }, recorded_at: learnedAt };
            const evidence = { id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
                extraction_confidence: null, learned_at: learnedAt, last_confirmed_at: null, legacy_ref: null };
            validateMemoryRecord('assertions', previous);
            validateMemoryRecord('assertions', assertion);
            validateMemoryRecord('sources', source);
            validateMemoryRecord('evidence', evidence);
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
                changes: [['assertions', previous], ['assertions', assertion], ['sources', source], ['evidence', evidence]]
                    .map(([collection, record]) => ({ type: 'put', collection, record })) });
            return { success: true, outcome: 'superseded', id: assertionId, previousId: target.id,
                revision: committed.revision, changedIds: [assertionId, sourceId, evidenceId, target.id],
                invalidateContext: true, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    async function confirmPreparedRemember(proposalId) {
        if (!pendingExplicitRemember || pendingExplicitRemember.operation !== 'remember'
            || pendingExplicitRemember.proposalId !== proposalId) return failure('memory_confirmation_invalid');
        const pending = pendingExplicitRemember;
        pendingExplicitRemember = null; // Consume before I/O so retries cannot duplicate the write.
        if (Date.now() >= pending.expiresAt) return failure('memory_confirmation_expired');
        const result = await persistRememberProposal(pending.proposal);
        return result.success ? { ...result, invalidateContext: true } : result;
    }

    function cancelPreparedRemember(proposalId) {
        if (!pendingExplicitRemember || pendingExplicitRemember.operation !== 'remember'
            || pendingExplicitRemember.proposalId !== proposalId) return false;
        pendingExplicitRemember = null;
        return true;
    }

    function cancelPreparedUpdate(proposalId) {
        if (!pendingExplicitRemember || pendingExplicitRemember.operation !== 'update'
            || pendingExplicitRemember.proposalId !== proposalId) return false;
        pendingExplicitRemember = null;
        return true;
    }

    async function prepareConfirmedForget(input) {
        try {
            assertExactObject(input, ['targetId'], 'forget');
            validateId(input.targetId, 'assertions', 'forget.targetId');
            const current = await snapshot();
            const target = current.snapshot.assertions.find(record => record.id === input.targetId && record.status === 'active');
            if (!target) return failure('memory_not_found');
            const slot = current.snapshot.assertions.filter(record => record.status === 'active'
                && sameSlot(record, target, current.snapshot));
            if (slot.length !== 1) return failure('memory_ambiguous');
            const proposalId = 'memforget_' + randomUUID();
            pendingExplicitRemember = { operation: 'forget', proposalId, target: structuredClone(target),
                revision: current.revision, digest: current.digest, expiresAt: Date.now() + 120_000 };
            return { success: true, proposalId, targetId: target.id, value: target.object.value };
        } catch (error) { return safeFailure(error); }
    }

    async function confirmPreparedForget(proposalId) {
        if (!pendingExplicitRemember || pendingExplicitRemember.operation !== 'forget'
            || pendingExplicitRemember.proposalId !== proposalId) return failure('memory_confirmation_invalid');
        const pending = pendingExplicitRemember;
        pendingExplicitRemember = null;
        if (Date.now() >= pending.expiresAt) return failure('memory_confirmation_expired');
        try {
            const current = await snapshot();
            const target = current.snapshot.assertions.find(record => record.id === pending.target.id && record.status === 'active');
            if (current.revision !== pending.revision || current.digest !== pending.digest
                || !target || !same(target, pending.target)) return failure('memory_target_changed');
            const slot = current.snapshot.assertions.filter(record => record.status === 'active'
                && sameSlot(record, target, current.snapshot));
            if (slot.length !== 1 || slot[0].id !== target.id) return failure('memory_ambiguous');
            const recordedAt = timestamp();
            const forgotten = { ...target, status: 'superseded', valid_to: { value: recordedAt, precision: 'instant' } };
            validateMemoryRecord('assertions', forgotten);
            const committed = await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
                changes: [{ type: 'put', collection: 'assertions', record: forgotten }] });
            return { success: true, outcome: 'forgotten', targetId: target.id, revision: committed.revision,
                changedIds: [target.id], invalidateContext: true, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    function cancelPreparedForget(proposalId) {
        if (!pendingExplicitRemember || pendingExplicitRemember.operation !== 'forget'
            || pendingExplicitRemember.proposalId !== proposalId) return false;
        pendingExplicitRemember = null;
        return true;
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
                forgotten: record.status === 'superseded' && record.valid_to !== null,
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

    async function currentKnowledge(query) {
        try { return { success: true, ...await retriever.currentKnowledge(query) }; }
        catch (error) { return safeFailure(error); }
    }

    async function knowledgeValidAt(query, validTime) {
        try { return { success: true, ...await retriever.knowledgeValidAt(query, validTime) }; }
        catch (error) { return safeFailure(error); }
    }

    async function history(query) {
        try { return { success: true, ...await retriever.history(query) }; }
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
                && sameRelationshipIdentity(record, { ...request, object: { ...request.object, type: 'entity_reference' } })
                && same(record.valid_from, request.valid_from) && same(record.valid_to, request.valid_to));
            if (matches.length > 1) return failure('memory_ambiguous');
            if (matches.length === 1) return { success: true, outcome: 'equivalent', id: matches[0].id,
                revision: current.revision, changedIds: [], trust: { authority: 'data_only' } };
            const recordedAt = timestamp();
            const assertion = { id: idFactory('mem'), kind: 'fact', subject: structuredClone(request.subject),
                predicate: request.predicate, object: structuredClone(request.object), status: 'active',
                ...(request.relationship_type ? { relationship_type: structuredClone(request.relationship_type) } : {}),
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
                && sameRelationshipIdentity(item, { ...request, object: { ...request.object, type: 'entity_reference' } })
                && same(item.valid_from, request.valid_from) && same(item.valid_to, request.valid_to));
            if (existing) return failure('memory_ambiguous');
            const recordedAt = timestamp();
            const assertion = { id: idFactory('mem'), kind: 'fact', subject: structuredClone(request.subject),
                predicate: request.predicate, object: structuredClone(request.object), status: 'active',
                ...(request.relationship_type ? { relationship_type: structuredClone(request.relationship_type) } : {}),
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

    async function clearAllMemories() {
        if (typeof repository.clearMemoryData !== 'function') return failure('memory_operation_failed');
        try {
            const result = await repository.clearMemoryData();
            return { success: true, outcome: 'cleared', revision: result.revision,
                removedCount: Object.values(result.removed).reduce((sum, value) => sum + value, 0),
                invalidateContext: true, trust: { authority: 'data_only' } };
        } catch (error) { return safeFailure(error); }
    }

    if (organicMemoryAuthorizationFactory) {
        organicMemoryAuthorization = organicMemoryAuthorizationFactory({ repository, persist: persistOrganicProposal });
        if (typeof organicMemoryAuthorization?.persistIfAuthorized !== 'function')
            throw new TypeError('organic_memory_authorization_contract_invalid');
    }

    const service = Object.freeze({ createPerson, getPerson, getSelf, resolvePerson, resolveEntityMentions, retrieveCandidates,
        currentKnowledge, knowledgeValidAt, history, createRelation, correctRelation,
        forgetRelation, relationsForEntity, remember, rememberOrganic, rememberOrganicRelationship, rememberOrganicTypedRelationship,
        prepareConfirmedRemember, confirmPreparedRemember, cancelPreparedRemember,
        prepareConfirmedUpdate, confirmPreparedUpdate, cancelPreparedUpdate,
        prepareConfirmedForget, confirmPreparedForget, cancelPreparedForget,
        forget, getById, find, clearAllMemories, open: () => repository.open(), close: () => repository.close() });
    return service;
}
