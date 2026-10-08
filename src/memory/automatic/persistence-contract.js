import { createHash } from 'node:crypto';
import { normalizeAutomaticMemoryProposal } from './schema.js';
import { planAutomaticMemoryPersistence } from './planner.js';

export const AUTOMATIC_MEMORY_CONTRACT_VERSION = 'automatic-memory-b2a-contract';

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Builds an advisory persistence contract. This module deliberately has no
 * MemoryService, repository, authorization issuer, or executor dependency.
 * Every result remains blocked until a separately reviewed runtime/service
 * boundary exists.
 */
export function createAutomaticMemoryPersistenceContract(input) {
    const keys = input && Object.hasOwn(input, 'trustedSpeakerContext')
        ? ['text', 'proposal', 'snapshot', 'trustedSpeakerContext'] : ['text', 'proposal', 'snapshot'];
    if (!exactRecord(input, keys)
        || typeof input.text !== 'string' || !input.text.isWellFormed()
        || (input.snapshot !== null && !exactRecord(input.snapshot, ['snapshot', 'revision', 'digest']))) {
        return { success: false, error: { code: 'persistence_contract_input_invalid' } };
    }

    const normalized = normalizeAutomaticMemoryProposal(input.proposal);
    if (!normalized.success) return { success: false, error: { code: normalized.error.code } };
    const plan = planAutomaticMemoryPersistence(input);
    if (!plan.success) return plan;

    const sourceTextSha256 = digest(input.text);
    const snapshotBinding = input.snapshot === null ? null : {
        revision: input.snapshot.revision,
        digest: input.snapshot.digest,
        snapshotSha256: plan.snapshotSha256,
        freshnessChecked: false,
    };
    const operations = plan.operations.map(operation => {
        const candidate = normalized.proposal.candidates[operation.candidateIndex];
        const candidateSha256 = digest(candidate);
        const evidenceSha256 = digest(candidate.evidence_quote);
        const idempotencyKey = digest({ version: AUTOMATIC_MEMORY_CONTRACT_VERSION,
            operation: operation.operation, candidateSha256, sourceTextSha256, snapshotBinding,
            targetAssertionId: operation.targetAssertionId ?? null });
        return {
            ...operation,
            contractVersion: AUTOMATIC_MEMORY_CONTRACT_VERSION,
            executable: false,
            writeReady: false,
            committed: false,
            idempotency: { key: idempotencyKey, recorded: false },
            sourceBinding: { sourceTextSha256, evidenceSha256 },
            snapshotBinding,
            provenancePlan: {
                sourceKind: 'inference',
                originTrust: 'derived_untrusted',
                derivation: 'inferred',
                extractionConfidence: candidate.linguistic_confidence,
                confidenceIsUntrustedModelHint: true,
            },
            runtimeBinding: { authenticatedUserId: null, conversationId: null, turnId: null,
                status: 'unavailable' },
            authorization: { status: 'unavailable', granted: false, oneUse: true,
                confirmationRequired: operation.operation === 'REPLACE' || operation.confirmationRequired },
            blockingReasons: ['automatic_runtime_capability_unavailable',
                ...(snapshotBinding && !snapshotBinding.freshnessChecked ? ['snapshot_freshness_not_checked'] : [])],
        };
    });

    return {
        success: true,
        contractVersion: AUTOMATIC_MEMORY_CONTRACT_VERSION,
        executable: false,
        writeReady: false,
        runtimeAuthorizationAvailable: false,
        freshnessChecked: false,
        snapshotBinding,
        operations,
    };
}
