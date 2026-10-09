import { evaluateAuthorizationPolicy } from '../../core/authorization-engine.js';
import { evaluateHypotheticalSession, validateDeviceSessionSnapshot } from '../../core/device-session-lifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINCIPAL = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PERSON = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const CANDIDATE_TYPES = new Set(['fact', 'preference', 'decision', 'tool', 'purchase', 'hobby', 'professional',
    'language', 'learning_activity', 'long_term_goal', 'relationship', 'situation', 'other']);
const UPDATE_INTENTS = new Set(['new_fact', 'possible_correction', 'possible_supersession', 'addition', 'relation', 'unknown']);
const AUTOSAVE_TYPES = new Set(['preference', 'tool', 'purchase', 'hobby', 'professional', 'language', 'situation']);
const SENSITIVITIES = new Set(['none', 'health', 'finance', 'precise_location', 'identity_document',
    'intimate', 'minor', 'political', 'religious', 'biometric', 'credential', 'other_sensitive', 'unknown']);

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

function result(decision, reasonCodes, mode = 'hypothetical') {
    return Object.freeze({ decision, mode, executable: false, reasonCodes: Object.freeze([...new Set(reasonCodes)]) });
}

function deny(code, mode = 'hypothetical') { return result('DENY', [code], mode); }
function ask(code) { return result('ASK', [code]); }
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validId(value, pattern) { return typeof value === 'string' && value === value.toLowerCase() && pattern.test(value); }
function denseArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
    }
    return true;
}
function activePair(pair) {
    return exactRecord(pair, ['expected', 'current']) && Number.isSafeInteger(pair.expected)
        && pair.expected >= 0 && Number.isSafeInteger(pair.current) && pair.current >= 0
        && pair.expected === pair.current;
}

function validCandidate(value) {
    return exactRecord(value, ['classification', 'operation', 'sensitivity', 'conflict', 'candidateType',
        'updateIntent', 'subjectPersonId', 'mentionedPersonText', 'turnId', 'sourceTextSha256', 'evidenceSha256'])
        && ['auto_save_candidate', 'ask', 'ignore'].includes(value.classification)
        && ['ADD', 'REPLACE', 'ASK', 'IGNORE', 'DUPLICATE'].includes(value.operation)
        && SENSITIVITIES.has(value.sensitivity) && typeof value.conflict === 'boolean'
        && CANDIDATE_TYPES.has(value.candidateType) && UPDATE_INTENTS.has(value.updateIntent)
        && (value.subjectPersonId === null || validId(value.subjectPersonId, PERSON))
        && (value.mentionedPersonText === null || (typeof value.mentionedPersonText === 'string'
            && value.mentionedPersonText.length > 0 && value.mentionedPersonText.length <= 300))
        && typeof value.turnId === 'string' && value.turnId.length > 0 && value.turnId.length <= 128
        && HASH.test(value.sourceTextSha256) && HASH.test(value.evidenceSha256);
}

function validProvenance(value) {
    return exactRecord(value, ['status', 'sourceKind', 'turnId', 'sourceTextSha256', 'evidenceSha256',
        'sessionId', 'principalId', 'fixtureOnly'])
        && ['synthetic_verified', 'untrusted_synthetic_input', 'external'].includes(value.status)
        && ['direct_user', 'tool_output', 'imported', 'model_output', 'unknown'].includes(value.sourceKind)
        && typeof value.turnId === 'string' && value.turnId.length > 0 && value.turnId.length <= 128
        && HASH.test(value.sourceTextSha256) && HASH.test(value.evidenceSha256)
        && (value.sessionId === null || validId(value.sessionId, UUID))
        && (value.principalId === null || validId(value.principalId, PRINCIPAL))
        && typeof value.fixtureOnly === 'boolean';
}

function validIdentity(value) {
    return exactRecord(value, ['fixtureOnly', 'status', 'principalId', 'memoryPersonId', 'principalEpoch',
        'installationId', 'installationEpoch', 'sessionId', 'selfBindingStatus'])
        && value.fixtureOnly === true && value.status === 'synthetic_verified'
        && validId(value.principalId, PRINCIPAL) && validId(value.memoryPersonId, PERSON)
        && Number.isSafeInteger(value.principalEpoch) && value.principalEpoch >= 0
        && validId(value.installationId, UUID) && Number.isSafeInteger(value.installationEpoch)
        && value.installationEpoch > 0 && validId(value.sessionId, UUID)
        && value.selfBindingStatus === 'linked';
}

