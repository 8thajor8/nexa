import { createHash } from 'node:crypto';
import { canonicalSubject } from '../entities.js';
import { validateMemoryStore } from '../schema.js';
import { evaluateAutomaticMemoryPolicy, snapshotFingerprint } from './policy.js';
import { normalizeAutomaticMemoryProposal, validateAutomaticMemoryCandidates } from './schema.js';

export const AUTOMATIC_MEMORY_PLAN_VERSION = 'automatic-memory-b1-dry-run';

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key))) return false;
    return keys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    });
}

function normalizedText(value) {
    return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und');
}

function includesExactText(haystack, needle) {
    const source = normalizedText(haystack), fragment = normalizedText(needle);
    return fragment.length > 0 && source.includes(fragment);
}

function validSnapshotEnvelope(envelope) {
    if (!exactRecord(envelope, ['snapshot', 'revision', 'digest'])
        || !Number.isSafeInteger(envelope.revision) || envelope.revision < 0
        || typeof envelope.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(envelope.digest)) return false;
    try { validateMemoryStore(envelope.snapshot); } catch { return false; }
    return envelope.revision === envelope.snapshot.revision
        && envelope.digest === snapshotFingerprint(envelope);
}

function isStructuralSelf(subjectText, snapshot) {
    return normalizedText(subjectText ?? '') === 'user'
        && snapshot?.snapshot.self_person_id
        && snapshot.snapshot.entities.some(entity => entity.id === snapshot.snapshot.self_person_id && entity.type === 'person');
}

function activeSelfAssertions(snapshot, predicate) {
    if (!snapshot) return [];
    const selfId = snapshot.snapshot.self_person_id;
    return snapshot.snapshot.assertions.filter(record => record.status === 'active' && record.predicate === predicate
        && canonicalSubject(record.subject, snapshot.snapshot).id === selfId);
}

function operation(type, candidateIndex, reasonCodes, extra = {}) {
    return { candidateIndex, operation: type, reasonCodes, confirmationRequired: type === 'ASK' || type === 'REPLACE',
        writeReady: false, ...extra };
}

function planOne(candidate, validated, policyResult, snapshot) {
    if (policyResult.disposition === 'ignore') {
        if (policyResult.reasonCodes.includes('duplicate_active_assertion'))
            return operation('DUPLICATE', validated.index, policyResult.reasonCodes);
        return operation('IGNORE', validated.index, policyResult.reasonCodes);
    }

    if (policyResult.disposition === 'ask') {
        const correction = ['possible_correction', 'possible_supersession'].includes(candidate.update_intent)
            && policyResult.reasonCodes.includes('correction_requires_explicit_target_review');
        if (!correction) return operation('ASK', validated.index, policyResult.reasonCodes);

        if (candidate.assertion_mode !== 'asserted' || validated.evidence.quotedOrImported
            || policyResult.sensitivity !== 'none' || candidate.temporal_hints.certainty !== 'none'
            || candidate.temporal_hints.raw_text !== null || !snapshot
            || !isStructuralSelf(candidate.subject_text, snapshot) || candidate.mentioned_person_text
            || !includesExactText(candidate.evidence_quote, candidate.value_text)) {
            return operation('ASK', validated.index, ['replace_evidence_or_subject_insufficient']);
        }
        const matches = activeSelfAssertions(snapshot, candidate.predicate)
            .filter(record => record.object?.type === 'text'
                && includesExactText(candidate.evidence_quote, record.object.value)
                && normalizedText(record.object.value) !== normalizedText(candidate.value_text));
        if (matches.length !== 1) return operation('ASK', validated.index, [
            matches.length === 0 ? 'replace_target_not_found_in_evidence' : 'replace_target_ambiguous',
        ]);
        return operation('REPLACE', validated.index, ['unique_prior_value_in_evidence', 'explicit_confirmation_required'],
            { targetAssertionId: matches[0].id });
    }

    if (policyResult.disposition !== 'auto_save')
        return operation('ASK', validated.index, ['policy_disposition_unrecognized']);
    if (policyResult.entityResolution.status === 'textual_only')
        return operation('ASK', validated.index, ['canonical_project_identity_unavailable']);
    if (!snapshot || policyResult.entityResolution.status !== 'self'
        || !isStructuralSelf(candidate.subject_text, snapshot) || candidate.mentioned_person_text)
        return operation('ASK', validated.index, ['canonical_self_required']);
    if (policyResult.entityResolution.entityId !== snapshot.snapshot.self_person_id)
        return operation('ASK', validated.index, ['self_resolution_mismatch']);
    if (candidate.temporal_hints.certainty !== 'none' || candidate.temporal_hints.raw_text !== null)
        return operation('ASK', validated.index, ['temporal_mapping_requires_review']);
    if (!includesExactText(candidate.evidence_quote, candidate.value_text))
        return operation('ASK', validated.index, ['candidate_value_not_verbatim_in_evidence']);

    const existing = activeSelfAssertions(snapshot, candidate.predicate);
    const duplicate = existing.find(record => record.object?.type === 'text'
        && normalizedText(record.object.value) === normalizedText(candidate.value_text)
        && record.valid_from === null && record.valid_to === null);
    if (duplicate) return operation('DUPLICATE', validated.index, ['equivalent_active_assertion']);
    if (existing.length && candidate.update_intent !== 'addition')
        return operation('ASK', validated.index, ['same_predicate_conflict_requires_review']);

    return operation('ADD', validated.index,
        existing.length ? ['explicit_addition_preserves_existing_assertions', 'memory_service_append_semantics_not_available']
            : ['no_conflicting_active_assertion', 'memory_service_append_semantics_not_available'],
        { targetAssertionId: null });
}

/**
 * Plans only. This API has no repository, service, authorization or writer capability.
 * Plan outcomes are advisory and cannot be passed to MemoryService as write requests.
 */
export function planAutomaticMemoryPersistence(input) {
    if (!exactRecord(input, ['text', 'proposal', 'snapshot'])
        || typeof input.text !== 'string' || !input.text.isWellFormed()
        || (input.snapshot !== null && !validSnapshotEnvelope(input.snapshot))) {
        return { success: false, error: { code: 'persistence_plan_input_invalid' } };
    }
    if (input.snapshot === null && !Object.hasOwn(input, 'snapshot'))
        return { success: false, error: { code: 'persistence_plan_input_invalid' } };

    const normalized = normalizeAutomaticMemoryProposal(input.proposal);
    if (!normalized.success)
        return { success: false, error: { code: normalized.error.code } };
    const validated = validateAutomaticMemoryCandidates(normalized.proposal, input.text);
    if (!validated.success)
        return { success: false, error: { code: validated.error.code } };
    const policy = evaluateAutomaticMemoryPolicy(validated.candidates, { snapshot: input.snapshot });
    const decisions = policy.candidates.map((item, index) => planOne(
        validated.candidates[index].proposal ?? {},
        validated.candidates[index],
        item,
        input.snapshot,
    ));
    return {
        success: true,
        planVersion: AUTOMATIC_MEMORY_PLAN_VERSION,
        executable: false,
        snapshotSha256: input.snapshot ? createHash('sha256').update(JSON.stringify(input.snapshot.snapshot)).digest('hex') : null,
        operations: decisions,
    };
}
