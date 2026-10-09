import { screenMemorySecret } from '../secret-screening.js';
import { isHypotheticalAutomaticMemoryGateDecision } from './authorization-gate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CANDIDATE_TYPES = new Set(['fact', 'preference', 'decision', 'tool', 'purchase', 'hobby', 'professional',
    'language', 'learning_activity', 'long_term_goal', 'relationship', 'situation', 'other']);
const OPERATIONS = new Set(['ADD', 'REPLACE', 'ASK']);
const SCOPES = new Set(['personal', 'project', 'shared']);
const SENSITIVITIES = new Set(['none', 'health', 'finance', 'precise_location', 'identity_document', 'intimate',
    'minor', 'political', 'religious', 'biometric', 'credential', 'other_sensitive', 'unknown']);
const REASONS = new Set(['planner_review', 'replace_target_confirmation', 'sensitive_information', 'third_party',
    'project_identity', 'scope_restriction', 'shared_memory', 'conflict', 'other']);
const PROPOSAL_STATUSES = new Set(['pending', 'confirmed_hypothetically', 'rejected', 'needs_clarification', 'expired', 'revoked']);
const INTENTS = new Set(['affirm', 'reject', 'correct', 'restrict_scope', 'request_share', 'request_clarification',
    'ambiguous', 'unrelated', 'revoke', 'cancel']);

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

function plainDataRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    return Reflect.ownKeys(value).every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return typeof key === 'string' && descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    });
}

function denseDataArray(value, maximumLength) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > maximumLength || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
    }
    return true;
}

function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validTurnId(value) { return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128); }
function validNullableUuid(value) { return value === null || (typeof value === 'string' && value === value.toLowerCase() && UUID.test(value)); }
function validNullablePrincipal(value) { return value === null || (typeof value === 'string' && value === value.toLowerCase() && PRINCIPAL.test(value)); }

function noAuthorityFailure(code) {
    return Object.freeze({ success: false, simulationOnly: true, error: Object.freeze({ code }),
        authorization: Object.freeze({ granted: false, executable: false }), writeReady: false,
        persistence: Object.freeze({ performed: false }) });
}

function proposalFailure(code) { return noAuthorityFailure(code); }

function freezeProposal(value) {
    Object.freeze(value.candidateReference);
    Object.freeze(value.linkage);
    return Object.freeze(value);
}

function validCandidateAssessment(value, sensitivity) {
    if (!plainDataRecord(value)) return false;
    return Number.isSafeInteger(value.candidateIndex) && value.candidateIndex >= 0
        && CANDIDATE_TYPES.has(value.candidateType)
        && ['auto_save', 'ask'].includes(value.policyDisposition)
        && OPERATIONS.has(value.plannerOperation)
        && value.operation === 'ASK' && value.writeReady === false
        && value.finalDecision === value.authorizationGate?.decision
        && isHypotheticalAutomaticMemoryGateDecision(value.authorizationGate)
        && (value.authorizationGate.decision === 'ASK'
            || (sensitivity !== 'none' && value.authorizationGate.decision === 'DENY'
                && value.authorizationGate.reasonCodes.includes('sensitive_candidate_never_autosaved')));
}