function validConsent(value, candidate, identity, scope, at) {
    if (!exactRecord(value, ['fixtureOnly', 'consentId', 'principalId', 'subjectPersonId', 'installationId',
        'principalEpoch', 'installationEpoch', 'purpose', 'scope', 'recipientPrincipalIds', 'candidateType',
        'grantedAt', 'expiresAt', 'revokedAt', 'revision'])) return false;
    return value.fixtureOnly === true && validId(value.consentId, UUID)
        && value.principalId === identity.principalId && value.subjectPersonId === candidate.subjectPersonId
        && value.installationId === identity.installationId && value.principalEpoch === identity.principalEpoch
        && value.installationEpoch === identity.installationEpoch && value.purpose === 'automatic_memory_autosave'
        && value.scope === scope.kind && denseArray(value.recipientPrincipalIds)
        && value.recipientPrincipalIds.length === scope.recipientPrincipalIds.length
        && value.recipientPrincipalIds.every((id, index) => id === scope.recipientPrincipalIds[index])
        && value.candidateType === candidate.candidateType
        && validDate(value.grantedAt) && validDate(value.expiresAt) && value.revokedAt === null
        && Date.parse(value.grantedAt) <= at && Date.parse(value.expiresAt) > at
        && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function validScope(value, candidate, identity) {
    if (!exactRecord(value, ['kind', 'installationId', 'ownerPrincipalId', 'subjectPersonId', 'recipientPrincipalIds'])
        || !['private', 'shared'].includes(value.kind) || value.installationId !== identity.installationId
        || value.ownerPrincipalId !== identity.principalId || value.subjectPersonId !== candidate.subjectPersonId
        || !denseArray(value.recipientPrincipalIds)
        || value.recipientPrincipalIds.some(id => !validId(id, PRINCIPAL))
        || new Set(value.recipientPrincipalIds).size !== value.recipientPrincipalIds.length) return false;
    if (value.kind === 'private') return value.recipientPrincipalIds.length === 0;
    return value.recipientPrincipalIds.length > 0 && !value.recipientPrincipalIds.includes(identity.principalId);
}

function validateBindings(input, at) {
    const { candidate, provenance, identity, consent, scope, authorizationInput, deviceSnapshot,
        sessionId, expectedRevisions } = input;
    if (!validProvenance(provenance)) return 'provenance_invalid';
    if (provenance.sourceKind !== 'direct_user' || provenance.status === 'external') return 'source_excluded';
    if (provenance.turnId !== candidate.turnId || provenance.sourceTextSha256 !== candidate.sourceTextSha256
        || provenance.evidenceSha256 !== candidate.evidenceSha256) return 'turn_evidence_binding_mismatch';
    if (provenance.status !== 'synthetic_verified' || provenance.fixtureOnly !== true) return 'turn_provenance_unverified';
    if (!identity) return 'identity_missing';
    if (!validIdentity(identity)) return 'identity_unverified_or_invalid';
    if (identity.sessionId !== sessionId || provenance.sessionId !== sessionId
        || provenance.principalId !== identity.principalId) return 'identity_turn_session_mismatch';
    if (!candidate.subjectPersonId) return 'canonical_subject_missing';
    if (candidate.subjectPersonId !== identity.memoryPersonId) return 'subject_principal_mismatch';
    if (!validScope(scope, candidate, identity)) return 'memory_scope_invalid_or_cross_user';
    if (!exactRecord(expectedRevisions, ['authorization', 'consent', 'deviceSnapshot', 'principalEpoch', 'installationEpoch'])
        || !['authorization', 'consent', 'deviceSnapshot', 'principalEpoch', 'installationEpoch'].every(key => activePair(expectedRevisions[key])))
        return 'snapshot_revision_stale';
    if (identity.principalEpoch !== expectedRevisions.principalEpoch.current
        || identity.installationEpoch !== expectedRevisions.installationEpoch.current) return 'identity_epoch_stale';
    const consentKeys = ['fixtureOnly', 'consentId', 'principalId', 'subjectPersonId', 'installationId',
        'principalEpoch', 'installationEpoch', 'purpose', 'scope', 'recipientPrincipalIds', 'candidateType',
        'grantedAt', 'expiresAt', 'revokedAt', 'revision'];
    if (scope.kind === 'shared' && exactRecord(consent, consentKeys) && denseArray(consent.recipientPrincipalIds)
        && (consent.recipientPrincipalIds.length !== scope.recipientPrincipalIds.length
            || consent.recipientPrincipalIds.some((id, index) => id !== scope.recipientPrincipalIds[index])))
        return 'shared_recipient_consent_mismatch';
    if (!validConsent(consent, candidate, identity, scope, at)) {
        if (consent && exactRecord(consent, consentKeys) && consent.revokedAt !== null) return 'consent_revoked';
        if (consent && validDate(consent.expiresAt) && Date.parse(consent.expiresAt) <= at) return 'consent_expired';
        return 'consent_missing_or_invalid';
    }
    if (consent.revision !== expectedRevisions.consent.current) return 'consent_revision_stale';
    if (!validateDeviceSessionSnapshot(deviceSnapshot).valid) return 'device_session_snapshot_invalid';
    if (deviceSnapshot.revision !== expectedRevisions.deviceSnapshot.current
        || deviceSnapshot.installationEpoch !== identity.installationEpoch
        || deviceSnapshot.installation.installationId !== identity.installationId
        || Date.parse(deviceSnapshot.evaluatedAt) !== at) return 'device_session_snapshot_stale';
    const sessionDecision = evaluateHypotheticalSession({ mode: 'hypothetical', snapshot: deviceSnapshot,
        sessionId, principalId: identity.principalId, installationId: identity.installationId,
        evaluatedAt: new Date(at).toISOString() });
    if (sessionDecision.decision !== 'ALLOW' || sessionDecision.executable !== false)
        return sessionDecision.reasonCode === 'session_inactive_or_stale' ? 'session_or_device_revoked_or_expired' : 'session_invalid';

    const lifecycleSession = deviceSnapshot.sessions.find(item => item.sessionId === sessionId);
    const lifecycleDevice = lifecycleSession?.deviceId
        ? deviceSnapshot.devices.find(item => item.deviceId === lifecycleSession.deviceId) : null;
    const authorization = authorizationInput;
    if (!authorization || authorization.mode !== 'hypothetical' || authorization.principalId !== identity.principalId
        || authorization.installation?.installationId !== identity.installationId
        || authorization.session?.sessionId !== sessionId
        || authorization.session?.principalId !== identity.principalId
        || authorization.session?.installationId !== identity.installationId
        || authorization.session?.accountEpoch !== identity.principalEpoch
        || authorization.session?.deviceId !== (lifecycleSession?.deviceId ?? null)
        || authorization.evaluatedAt === undefined || Date.parse(authorization.evaluatedAt) !== at
        || authorization.expectedRevision !== expectedRevisions.authorization.current
        || authorization.currentRevision !== expectedRevisions.authorization.current
        || !authorization.principals?.some(principal => principal.principalId === identity.principalId
            && principal.memoryPersonId === identity.memoryPersonId && principal.accountEpoch === identity.principalEpoch))
        return 'authorization_context_binding_mismatch';
    if (scope.kind === 'shared' && scope.recipientPrincipalIds.some(recipientId =>
        !authorization.principals?.some(principal => principal.principalId === recipientId
            && principal.accountStatus === 'active'))) return 'shared_recipient_unverified';
    if (lifecycleSession?.deviceId) {
        if (!lifecycleDevice || lifecycleDevice.status !== 'active'
            || lifecycleDevice.revision !== lifecycleSession.deviceRevision
            || authorization.device?.deviceId !== lifecycleDevice.deviceId
            || authorization.device?.principalId !== identity.principalId
            || authorization.device?.installationId !== identity.installationId) return 'device_binding_mismatch';
    } else if (authorization.device !== null || authorization.request?.deviceRequired === true) return 'device_binding_mismatch';

    const requiredScope = scope.kind === 'private' ? 'own' : 'shared';
    if (authorization.request?.action !== 'write' || authorization.request?.resource !== 'memory.automatic.add'
        || authorization.request?.scope !== requiredScope || authorization.request?.subjectPrincipalId !== identity.principalId
        || authorization.request?.requirements?.length !== 1
        || authorization.request.requirements[0]?.permission !== 'memory.write'
        || authorization.request.requirements[0]?.action !== 'write'
        || authorization.request.requirements[0]?.resource !== 'memory.automatic.add'
        || authorization.request.requirements[0]?.scope !== requiredScope) return 'permission_scope_mismatch';
    const authzDecision = evaluateAuthorizationPolicy(authorization);
    if (authzDecision.decision !== 'ALLOW' || authzDecision.mode !== 'hypothetical' || authzDecision.executable !== false)
        return authzDecision.reasonCode === 'authorization_snapshot_stale'
            ? 'authorization_snapshot_stale' : 'explicit_memory_write_permission_missing';
    return null;
}

/**
 * Pure C.6.2 gate. Every successful path is hypothetical data evaluation;
 * fixture claims are never authentication, consent, grants, or capabilities.
 */
export function evaluateHypotheticalAutomaticMemoryGate(input) {
    try {
        if (Object.getOwnPropertyDescriptor(input ?? {}, 'mode')?.value === 'execution')
            return deny('trusted_executable_authorization_unavailable', 'execution');
        const keys = ['mode', 'candidate', 'provenance', 'identity', 'consent', 'scope', 'authorizationInput',
            'deviceSnapshot', 'sessionId', 'evaluatedAt', 'expectedRevisions', 'optOut', 'executionRequested'];
        if (!exactRecord(input, keys) || input.mode !== 'hypothetical' || !validCandidate(input.candidate)
            || !(input.provenance === null || typeof input.provenance === 'object')
            || !(input.identity === null || typeof input.identity === 'object')
            || !(input.consent === null || typeof input.consent === 'object')
            || !(input.scope === null || typeof input.scope === 'object')
            || !(input.authorizationInput === null || typeof input.authorizationInput === 'object')
            || !(input.deviceSnapshot === null || typeof input.deviceSnapshot === 'object')
            || !(input.sessionId === null || validId(input.sessionId, UUID))
            || !validDate(input.evaluatedAt) || typeof input.optOut !== 'boolean'
            || typeof input.executionRequested !== 'boolean') return deny('gate_input_invalid');
        if (input.executionRequested) return deny('trusted_executable_authorization_unavailable', 'execution');
        if (input.optOut) return deny('automatic_memory_opt_out');

        const { candidate } = input;
        // Exclusions and revocation dominate candidate classifications, including ASK.
        if (input.provenance === null && candidate.classification === 'auto_save_candidate'
            && candidate.operation === 'ADD' && candidate.sensitivity === 'none') return ask('turn_provenance_missing');
        if (input.provenance !== null) {
            if (!validProvenance(input.provenance)) return deny('provenance_invalid');
            if (input.provenance.sourceKind !== 'direct_user' || input.provenance.status === 'external')
                return deny('source_excluded');
        }
        if (input.consent && exactRecord(input.consent, ['fixtureOnly', 'consentId', 'principalId', 'subjectPersonId',
            'installationId', 'principalEpoch', 'installationEpoch', 'purpose', 'scope', 'recipientPrincipalIds', 'candidateType',
            'grantedAt', 'expiresAt', 'revokedAt', 'revision'])) {
            if (input.consent.revokedAt !== null) return deny('consent_revoked');
            if (validDate(input.consent.expiresAt) && Date.parse(input.consent.expiresAt) <= Date.parse(input.evaluatedAt))
                return deny('consent_expired');
        }
        if (candidate.classification === 'ignore' || ['IGNORE', 'DUPLICATE'].includes(candidate.operation))
            return deny('candidate_not_eligible');
        if (candidate.sensitivity !== 'none') return deny('sensitive_candidate_never_autosaved');
        if (candidate.mentionedPersonText !== null) return ask('third_party_fact_requires_review');
        if (candidate.conflict) return ask('conflict_requires_review');
        if (candidate.operation === 'REPLACE' || candidate.updateIntent === 'possible_correction'
            || candidate.updateIntent === 'possible_supersession') return ask('replace_requires_independent_confirmation');
        if (candidate.classification === 'ask' || candidate.operation === 'ASK') return ask('candidate_requires_review');
        if (candidate.classification !== 'auto_save_candidate' || candidate.operation !== 'ADD')
            return deny('candidate_operation_incompatible');
        if (candidate.candidateType === 'decision') return ask('textual_project_identity_requires_confirmation');
        if (!AUTOSAVE_TYPES.has(candidate.candidateType)) return deny('candidate_type_not_autosave_eligible');

        const at = Date.parse(input.evaluatedAt);
        const bindingFailure = validateBindings(input, at);
        if (bindingFailure) {
            const askable = new Set(['turn_provenance_unverified', 'identity_missing', 'identity_unverified_or_invalid',
                'canonical_subject_missing', 'consent_missing_or_invalid', 'session_invalid', 'authorization_context_binding_mismatch']);
            return askable.has(bindingFailure) ? ask(bindingFailure) : deny(bindingFailure);
        }
        if (input.scope.kind === 'shared') return ask('shared_memory_requires_explicit_confirmation');
        return result('ELIGIBLE_HYPOTHETICAL', ['hypothetical_requirements_satisfied_no_authority_issued']);
    } catch {
        return deny('gate_input_invalid');
    }
}

export function isHypotheticalAutomaticMemoryGateDecision(value) {
    return exactRecord(value, ['decision', 'mode', 'executable', 'reasonCodes'])
        && ['ELIGIBLE_HYPOTHETICAL', 'ASK', 'DENY'].includes(value.decision)
        && value.mode === 'hypothetical' && value.executable === false
        && Array.isArray(value.reasonCodes) && value.reasonCodes.length > 0
        && value.reasonCodes.every(code => typeof code === 'string');
}
