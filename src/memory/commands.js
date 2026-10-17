import { normalizeEntityName } from './entities.js';
import { createHash } from 'node:crypto';
import { assertExactObject, validateMemoryRecord, validateId, validateTemporal, validateTemporalInterval,
    validateRelationshipType } from './schema.js';
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
    const baseKeys = ['predicate', 'subject', 'object', 'valid_from', 'valid_to'];
    const shapes = [baseKeys, [...baseKeys, 'relationship_type']].map(keys => correction ? [...keys, 'supersedes'] : keys);
    let validShape = false;
    for (const keys of shapes) {
        try { assertExactObject(request, keys, 'relation'); validShape = true; break; } catch { /* Try the other exact shape. */ }
    }
    if (!validShape) throw new Error('memory_relation_shape_invalid');
    const definition = getRelationPredicate(request.predicate);
    if (!definition) throw new Error('memory_relation_predicate_invalid');
    const keys = ['predicate', 'subject', 'object', 'valid_from', 'valid_to',
        ...(definition.requiresRelationshipType ? ['relationship_type'] : []), ...(correction ? ['supersedes'] : [])];
    assertExactObject(request, keys, 'relation');
    if (definition.requiresRelationshipType) validateRelationshipType(request.relationship_type, 'relation.relationship_type');
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

function literalRememberCommand(value) {
    const key = 'note_' + createHash('sha256').update(value).digest('hex');
    const proposal = { kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note',
        object: { type: 'text', value }, valid_from: null, valid_to: null,
        compatibility: { category: 'fact', key } };
    validateRememberProposal(proposal);
    return { operation: 'remember', request: proposal };
}

export function hasMemoryIntentUncertainty(message) {
    if (typeof message !== 'string') return false;
    const normalized = message.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
    return /\b(?:no se si|todavia no se si|aun no se si|no estoy seguro|no estoy segura|quizas?|tal vez|capaz|estoy probando|todavia estoy evaluando)\b/u.test(normalized);
}

export function hasMemoryTransitionIntent(message) {
    if (typeof message !== 'string' || message.length > 16000) return false;
    const text = message.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');
    return /\b(?:me\s+pas[eé]\s+de\s+.+?\s+a\s+.+|dej[eé]\s+.+?\s+por\s+.+|(?:ahora|ultimamente)\s+.+?\s+(?:en\s+lugar\s+de|en\s+vez\s+de)\s+.+|(?:ahora|ultimamente)\s+(?:prefiero|uso|utilizo|tomo|elijo|trabajo\s+con)\s+.+?\s+(?:en\s+lugar\s+de|en\s+vez\s+de|antes)\s+.+|cambi[eé]\s+(?:mi\s+)?[\p{L}\p{N}][\s\S]{0,100}\s+(?:de\s+.+?\s+a\s+.+|de\s+.+?\s+por\s+.+))/u.test(text);
}

