import { createHash, randomUUID } from 'node:crypto';
import { consumeTrustedLocalTurnContext, readDirectUserConfirmation,
    consumeDirectUserConfirmation, isTrustedLocalTurnActive } from '../../core/direct-user-input.js';
import { createAutomaticMemoryPersistenceContract } from './persistence-contract.js';
import { normalizeAutomaticMemoryProposal } from './schema.js';

const pendingRequests = new WeakMap();
const grants = new WeakMap();
const activeByRecipient = new WeakMap();
const PENDING_TTL_MS = 2 * 60 * 1000;
const GRANT_TTL_MS = 60 * 1000;

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function stableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
        .map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function digestJson(value) { return sha256(stableJson(value)); }

function safeDisplay(value, max = 500) {
    return [...String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u001b]/gu, ' ')]
        .slice(0, max).join('').replace(/\s+/gu, ' ').trim();
}

function buildPreview(operation, candidate, snapshot) {
    const fields = [
        'Automatic Memory: confirmación directa requerida.',
        `Operación: ${operation.operation}`,
        'Entidad: Self (persona propietaria del store; esto no autentica identidad).',
        `Atributo: ${safeDisplay(candidate.predicate, 128)}`,
    ];
    if (operation.operation === 'REPLACE') {
        const target = snapshot.assertions.find(item => item.id === operation.targetAssertionId);
        if (!target || target.status !== 'active' || target.object?.type !== 'text') return null;
        fields.push(`Target exacto: ${target.id}`);
        fields.push(`Valor anterior: ${safeDisplay(target.object.value)}`);
        fields.push(`Valor nuevo: ${safeDisplay(candidate.value_text)}`);
    } else {
        fields.push(`Valor que se agregaría: ${safeDisplay(candidate.value_text)}`);
    }
    fields.push(`Contexto de evidencia: ${safeDisplay(candidate.evidence_quote)}`);
    fields.push('Provenance: inferencia no confiable; la aprobación no la convierte en una cita explícita.');
    return fields.join('\n');
}

function fail(code) { return { success: false, error: { code } }; }

/**
 * Prepare a private, immutable request from a real current stdin turn and the
 * dry-run B.2a contract. This module has no repository, service, or writer.
 */
export function prepareAutomaticMemoryAuthorization(input) {
    const keys = ['text', 'proposal', 'snapshot', 'operationIndex', 'recipient', 'runtimeContextCapability'];
    if (!exactRecord(input, keys) || typeof input.text !== 'string' || !input.text.isWellFormed()
        || !Number.isSafeInteger(input.operationIndex) || input.operationIndex < 0
        || !input.recipient || typeof input.recipient !== 'object'
        || !input.runtimeContextCapability || typeof input.runtimeContextCapability !== 'object'
        || !input.snapshot || typeof input.snapshot !== 'object') return fail('authorization_prepare_input_invalid');

    let turnContext;
    try { turnContext = consumeTrustedLocalTurnContext(input.runtimeContextCapability, input.recipient, input.text); }
    catch { return fail('trusted_source_turn_invalid'); }
    if (turnContext.origin !== 'local_cli' || turnContext.principalKind !== 'local_runtime_session'
        || turnContext.purpose !== 'automatic_memory_assessment' || turnContext.permissionScopes.length !== 0) {
        return fail('trusted_source_turn_invalid');
    }

    const contract = createAutomaticMemoryPersistenceContract({ text: input.text,
        proposal: input.proposal, snapshot: input.snapshot });
    if (!contract.success) return fail(contract.error?.code ?? 'persistence_contract_invalid');
    const operation = contract.operations[input.operationIndex];
    if (!operation) return fail('authorization_operation_not_found');
    if (!['ADD', 'REPLACE'].includes(operation.operation)) {
        return { success: true, prepared: false, disposition: operation.operation,
            reasonCodes: [...operation.reasonCodes], executable: false, writeReady: false };
    }
    if (!contract.snapshotBinding || operation.writeReady !== false || operation.authorization?.granted !== false
        || (operation.operation === 'ADD' && operation.targetAssertionId !== null)
        || (operation.operation === 'REPLACE' && typeof operation.targetAssertionId !== 'string')) {
        return fail('authorization_operation_not_canonical');
    }
    const normalized = normalizeAutomaticMemoryProposal(input.proposal);
    if (!normalized.success) return fail(normalized.error.code);
    const candidate = normalized.proposal.candidates[operation.candidateIndex];
    if (!candidate) return fail('authorization_candidate_not_found');

    const existing = activeByRecipient.get(input.recipient);
    if (existing && pendingRequests.get(existing)?.expiresAt > Date.now()) return fail('authorization_request_already_pending');
    if (existing) pendingRequests.delete(existing);

    const requestId = randomUUID();
    const snapshotBinding = Object.freeze({ revision: contract.snapshotBinding.revision,
        digest: contract.snapshotBinding.digest, snapshotSha256: contract.snapshotBinding.snapshotSha256 });
    const operationFingerprint = digestJson({ version: 'automatic-memory-b2b7-coordinator-v1',
        operation: operation.operation, candidate, idempotencyKey: operation.idempotency.key,
        sourceBinding: operation.sourceBinding, snapshotBinding,
        targetAssertionId: operation.targetAssertionId ?? null });
    const preview = buildPreview(operation, candidate, input.snapshot.snapshot);
    if (!preview) return fail('authorization_target_invalid');
    const challenge = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
    const phrase = operation.operation === 'REPLACE'
        ? `CONFIRM REPLACE ${operation.targetAssertionId} ${challenge}`
        : `CONFIRM ADD ${challenge}`;
    const handle = Object.freeze(Object.create(null));
    pendingRequests.set(handle, { recipient: input.recipient, requestId, operation: structuredClone(operation),
        candidate: structuredClone(candidate), snapshotBinding, operationFingerprint, preview, phrase,
        sessionId: turnContext.sessionId, sourceTurnId: turnContext.turnId,
        expiresAt: Date.now() + PENDING_TTL_MS, consumed: false });
    activeByRecipient.set(input.recipient, handle);
    return Object.freeze({ success: true, prepared: true, request: handle, requestId,
        operation: operation.operation, operationFingerprint, snapshotBinding,
        preview, sourceTurnId: turnContext.turnId, snapshotFreshnessChecked: false,
        authorizationGranted: false, executable: false, writeReady: false });
}

