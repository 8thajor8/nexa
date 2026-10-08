import { normalizeEntityName } from './entities.js';
import { createHash } from 'node:crypto';
import { assertExactObject, validateMemoryRecord, validateId, validateTemporal, validateTemporalInterval } from './schema.js';
import { getRelationPredicate } from './relation-predicates.js';

export function validateForgetTarget(target) {
    assertExactObject(target, Object.hasOwn(target ?? {}, 'id') ? ['type', 'id'] : ['type', 'compatibility'], 'target');
    if (target.type === 'assertion') { validateId(target.id, 'assertions', 'target.id'); return target; }
    if (target.type !== 'slot') throw new Error('memory_target_invalid');
    validateRememberProposal({ kind: 'legacy', subject: { type: 'unspecified' }, predicate: 'user.note',
        object: { type: 'text', value: 'validation' }, valid_from: null, valid_to: null, compatibility: target.compatibility });
    if (!target.compatibility) throw new Error('memory_target_invalid');
    return target;
}

export function validateRememberProposal(proposal) {
    assertExactObject(proposal, ['kind', 'subject', 'predicate', 'object', 'valid_from', 'valid_to', 'compatibility'], 'proposal');
    if (getRelationPredicate(proposal.predicate)) throw new Error('memory_relation_operation_required');
    validateMemoryRecord('assertions', {
        id: 'mem_00000000-0000-4000-8000-000000000000', ...proposal,
        status: 'active', recorded_at: '2000-01-01T00:00:00.000Z', supersedes: [],
    }, 'proposal');
    return proposal;
}

export function validatePersonCreation(request) {
    assertExactObject(request, ['preferredName', 'allowDuplicate'], 'person');
    normalizeEntityName(request.preferredName);
    if (typeof request.allowDuplicate !== 'boolean') throw new Error('memory_person_invalid');
    return request;
}

export function validateRelationRequest(request, { correction = false } = {}) {
    const keys = ['predicate', 'subject', 'object', 'valid_from', 'valid_to', ...(correction ? ['supersedes'] : [])];
    assertExactObject(request, keys, 'relation');
    const definition = getRelationPredicate(request.predicate);
    if (!definition) throw new Error('memory_relation_predicate_invalid');
    assertExactObject(request.subject, ['type', 'entity_type', 'id'], 'relation.subject');
    assertExactObject(request.object, ['type', 'entity_type', 'id'], 'relation.object');
    if (request.subject.type !== 'entity' || request.object.type !== 'entity_reference'
        || !definition.subjectTypes.includes(request.subject.entity_type)
        || !definition.objectTypes.includes(request.object.entity_type)) throw new Error('memory_relation_type_invalid');
    if (request.kind !== undefined || request.compatibility !== undefined) throw new Error('memory_relation_shape_invalid');
    validateId(request.subject.id, request.subject.entity_type, 'relation.subject.id');
    validateId(request.object.id, request.object.entity_type, 'relation.object.id');
    if (!definition.allowSelf && request.subject.id === request.object.id) throw new Error('memory_relation_self_invalid');
    validateTemporal(request.valid_from, 'relation.valid_from');
    validateTemporal(request.valid_to, 'relation.valid_to');
    validateTemporalInterval(request.valid_from, request.valid_to, 'relation.valid_to');
    if (correction) validateId(request.supersedes, 'assertions', 'relation.supersedes');
    const subject = structuredClone(request.subject), object = structuredClone(request.object);
    if (definition.symmetric && subject.id > object.id) {
        const old = { type: subject.type, entity_type: subject.entity_type, id: subject.id };
        subject.type = 'entity'; subject.entity_type = object.entity_type; subject.id = object.id;
        object.type = 'entity_reference'; object.entity_type = old.entity_type; object.id = old.id;
    }
    return { ...structuredClone(request), subject, object };
}

export function validateRelationForget(request) {
    assertExactObject(request, ['assertionId'], 'relation.forget');
    validateId(request.assertionId, 'assertions', 'relation.forget.assertionId');
    return request;
}

// Pure parsing supplies NO provenance. Only the terminal reader can attest input.
// Natural commands retain the literal fact; semantic extraction is deferred.
// The explicit structured form binds every field, including slot and subject.
export function parseMemoryCommand(message) {
    if (typeof message !== 'string' || message.length > 16000) return null;
    try {
        if (message === '/automatic-memory consent') return { operation: 'automatic_memory_consent_request' };
        if (message === '/automatic-memory revoke-consent') return { operation: 'automatic_memory_consent_revoke' };
        const consentConfirmation = /^\/automatic-memory confirm-consent ([0-9a-f-]{36})$/u.exec(message);
        if (consentConfirmation) return { operation: 'automatic_memory_consent_confirm', consentChallenge: consentConfirmation[1] };
        if (message.startsWith('/relation create ')) {
            const request = JSON.parse(message.slice('/relation create '.length));
            return { operation: 'create_relation', request: validateRelationRequest(request) };
        }
        if (message.startsWith('/relation correct ')) {
            const request = JSON.parse(message.slice('/relation correct '.length));
            return { operation: 'correct_relation', request: validateRelationRequest(request, { correction: true }) };
        }
        const relationForget = /^\/relation forget (mem_[0-9a-f-]+)$/u.exec(message);
        if (relationForget) return { operation: 'forget_relation', request: validateRelationForget({ assertionId: relationForget[1] }) };
        if (message.startsWith('/person create ')) {
            const request = JSON.parse(message.slice('/person create '.length));
            validatePersonCreation(request);
            return { operation: 'create_person', request };
        }
        if (message.startsWith('/remember ')) {
            const proposal = JSON.parse(message.slice('/remember '.length));
            validateRememberProposal(proposal);
            return { operation: 'remember', request: proposal };
        }
        const match = /^(?:remember that|save that|keep this in memory:|recorda que|recordá que|guarda que|guardá que) ([\s\S]+)$/iu.exec(message);
        if (match) {
            const value = match[1].trim();
            const key = 'note_' + createHash('sha256').update(value).digest('hex');
            const proposal = { kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note',
                object: { type: 'text', value }, valid_from: null, valid_to: null,
                compatibility: { category: 'fact', key } };
            validateRememberProposal(proposal);
            return { operation: 'remember', request: proposal };
        }
        const assertion = /^\/forget assertion (mem_[0-9a-f-]+)$/u.exec(message);
        if (assertion) return { operation: 'forget', request: validateForgetTarget({ type: 'assertion', id: assertion[1] }) };
        const slot = /^\/forget slot (user|fact|preference|person|project|routine):([^\r\n]+)$/u.exec(message);
        if (slot) return { operation: 'forget', request: validateForgetTarget({ type: 'slot', compatibility: { category: slot[1], key: slot[2] } }) };
    } catch { /* Invalid explicit commands never become persistence requests. */ }
    return null;
}