export function hasExplicitMemoryWriteIntent(message) {
    if (typeof message !== 'string' || message.length > 16000) return false;
    const text = message.trim();
    if (/^(?:nexa,\s*)?no\b[\s\S]*\b(?:recuerdes|acuerdes|guardes|anotes|registres|recuerdes|recordes)\b/iu.test(text)) return false;
    // This is only a gate for the structured interpreter, never a write parser.
    // Keep colloquial explicit save requests from falling through to a generic
    // conversational answer while leaving casual preference mentions alone.
    // Match an imperative as a complete word. Without the trailing boundary,
    // “recordás” was mistaken for “recordá”, sending an ordinary question into
    // the write-intent handler.
    if (/(?:^|[^\p{L}\p{N}_])(?:acordate|acord[aá]te|acordame|acord[aá]me|record[aá](?:me|lo)?|recordame|guard[aá](?:me|lo|te|telo)?|anot[aá](?:me|lo)?|anotalo|acuerdate|acu[eé]rdate)(?=$|[^\p{L}\p{N}_])/iu.test(text)) return true;
    if (/\b(?:tenelo|tené|tenerlo)\s+presente\b/iu.test(text)) return true;
    if (/\b(?:ya\s+no\s+(?:uso|prefiero)\s+[\p{L}\p{N}][\p{L}\p{N} .+_-]{0,80}[,.;]?\s*(?:y\s*)?ahora\s+(?:uso|prefiero|estoy con)\s+[\p{L}\p{N}][\p{L}\p{N} .+_-]{0,80}|me\s+pas[eé]\s+a\s+[\p{L}\p{N}][\p{L}\p{N} .+_-]{0,80}[,.;].{0,160}\bya\s+no\s+(?:uso|prefiero))/iu.test(text)) return true;
    return /^(?:(?:che\s+)?nexa,\s*)?(?:remember that|save that|keep this in memory:|recorda que|recordá que|guarda que|guardá que|acordate que|acu[eé]rdate de que|anota que|anot[aá] que|anota q|anotá q|anote que|quiero que te acuerdes de que|quiero que recuerdes que|no te olvides de que|recorda q|recordá q)\s+/iu.test(text)
        || /^(?:nexa,\s*)?[\s\S]+?[.!?,]\s*(?:record[aá]lo|recu[eé]rdalo|guard[aá]lo|conserv[aá]lo)[.!]?$/iu.test(text)
        || /^(?:nexa,\s*)?(?:me cambi[eé] de editor[,;:]?\s*(?:y\s*)?ahora\s+(?:prefiero|uso|estoy con)|antes\s+usaba\s+[\s\S]+?\s+pero\s+ahora\s+(?:prefiero|uso|estoy con))\b/iu.test(text)
        || text.startsWith('/remember ');
}