/** Build a synthetic proposal for one C.6 candidate. This emits no authority. */
export function createSimulatedMemoryConfirmationProposal(input) {
    try {
        const keys = ['proposalId', 'assessmentId', 'candidateAssessment', 'candidateFingerprint', 'operation', 'summary',
            'suggestedScope', 'confirmationReason', 'sensitivity', 'targetReference', 'linkage', 'createdAt', 'expiresAt', 'revision'];
        if (!exactRecord(input, keys) || typeof input.proposalId !== 'string' || !UUID.test(input.proposalId)
            || typeof input.assessmentId !== 'string' || !UUID.test(input.assessmentId)
            || !HASH.test(input.candidateFingerprint) || !OPERATIONS.has(input.operation)
            || !SCOPES.has(input.suggestedScope) || !REASONS.has(input.confirmationReason)
            || !SENSITIVITIES.has(input.sensitivity) || !validDate(input.createdAt) || !validDate(input.expiresAt)
            || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)
            || !Number.isSafeInteger(input.revision) || input.revision < 0
            || !exactRecord(input.linkage, ['sessionId', 'principalId', 'installationId', 'turnId'])
            || !validNullableUuid(input.linkage.sessionId) || !validNullablePrincipal(input.linkage.principalId)
            || !validNullableUuid(input.linkage.installationId)
            || !validTurnId(input.linkage.turnId)
            || !(input.targetReference === null || (typeof input.targetReference === 'string' && UUID.test(input.targetReference)))
            || (input.operation === 'REPLACE') !== (input.targetReference !== null)
            || !validCandidateAssessment(input.candidateAssessment, input.sensitivity)
            || input.candidateAssessment.plannerOperation !== input.operation) return proposalFailure('confirmation_proposal_invalid');

        if (input.sensitivity === 'none') {
            if (typeof input.summary !== 'string' || input.summary.trim().length < 1 || input.summary.length > 240
                || /[\r\n\u0000-\u001f]/u.test(input.summary) || !screenMemorySecret(input.summary).safe)
                return proposalFailure('confirmation_summary_invalid');
        } else if (input.summary !== null) return proposalFailure('sensitive_summary_must_be_omitted');

        const proposal = freezeProposal({
            proposalId: input.proposalId,
            candidateReference: { assessmentId: input.assessmentId, candidateIndex: input.candidateAssessment.candidateIndex,
                fingerprint: input.candidateFingerprint },
            candidateType: input.candidateAssessment.candidateType,
            operation: input.operation,
            summary: input.summary === null ? null : input.summary.trim(),
            suggestedScope: input.suggestedScope,
            confirmationReason: input.confirmationReason,
            sensitivity: input.sensitivity,
            targetReference: input.targetReference,
            status: 'pending',
            linkage: { sessionId: input.linkage.sessionId, principalId: input.linkage.principalId,
                installationId: input.linkage.installationId, sourceTurnId: input.linkage.turnId,
                bindingStatus: 'unverified', fixtureOnly: true },
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
            revision: input.revision,
            requiresNewProposal: false,
            lastReasonCode: null,
            executable: false,
        });
        return Object.freeze({ success: true, simulationOnly: true, proposal,
            authorization: Object.freeze({ granted: false, executable: false }), writeReady: false,
            persistence: Object.freeze({ performed: false }) });
    } catch { return proposalFailure('confirmation_proposal_invalid'); }
}

function validProposal(value) {
    const keys = ['proposalId', 'candidateReference', 'candidateType', 'operation', 'summary', 'suggestedScope',
        'confirmationReason', 'sensitivity', 'targetReference', 'status', 'linkage', 'createdAt', 'expiresAt',
        'revision', 'requiresNewProposal', 'lastReasonCode', 'executable'];
    return exactRecord(value, keys) && typeof value.proposalId === 'string' && UUID.test(value.proposalId)
        && exactRecord(value.candidateReference, ['assessmentId', 'candidateIndex', 'fingerprint'])
        && typeof value.candidateReference.assessmentId === 'string' && UUID.test(value.candidateReference.assessmentId)
        && Number.isSafeInteger(value.candidateReference.candidateIndex) && value.candidateReference.candidateIndex >= 0
        && typeof value.candidateReference.fingerprint === 'string' && HASH.test(value.candidateReference.fingerprint)
        && CANDIDATE_TYPES.has(value.candidateType) && OPERATIONS.has(value.operation)
        && (value.summary === null || (typeof value.summary === 'string' && value.summary.length <= 240
            && !/[\r\n\u0000-\u001f]/u.test(value.summary) && screenMemorySecret(value.summary).safe))
        && SCOPES.has(value.suggestedScope) && REASONS.has(value.confirmationReason) && SENSITIVITIES.has(value.sensitivity)
        && (value.sensitivity === 'none' ? typeof value.summary === 'string' : value.summary === null)
        && (value.targetReference === null || (typeof value.targetReference === 'string' && UUID.test(value.targetReference)))
        && ((value.operation === 'REPLACE') === (value.targetReference !== null))
        && PROPOSAL_STATUSES.has(value.status)
        && exactRecord(value.linkage, ['sessionId', 'principalId', 'installationId', 'sourceTurnId', 'bindingStatus', 'fixtureOnly'])
        && validNullableUuid(value.linkage.sessionId) && validNullablePrincipal(value.linkage.principalId)
        && validNullableUuid(value.linkage.installationId)
        && validTurnId(value.linkage.sourceTurnId) && value.linkage.bindingStatus === 'unverified'
        && value.linkage.fixtureOnly === true
        && validDate(value.createdAt) && validDate(value.expiresAt) && Date.parse(value.expiresAt) > Date.parse(value.createdAt)
        && Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.requiresNewProposal === 'boolean'
        && (value.lastReasonCode === null || typeof value.lastReasonCode === 'string') && value.executable === false;
}

