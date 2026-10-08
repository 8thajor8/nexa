import { screenAutomaticMemoryTurn } from './privacy.js';
import { getAutomaticMemorySourcePolicy } from './source-registry.js';
import { normalizeAutomaticMemoryProposal, validateAutomaticMemoryCandidates } from './schema.js';
import { evaluateAutomaticMemoryPolicy } from './policy.js';
import { planAutomaticMemoryPersistence } from './planner.js';

const CONSENT_SCENARIOS = new Set(['granted', 'missing', 'revoked']);
const POLICY_CLASS = Object.freeze({
    auto_save: 'auto_save_candidate',
    ask: 'ask',
    ignore: 'ignore',
});

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        || Reflect.ownKeys(value).length !== keys.length
        || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) return false;
    return keys.every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    });
}

function denied(reason) {
    return Object.freeze({
        success: true,
        simulationOnly: true,
        provenance: Object.freeze({ status: 'untrusted_synthetic_input', reason }),
        candidates: Object.freeze([]),
        authorization: Object.freeze({ granted: false, executable: false }),
        persistence: Object.freeze({ requested: false, performed: false }),
    });
}

function candidateViews(policy, plan, validated, sameTurnConflicts) {
    const planByIndex = new Map(plan.operations.map(item => [item.candidateIndex, item]));
    return policy.candidates.map(item => {
        const operation = planByIndex.get(item.candidateIndex);
        const candidate = validated.candidates[item.candidateIndex];
        const reasons = [...new Set([...item.reasonCodes, ...(operation?.reasonCodes ?? [])])];
        // A same-turn predicate collision is only a conservative warning. The
        // model-owned subject label is never used as identity or ownership proof.
        const collision = sameTurnConflicts.has(item.candidateIndex);
        const plannerWrite = operation?.operation === 'ADD' || operation?.operation === 'REPLACE';
        const classification = collision ? 'ask' : POLICY_CLASS[item.disposition] ?? 'ignore';
        const finalOperation = collision || plannerWrite ? 'ASK' : (operation?.operation ?? 'ASK');
        if (plannerWrite) reasons.push('simulation_never_executes_writes');
        return Object.freeze({
            candidateIndex: item.candidateIndex,
            candidateType: candidate?.proposal?.candidate_type ?? null,
            classification,
            policyDisposition: item.disposition,
            operation: finalOperation,
            reasonCodes: Object.freeze([
                ...new Set([
                    ...reasons,
                    ...(collision ? ['same_turn_predicate_conflict_requires_review'] : []),
                ]),
            ]),
            confirmationRequired: collision || plannerWrite || operation?.confirmationRequired === true,
            writeReady: false,
        });
    });
}

function findSameTurnConflicts(candidates) {
    const groups = new Map();
    for (const item of candidates) {
        const candidate = item.proposal;
        if (!candidate || !item.evidence.verified || item.redacted) continue;
        // This is a downgrade-only check. Textual subject equality cannot prove
        // that two statements concern the same real person.
        const key = `${candidate.subject_text ?? ''}\u0000${candidate.predicate}`.normalize('NFC').toLocaleLowerCase('und');
        const group = groups.get(key) ?? [];
        group.push({ index: item.index, value: candidate.value_text.normalize('NFC').trim().toLocaleLowerCase('und') });
        groups.set(key, group);
    }
    const conflicts = new Set();
    for (const group of groups.values()) {
        if (new Set(group.map(item => item.value)).size > 1)
            for (const item of group) conflicts.add(item.index);
    }
    return conflicts;
}

/**
 * Runs the existing A policy/planner over caller-supplied synthetic proposals.
 * This module has no detector, model client, consent store, identity issuer,
 * MemoryService, repository or persistence capability.
 */
export function simulateSelectiveMemoryAssessment(input) {
    const keys = ['text', 'proposal', 'sourceId', 'consentScenario', 'conversationOptOut', 'identityStatus'];
    if (!exactRecord(input, keys) || typeof input.text !== 'string'
        || typeof input.sourceId !== 'string' || !exactRecord(input.consentScenario, ['state', 'messageOptOut'])
        || !CONSENT_SCENARIOS.has(input.consentScenario.state)
        || typeof input.consentScenario.messageOptOut !== 'boolean'
        || typeof input.conversationOptOut !== 'boolean'
        || input.identityStatus !== 'unverified') return denied('simulation_input_invalid');

    // sourceId and identityStatus are scenario labels only. They cannot prove
    // provenance, a direct-user turn, authentication, Self, or consent.
    if (input.sourceId !== 'user:direct') return denied('source_policy_never_store');
    if (input.conversationOptOut) return denied('conversation_opt_out');
    if (input.consentScenario.state !== 'granted') return denied('consent_missing_or_revoked');
    if (input.consentScenario.messageOptOut) return denied('message_opt_out');

    const screening = screenAutomaticMemoryTurn(input.text);
    if (!screening.eligible) return denied(screening.reason);

    const sourcePolicy = getAutomaticMemorySourcePolicy(input.sourceId);
    if (sourcePolicy.memoryPolicy !== 'candidate_only') return denied('source_policy_never_store');

    const normalized = normalizeAutomaticMemoryProposal(input.proposal);
    if (!normalized.success) return denied(normalized.error.code);
    const validated = validateAutomaticMemoryCandidates(normalized.proposal, input.text);
    if (!validated.success) return denied(validated.error.code);

    // Deliberately omit identity capabilities and snapshots. A synthetic
    // "granted" consent flag only lets the scenario reach A's policy checks.
    const policy = evaluateAutomaticMemoryPolicy(validated.candidates);
    const plan = planAutomaticMemoryPersistence({ text: input.text, proposal: normalized.proposal, snapshot: null });
    if (!plan.success) return denied(plan.error.code);
    const sameTurnConflicts = findSameTurnConflicts(validated.candidates);
    const candidates = candidateViews(policy, plan, validated, sameTurnConflicts);
    return Object.freeze({
        success: true,
        simulationOnly: true,
        provenance: Object.freeze({ status: 'untrusted_synthetic_input', source: sourcePolicy.source,
            memoryPolicy: sourcePolicy.memoryPolicy, identity: 'unverified' }),
        candidates: Object.freeze(candidates),
        authorization: Object.freeze({ granted: false, executable: false }),
        persistence: Object.freeze({ requested: false, performed: false }),
    });
}