/** Displays the exact preview through the trusted CLI boundary and issues a
 * one-use opaque grant only after that reader consumes the exact confirmation.
 */
export async function confirmAutomaticMemoryAuthorization(request, recipient) {
    const state = request && typeof request === 'object' ? pendingRequests.get(request) : null;
    if (!state || state.consumed) return fail('authorization_request_invalid');
    state.consumed = true;
    pendingRequests.delete(request);
    if (activeByRecipient.get(state.recipient) === request) activeByRecipient.delete(state.recipient);
    if (state.recipient !== recipient || Date.now() > state.expiresAt
        || !isTrustedLocalTurnActive(state.recipient, state.sessionId, state.sourceTurnId)) {
        return fail('authorization_request_stale_or_wrong_recipient');
    }
    let confirmation;
    try {
        confirmation = await readDirectUserConfirmation({ recipient, requestId: state.requestId,
            operationFingerprint: state.operationFingerprint, preview: state.preview, phrase: state.phrase });
    } catch { return fail('trusted_confirmation_unavailable'); }
    if (!confirmation?.confirmed || !confirmation.capability) return fail('trusted_confirmation_rejected');
    let proof;
    try {
        proof = consumeDirectUserConfirmation(confirmation.capability, { recipient,
            requestId: state.requestId, operationFingerprint: state.operationFingerprint, phrase: state.phrase });
    } catch { return fail('trusted_confirmation_invalid'); }
    if (Date.now() > state.expiresAt) return fail('authorization_request_expired');
    const capability = Object.freeze(Object.create(null));
    grants.set(capability, { recipient, requestId: state.requestId, operation: state.operation.operation,
        targetAssertionId: state.operation.targetAssertionId ?? null,
        operationFingerprint: state.operationFingerprint, snapshotBinding: state.snapshotBinding,
        sessionId: proof.sessionId, sourceTurnId: state.sourceTurnId,
        confirmationTurnId: proof.confirmationTurnId,
        expiresAt: Date.now() + GRANT_TTL_MS, consumed: false });
    return Object.freeze({ success: true, authorizationGranted: true, oneUse: true,
        operation: state.operation.operation, operationFingerprint: state.operationFingerprint,
        snapshotBinding: state.snapshotBinding, requestId: state.requestId,
        capability, executable: false, writeReady: false });
}

/**
 * Consumes on every verification attempt. This verifier returns binding facts
 * only; no persistence API consumes the result in this phase.
 */
export function consumeAutomaticMemoryAuthorization(capability, expected) {
    const state = capability && typeof capability === 'object' ? grants.get(capability) : null;
    if (!state || state.consumed) return fail('authorization_capability_invalid_or_consumed');
    state.consumed = true;
    grants.delete(capability);
    const keys = ['recipient', 'operation', 'operationFingerprint', 'snapshotRevision', 'snapshotDigest', 'targetAssertionId'];
    if (!exactRecord(expected, keys) || expected.recipient !== state.recipient
        || expected.operation !== state.operation || expected.operationFingerprint !== state.operationFingerprint
        || expected.snapshotRevision !== state.snapshotBinding.revision
        || expected.snapshotDigest !== state.snapshotBinding.digest
        || expected.targetAssertionId !== state.targetAssertionId
        || Date.now() > state.expiresAt
        || !isTrustedLocalTurnActive(state.recipient, state.sessionId, state.confirmationTurnId)) {
        return fail('authorization_binding_mismatch_or_stale');
    }
    return Object.freeze({ success: true, authorized: true, oneUse: true,
        requestId: state.requestId, operation: state.operation,
        operationFingerprint: state.operationFingerprint, snapshotBinding: state.snapshotBinding,
        sessionId: state.sessionId, sourceTurnId: state.sourceTurnId,
        confirmationTurnId: state.confirmationTurnId,
        targetAssertionId: state.targetAssertionId, executable: false, writeReady: false });
}

/** Cancel pending UI state; this never revokes an already returned grant. */
export function cancelAutomaticMemoryAuthorization(request, recipient) {
    const state = request && typeof request === 'object' ? pendingRequests.get(request) : null;
    if (!state || state.recipient !== recipient) return false;
    state.consumed = true;
    pendingRequests.delete(request);
    if (activeByRecipient.get(recipient) === request) activeByRecipient.delete(recipient);
    return true;
}