function decisionResult(proposal, responseOutcome, reasonCode, { status = proposal.status, requiresNewProposal = proposal.requiresNewProposal,
    suggestedScope = proposal.suggestedScope, incrementRevision = false } = {}) {
    const next = freezeProposal({ ...proposal, status, requiresNewProposal, suggestedScope,
        lastReasonCode: reasonCode, revision: proposal.revision + (incrementRevision ? 1 : 0), executable: false,
        candidateReference: { ...proposal.candidateReference }, linkage: { ...proposal.linkage } });
    return Object.freeze({ success: true, simulationOnly: true, responseOutcome, reasonCodes: Object.freeze([reasonCode]),
        proposal: next, authorization: Object.freeze({ granted: false, executable: false }), writeReady: false,
        persistence: Object.freeze({ performed: false }) });
}

/** Process one structured synthetic answer for exactly one pending proposal. */
export function evaluateSimulatedMemoryConfirmation(input) {
    try {
        const keys = ['proposal', 'response', 'evaluatedAt', 'currentRevision', 'optOut', 'consentRevoked'];
        if (!exactRecord(input, keys) || !validProposal(input.proposal) || !validDate(input.evaluatedAt)
            || !Number.isSafeInteger(input.currentRevision) || input.currentRevision < 0
            || typeof input.optOut !== 'boolean' || typeof input.consentRevoked !== 'boolean')
            return noAuthorityFailure('confirmation_evaluation_invalid');
        const proposal = input.proposal;
        if (input.optOut || input.consentRevoked) return decisionResult(proposal, 'revoked',
            input.optOut ? 'automatic_memory_opt_out' : 'analysis_consent_revoked', { status: 'revoked', incrementRevision: true });
        if (Date.parse(proposal.expiresAt) <= Date.parse(input.evaluatedAt))
            return decisionResult(proposal, 'expired', 'confirmation_proposal_expired', { status: 'expired', incrementRevision: true });
        if (input.currentRevision !== proposal.revision)
            return decisionResult(proposal, 'denied', 'confirmation_proposal_revision_stale');
        if (proposal.status !== 'pending' && proposal.status !== 'needs_clarification')
            return decisionResult(proposal, 'denied', 'confirmation_proposal_already_resolved');
        if (proposal.requiresNewProposal)
            return decisionResult(proposal, 'denied', 'confirmation_new_proposal_required');

        const responseKeys = ['proposalId', 'assessmentId', 'candidateIndex', 'candidateFingerprint', 'operation', 'targetReference',
            'intent', 'sourceLabel', 'principalId', 'sessionId', 'installationId', 'responseTurnId', 'requestedScope'];
        const response = input.response;
        if (!exactRecord(response, responseKeys) || !UUID.test(response.proposalId) || !UUID.test(response.assessmentId)
            || !Number.isSafeInteger(response.candidateIndex) || response.candidateIndex < 0
            || typeof response.candidateFingerprint !== 'string' || !HASH.test(response.candidateFingerprint)
            || !OPERATIONS.has(response.operation)
            || !(response.targetReference === null || (typeof response.targetReference === 'string' && UUID.test(response.targetReference)))
            || !INTENTS.has(response.intent) || response.sourceLabel !== 'synthetic_direct_user'
            || !validNullablePrincipal(response.principalId) || !validNullableUuid(response.sessionId)
            || !validNullableUuid(response.installationId)
            || typeof response.responseTurnId !== 'string' || response.responseTurnId.length < 1 || response.responseTurnId.length > 128
            || !(response.requestedScope === null || SCOPES.has(response.requestedScope)))
            return decisionResult(proposal, 'denied', 'confirmation_response_invalid');

        const ref = proposal.candidateReference;
        if (response.proposalId !== proposal.proposalId || response.assessmentId !== ref.assessmentId
            || response.candidateIndex !== ref.candidateIndex || response.candidateFingerprint !== ref.fingerprint
            || response.operation !== proposal.operation || response.targetReference !== proposal.targetReference)
            return decisionResult(proposal, 'denied', 'confirmation_response_binding_mismatch');
        if (response.principalId !== proposal.linkage.principalId || response.sessionId !== proposal.linkage.sessionId
            || response.installationId !== proposal.linkage.installationId)
            return decisionResult(proposal, 'denied', 'confirmation_response_principal_session_or_installation_mismatch');

        switch (response.intent) {
            case 'affirm':
                if (proposal.sensitivity !== 'none') return decisionResult(proposal, 'needs_clarification',
                    'sensitive_confirmation_requires_independent_review', { status: 'needs_clarification', requiresNewProposal: true, incrementRevision: true });
                if (proposal.suggestedScope === 'shared') return decisionResult(proposal, 'needs_clarification',
                    'shared_scope_requires_specific_consent', { status: 'needs_clarification', requiresNewProposal: true, incrementRevision: true });
                if (proposal.suggestedScope === 'project') return decisionResult(proposal, 'needs_clarification',
                    'project_scope_requires_canonical_identity', { status: 'needs_clarification', requiresNewProposal: true, incrementRevision: true });
                return decisionResult(proposal, 'confirmed_hypothetically', 'single_proposal_explicit_affirmation_only',
                    { status: 'confirmed_hypothetically', incrementRevision: true });
            case 'reject':
                return decisionResult(proposal, 'rejected', 'proposal_rejected_by_synthetic_response',
                    { status: 'rejected', incrementRevision: true });
            case 'correct':
                return decisionResult(proposal, 'needs_clarification', 'correction_requires_new_proposal',
                    { status: 'needs_clarification', requiresNewProposal: true, incrementRevision: true });
            case 'restrict_scope': {
                const rank = { personal: 1, project: 2, shared: 3 };
                if (!response.requestedScope || response.requestedScope === 'shared'
                    || rank[response.requestedScope] >= rank[proposal.suggestedScope])
                    return decisionResult(proposal, 'needs_clarification', 'scope_change_requires_new_proposal',
                        { status: 'needs_clarification', requiresNewProposal: true, incrementRevision: true });
                return decisionResult(proposal, 'needs_clarification', 'restricted_scope_requires_new_proposal',
                    { status: 'needs_clarification', suggestedScope: response.requestedScope,
                        requiresNewProposal: true, incrementRevision: true });
            }
            case 'request_share':
                return decisionResult(proposal, 'needs_clarification', 'sharing_requires_specific_recipient_consent',
                    { status: 'needs_clarification', requiresNewProposal: true, incrementRevision: true });
            case 'revoke':
                return decisionResult(proposal, 'revoked', 'proposal_revoked_by_synthetic_response',
                    { status: 'revoked', incrementRevision: true });
            case 'cancel':
                return decisionResult(proposal, 'rejected', 'proposal_cancelled_by_synthetic_response',
                    { status: 'rejected', incrementRevision: true });
            case 'ambiguous':
                return decisionResult(proposal, 'needs_clarification', 'response_ambiguous',
                    { status: 'needs_clarification', incrementRevision: true });
            case 'request_clarification':
                return decisionResult(proposal, 'needs_clarification', 'clarification_requested',
                    { status: 'needs_clarification', incrementRevision: true });
            case 'unrelated':
                return decisionResult(proposal, 'needs_clarification', 'response_unrelated',
                    { status: 'needs_clarification', incrementRevision: true });
            default:
                return decisionResult(proposal, 'denied', 'confirmation_response_invalid');
        }
    } catch { return noAuthorityFailure('confirmation_evaluation_invalid'); }
}