export function parseMemoryConfirmation(message) {
    if (typeof message !== 'string' || message.length > 500) return null;
    const normalized = message.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es')
        .replace(/[¡!¿?.,;:]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    const affirmative = new Set([
        'si', 'yes', 'confirmo', 'confirmar', 'dale', 'guardalo', 'guardalo por favor',
        'de una', 'de una guardalo', 'mandale', 'sip', 'dale guardalo', 'perfecto hacelo', 'perfecto guardalo', 'si hacelo',
        'si guardalo', 'hacelo', 'adelante', 'esta bien hacelo',
    ]);
    const negative = new Set([
        'no', 'nono', 'mejor no', 'cancelalo', 'cancelar', 'deja', 'dejalo',
        'no lo guardes', 'no guardes eso', 'para no guardes eso', 'no, para, todavia no guardes eso',
    ]);
    if (affirmative.has(normalized)) return 'confirm';
    if (negative.has(normalized)
        || /^(?:no\s+)?(?:para\s+)?(?:todavia\s+)?no\s+(?:guardes|lo guardes|lo guardemos|lo hagas|lo cambies|actualices)\b/u.test(normalized)
        || /^(?:mejor\s+)?cancel[aá]lo$/iu.test(message.trim())) return 'cancel';
    return null;
}

function parseEditorPreferenceUpdate(message) {
    const patterns = [
        { regex: /^(?:nexa,\s*)?cambi[eé] de editor[.!]?\s*ahora\s+(?:prefiero|uso)\s+(.+?)\s*[.!]?$/iu },
        { regex: /^(?:nexa,\s*)?actualiz(?:a|á)(?:me)?\s+(?:mi\s+)?editor(?: de prueba| de c[oó]digo)?(?: favorito)?\s+(?:a|por)\s+(.+?)\s*[.!]?$/iu },
        { regex: /^(?:nexa,\s*)?cambi[eé]\s+mi\s+editor(?: de prueba| de c[oó]digo)?(?: favorito)?\s+a\s+(.+?)\s*[.!]?$/iu },
        { regex: /^(?:nexa,\s*)?ya no prefiero\s+(.+?)[,;]\s*ahora\s+(?:prefiero|uso)\s+(.+?)\s*[.!]?$/iu, oldValue: 1, newValue: 2 },
    ];
    for (const pattern of patterns) {
        const match = pattern.regex.exec(message.trim());
        if (!match) continue;
        const newValue = match[pattern.newValue ?? 1]?.trim().replace(/[.!?]+$/u, '').trim();
        const oldValue = pattern.oldValue ? match[pattern.oldValue]?.trim().replace(/[.!?]+$/u, '').trim() : null;
        if (!newValue || [...newValue].length > 120 || /[\p{Cc}\p{Cf}]/u.test(newValue)) return null;
        if (oldValue && (!oldValue || [...oldValue].length > 120 || /[\p{Cc}\p{Cf}]/u.test(oldValue))) return null;
        return { operation: 'update_editor_preference', newValue, oldValue };
    }
    return null;
}

// Pure parsing supplies NO provenance. Only the terminal reader can attest input.
// Natural commands retain the literal fact; semantic extraction is deferred.
// The explicit structured form binds every field, including slot and subject.
export function parseMemoryCommand(message) {
    if (typeof message !== 'string' || message.length > 16000) return null;
    if (hasMemoryIntentUncertainty(message)) return null;
    try {
        if (message === '/automatic-memory consent') return { operation: 'automatic_memory_consent_request' };
        if (message === '/automatic-memory revoke-consent') return { operation: 'automatic_memory_consent_revoke' };
        if (message === '/automatic-memory exclude-conversation'
            || /^nexa,\s*no recuerdes esta conversaci[oó]n[.!]?$/iu.test(message.trim()))
            return { operation: 'automatic_memory_exclude_conversation' };
        if (message === '/automatic-memory proposals') return { operation: 'automatic_memory_proposals_list' };
        const reviewProposal = /^\/automatic-memory review (prop_[0-9a-f-]{36})$/iu.exec(message);
        if (reviewProposal) return { operation: 'automatic_memory_proposal_review', proposalId: reviewProposal[1] };
        const confirmProposal = /^\/automatic-memory confirm-proposal (prop_[0-9a-f-]{36}) ([0-9a-f-]{36})$/iu.exec(message);
        if (confirmProposal) return { operation: 'automatic_memory_proposal_confirm',
            proposalId: confirmProposal[1], proposalChallenge: confirmProposal[2] };
        const rejectProposal = /^\/automatic-memory reject-proposal (prop_[0-9a-f-]{36})$/iu.exec(message);
        if (rejectProposal) return { operation: 'automatic_memory_proposal_reject', proposalId: rejectProposal[1] };
        const discardProposal = /^\/automatic-memory discard-proposal (prop_[0-9a-f-]{36})$/iu.exec(message);
        if (discardProposal) return { operation: 'automatic_memory_proposal_discard', proposalId: discardProposal[1] };
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
        const editorUpdate = parseEditorPreferenceUpdate(message);
        if (editorUpdate) return editorUpdate;
        if (message.startsWith('/remember ')) {
            const proposal = JSON.parse(message.slice('/remember '.length));
            validateRememberProposal(proposal);
            return { operation: 'remember', request: proposal };
        }
        const match = /^(?:nexa,\s*)?(?:remember that|save that|keep this in memory:|recorda que|recordá que|guarda que|guardá que) ([\s\S]+)$/iu.exec(message);
        if (match) {
            const value = match[1].trim();
            return literalRememberCommand(value);
        }
        const assertion = /^\/forget assertion (mem_[0-9a-f-]+)$/u.exec(message);
        if (assertion) return { operation: 'forget', request: validateForgetTarget({ type: 'assertion', id: assertion[1] }) };
        const slot = /^\/forget slot (user|fact|preference|person|project|routine):([^\r\n]+)$/u.exec(message);
        if (slot) return { operation: 'forget', request: validateForgetTarget({ type: 'slot', compatibility: { category: slot[1], key: slot[2] } }) };
    } catch { /* Invalid explicit commands never become persistence requests. */ }
    return null;
}
