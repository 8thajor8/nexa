import { createHash } from 'node:crypto';
import { normalizeAutomaticMemoryProposal } from './schema.js';
import { createAutomaticMemoryPersistenceContract } from './persistence-contract.js';

export const AUTOMATIC_MEMORY_AUTHORIZATION_CONTRACT_VERSION = 'automatic-memory-b2b1-authorization-contract';

const CLAIM_KEYS = ['principalId', 'turnId', 'sourceTextSha256', 'evidenceSha256',
    'operationFingerprint', 'snapshotRevision', 'snapshotDigest', 'permissionScopes'];
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function boundedStringArray(value, maximum) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false;
    const own = Reflect.ownKeys(value);
    if (own.length !== value.length + 1 || !own.includes('length')) return false;
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
            || typeof descriptor.value !== 'string' || !TOKEN.test(descriptor.value)) return false;
    }
    return true;
}

function sha256(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function buildAssessment(input) {
    if (!record(input, ['text', 'proposal', 'snapshot', 'operationIndex', 'contextClaims'])
        || typeof input.text !== 'string' || !input.text.isWellFormed()
        || !Number.isSafeInteger(input.operationIndex) || input.operationIndex < 0
        || (input.snapshot !== null && !record(input.snapshot, ['snapshot', 'revision', 'digest']))) {
        return { success: false, error: { code: 'authorization_assessment_input_invalid' } };
    }

    const normalized = normalizeAutomaticMemoryProposal(input.proposal);
    if (!normalized.success) return { success: false, error: { code: normalized.error.code } };
    const contract = createAutomaticMemoryPersistenceContract({ text: input.text,
        proposal: input.proposal, snapshot: input.snapshot });
    if (!contract.success) return contract;
    const operation = contract.operations[input.operationIndex];
    if (!operation) return { success: false, error: { code: 'authorization_operation_not_found' } };

    const candidate = normalized.proposal.candidates[operation.candidateIndex];
    const sourceTextSha256 = sha256(input.text);
    const evidenceSha256 = sha256(candidate.evidence_quote);
    const requiredScope = operation.operation === 'REPLACE'
        ? 'memory.automatic.replace' : operation.operation === 'ADD' ? 'memory.automatic.add' : null;
    const bindingData = {
        version: AUTOMATIC_MEMORY_AUTHORIZATION_CONTRACT_VERSION,
        operation: operation.operation,
        candidateIndex: operation.candidateIndex,
        candidateSha256: sha256(candidate),
        sourceTextSha256,
        evidenceSha256,
        snapshotRevision: contract.snapshotBinding?.revision ?? null,
        snapshotDigest: contract.snapshotBinding?.digest ?? null,
        targetAssertionId: operation.targetAssertionId ?? null,
        requiredScope,
    };
    const operationFingerprint = sha256(bindingData);
    const expectedBinding = {
        principalId: null,
        turnId: null,
        sourceTextSha256,
        evidenceSha256,
        operationFingerprint,
        snapshotRevision: bindingData.snapshotRevision,
        snapshotDigest: bindingData.snapshotDigest,
        permissionScopes: requiredScope ? [requiredScope] : [],
    };

    const claims = input.contextClaims;
    const validClaimsShape = record(claims, CLAIM_KEYS)
        && typeof claims.principalId === 'string' && TOKEN.test(claims.principalId)
        && typeof claims.turnId === 'string' && TOKEN.test(claims.turnId)
        && SHA256.test(claims.sourceTextSha256)
        && SHA256.test(claims.evidenceSha256)
        && SHA256.test(claims.operationFingerprint)
        && (claims.snapshotRevision === null || (Number.isSafeInteger(claims.snapshotRevision) && claims.snapshotRevision >= 0))
        && (claims.snapshotDigest === null || SHA256.test(claims.snapshotDigest))
        && boundedStringArray(claims.permissionScopes, 8);
    const operationClaimsMatch = Boolean(validClaimsShape && requiredScope && contract.snapshotBinding
        && claims.sourceTextSha256 === expectedBinding.sourceTextSha256
        && claims.evidenceSha256 === expectedBinding.evidenceSha256
        && claims.operationFingerprint === expectedBinding.operationFingerprint
        && claims.snapshotRevision === expectedBinding.snapshotRevision
        && claims.snapshotDigest === expectedBinding.snapshotDigest
        && claims.permissionScopes.length === 1 && claims.permissionScopes[0] === requiredScope);

    let policyEligibility = 'denied';
    const reasonCodes = [];
    if (!['ADD', 'REPLACE'].includes(operation.operation)) reasonCodes.push('operation_not_authorizable');
    else if (!contract.snapshotBinding) reasonCodes.push('validated_snapshot_required');
    else if (operation.operation === 'REPLACE') {
        policyEligibility = 'confirmation_required';
        reasonCodes.push('trusted_replace_confirmation_unavailable');
    } else if (!operationClaimsMatch) reasonCodes.push(validClaimsShape ? 'context_claims_mismatch' : 'context_claims_missing_or_invalid');
    else policyEligibility = 'eligible';

    // B.2b.1 has no trusted runtime capability verifier or durable replay ledger.
    // Matching ordinary data claims must never be interpreted as proof.
    const blockers = ['trusted_runtime_capability_unavailable', 'principal_authentication_unavailable',
        'turn_authentication_unavailable', 'persistent_replay_ledger_unavailable'];
    if (operation.operation === 'REPLACE') blockers.push('trusted_replace_confirmation_unavailable');
    if (contract.snapshotBinding && !contract.snapshotBinding.freshnessChecked) blockers.push('repository_snapshot_freshness_unavailable');
    return {
        success: true,
        contractVersion: AUTOMATIC_MEMORY_AUTHORIZATION_CONTRACT_VERSION,
        operation: operation.operation,
            policyEligibility,
            authorizationRequestEligible: false,
            authorizationRequestStatus: 'blocked_trusted_context_unavailable',
            operationClaimsMatch,
        claims: {
            principalIdPresent: Boolean(validClaimsShape),
            principalAuthenticated: false,
            turnIdPresent: Boolean(validClaimsShape),
            turnAuthenticated: false,
            evidenceMatches: Boolean(validClaimsShape && claims.evidenceSha256 === expectedBinding.evidenceSha256
                && claims.sourceTextSha256 === expectedBinding.sourceTextSha256),
            operationMatches: Boolean(validClaimsShape && claims.operationFingerprint === expectedBinding.operationFingerprint),
            snapshotMatches: Boolean(validClaimsShape && claims.snapshotRevision === expectedBinding.snapshotRevision
                && claims.snapshotDigest === expectedBinding.snapshotDigest),
            permissionScopeMatches: Boolean(validClaimsShape && requiredScope && claims.permissionScopes.length === 1
                && claims.permissionScopes[0] === requiredScope),
        },
        expectedBinding,
            authorization: { status: 'denied', granted: false, reasonCodes: [...new Set([...reasonCodes, ...blockers])] },
        replayProtection: { status: 'unavailable', persistentConsumptionRecord: false },
        confirmation: { required: operation.operation === 'REPLACE', trustedProofAvailable: false },
        executable: false,
        writeReady: false,
    };
}

/**
 * Deterministically assesses whether untrusted context claims match the exact
 * B.2a operation. Claims are never proof: this version has no trusted-boundary
 * verifier, authorization issuer, replay ledger, or executor, so it always
 * returns authorization denied and executable false.
 */
export function assessAutomaticMemoryAuthorization(input) {
    try { return buildAssessment(input); }
    catch { return { success: false, error: { code: 'authorization_assessment_invalid' } }; }
}