function batchFailure(code) {
    return Object.freeze({ ...noAuthorityFailure(code), decisions: Object.freeze([]), issues: Object.freeze([code]) });
}

function batchDecision(proposal, result, responseIntent = null) {
    return Object.freeze({ proposalId: proposal.proposalId, responseIntent, responseOutcome: result.responseOutcome,
        reasonCodes: result.reasonCodes, proposal: result.proposal,
        authorization: Object.freeze({ granted: false, executable: false }), writeReady: false,
        persistence: Object.freeze({ performed: false }) });
}

function unresolvedBatchDecision(proposal) {
    const result = decisionResult(proposal, 'pending', 'no_response_for_proposal');
    return batchDecision(proposal, result);
}

function resolveBatchReference(reference, ordered, byId) {
    if (!plainDataRecord(reference)) return null;
    if (reference.kind === 'proposal_id' && exactRecord(reference, ['kind', 'proposalId'])
        && typeof reference.proposalId === 'string' && UUID.test(reference.proposalId))
        return byId.get(reference.proposalId) ?? null;
    if (reference.kind === 'ordinal' && exactRecord(reference, ['kind', 'ordinal'])
        && Number.isSafeInteger(reference.ordinal) && reference.ordinal >= 1 && reference.ordinal <= ordered.length)
        return ordered[reference.ordinal - 1];
    return null;
}

