import { normalizeEntityName } from './entities.js';
import { createHash } from 'node:crypto';
import { assertExactObject, validateMemoryRecord, validateId } from './schema.js';

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

// Pure parsing supplies NO provenance. Only the terminal reader can attest input.
// Natural commands retain the literal fact; semantic extraction is deferred.
// The explicit structured form binds every field, including slot and subject.
export function parseMemoryCommand(message) {
    if (typeof message !== 'string' || message.length > 16000) return null;
    try {
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