/**
 * Evaluate a batch of synthetic proposal responses against an explicit synthetic
 * revision snapshot. Ordinals use deterministic order (createdAt, then proposalId).
 * This function has no state or persistence and can never issue write authority.
 */
export function evaluateSimulatedMemoryConfirmationBatch(input) {
    try {
        const keys = ['proposals', 'responses', 'currentRevisions', 'evaluatedAt', 'optOut', 'consentRevoked',
            'cancelBatch', 'executionRequested', 'presentedProposalIds'];
        if (!exactRecord(input, keys) || !denseDataArray(input.proposals, 64) || input.proposals.length === 0
            || !denseDataArray(input.responses, 64) || !denseDataArray(input.currentRevisions, 64)
            || !validDate(input.evaluatedAt) || typeof input.optOut !== 'boolean'
            || typeof input.consentRevoked !== 'boolean' || typeof input.cancelBatch !== 'boolean'
            || typeof input.executionRequested !== 'boolean') return batchFailure('confirmation_batch_invalid');
        if (input.executionRequested) return batchFailure('confirmation_batch_execution_not_supported');

        const proposals = [...input.proposals];
        if (!proposals.every(validProposal)) return batchFailure('confirmation_batch_proposal_invalid');
        const byId = new Map();
        const candidateKeys = new Set();
        for (const proposal of proposals) {
            if (byId.has(proposal.proposalId)) return batchFailure('confirmation_batch_duplicate_proposal_id');
            const candidateKey = `${proposal.candidateReference.assessmentId}:${proposal.candidateReference.candidateIndex}:${proposal.candidateReference.fingerprint}`;
            if (candidateKeys.has(candidateKey)) return batchFailure('confirmation_batch_duplicate_candidate_reference');
            candidateKeys.add(candidateKey);
            byId.set(proposal.proposalId, proposal);
        }

        const context = proposal => JSON.stringify([proposal.linkage.principalId,
            proposal.linkage.sessionId, proposal.linkage.installationId]);
        if (!proposals.every(proposal => context(proposal) === context(proposals[0])))
            return batchFailure('confirmation_batch_identity_context_mismatch');

        const revisions = new Map();
        if (input.currentRevisions.length !== proposals.length) return batchFailure('confirmation_batch_revision_snapshot_incomplete');
        for (const entry of input.currentRevisions) {
            if (!exactRecord(entry, ['proposalId', 'revision']) || typeof entry.proposalId !== 'string'
                || !byId.has(entry.proposalId) || !Number.isSafeInteger(entry.revision) || entry.revision < 0
                || revisions.has(entry.proposalId)) return batchFailure('confirmation_batch_revision_snapshot_invalid');
            revisions.set(entry.proposalId, entry.revision);
        }
        if (revisions.size !== proposals.length) return batchFailure('confirmation_batch_revision_snapshot_incomplete');

        const ordered = [...proposals].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
            || left.proposalId.localeCompare(right.proposalId));
        const orderedProposalIds = ordered.map(proposal => proposal.proposalId);
        if (input.presentedProposalIds === null) {
            if (input.responses.length !== 0) return batchFailure('confirmation_batch_presentation_snapshot_required');
        } else if (!denseDataArray(input.presentedProposalIds, 64)
            || input.presentedProposalIds.length !== orderedProposalIds.length
            || input.presentedProposalIds.some((proposalId, index) => proposalId !== orderedProposalIds[index])) {
            return batchFailure('confirmation_batch_presentation_snapshot_mismatch');
        }
        const responseKeys = ['reference', 'assessmentId', 'candidateIndex', 'candidateFingerprint', 'operation',
            'targetReference', 'intent', 'sourceLabel', 'principalId', 'sessionId', 'installationId',
            'responseTurnId', 'requestedScope'];
        const targets = new Map();
        const issues = [];
        for (let index = 0; index < input.responses.length; index++) {
            const answer = input.responses[index];
            if (!exactRecord(answer, responseKeys)) { issues.push('confirmation_batch_response_invalid'); continue; }
            const proposal = resolveBatchReference(answer.reference, ordered, byId);
            if (!proposal) { issues.push('confirmation_batch_reference_invalid_or_ambiguous'); continue; }
            const list = targets.get(proposal.proposalId) ?? [];
            list.push({ answer, index });
            targets.set(proposal.proposalId, list);
        }

        const decisions = ordered.map(proposal => {
            const revision = revisions.get(proposal.proposalId);
            if (input.optOut || input.consentRevoked) {
                const reason = input.optOut ? 'automatic_memory_opt_out' : 'analysis_consent_revoked';
                return batchDecision(proposal, decisionResult(proposal, 'revoked', reason,
                    { status: 'revoked', incrementRevision: true }));
            }
            if (Date.parse(proposal.expiresAt) <= Date.parse(input.evaluatedAt))
                return batchDecision(proposal, decisionResult(proposal, 'expired', 'confirmation_proposal_expired',
                    { status: 'expired', incrementRevision: true }));
            if (revision !== proposal.revision)
                return batchDecision(proposal, decisionResult(proposal, 'denied', 'confirmation_proposal_revision_stale'));
            if (input.cancelBatch && (proposal.status === 'pending' || proposal.status === 'needs_clarification'))
                return batchDecision(proposal, decisionResult(proposal, 'rejected', 'confirmation_batch_cancelled',
                    { status: 'rejected', incrementRevision: true }));
            const answers = targets.get(proposal.proposalId) ?? [];
            if (answers.length === 0) {
                if (proposal.status !== 'pending' && proposal.status !== 'needs_clarification')
                    return batchDecision(proposal, decisionResult(proposal, 'denied', 'confirmation_proposal_already_resolved'));
                return unresolvedBatchDecision(proposal);
            }
            if (answers.length > 1)
                return batchDecision(proposal, decisionResult(proposal, 'denied', 'confirmation_batch_duplicate_reference'));
            const answer = answers[0].answer;
            const singleResponse = {
                proposalId: proposal.proposalId,
                assessmentId: answer.assessmentId,
                candidateIndex: answer.candidateIndex,
                candidateFingerprint: answer.candidateFingerprint,
                operation: answer.operation,
                targetReference: answer.targetReference,
                intent: answer.intent,
                sourceLabel: answer.sourceLabel,
                principalId: answer.principalId,
                sessionId: answer.sessionId,
                installationId: answer.installationId,
                responseTurnId: answer.responseTurnId,
                requestedScope: answer.requestedScope,
            };
            return batchDecision(proposal, evaluateSimulatedMemoryConfirmation({ proposal, response: singleResponse,
                evaluatedAt: input.evaluatedAt, currentRevision: revision, optOut: false, consentRevoked: false }),
            INTENTS.has(answer.intent) ? answer.intent : null);
        });

        return Object.freeze({ success: true, simulationOnly: true,
            orderedProposalIds: Object.freeze(orderedProposalIds),
            decisions: Object.freeze(decisions), issues: Object.freeze(issues),
            authorization: Object.freeze({ granted: false, executable: false }), writeReady: false,
            persistence: Object.freeze({ performed: false }) });
    } catch { return batchFailure('confirmation_batch_invalid'); }
}
