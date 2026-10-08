import { consumeTrustedLocalTurnContext } from '../../core/direct-user-input.js';
import { assessAutomaticMemoryAuthorization } from './authorization-contract.js';

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

/** Consumes verified local-turn evidence for assessment only. It never grants
 * permission, creates an executor, or makes an operation write-ready.
 */
export function assessAutomaticMemoryWithTrustedLocalContext(input) {
    let context;
    try {
        if (!exactRecord(input, ['text', 'proposal', 'snapshot', 'operationIndex', 'recipient', 'runtimeContextCapability'])) {
            return { success: false, error: { code: 'runtime_context_input_invalid' } };
        }
        context = consumeTrustedLocalTurnContext(input.runtimeContextCapability, input.recipient, input.text);
    } catch {
        return { success: false, error: { code: 'runtime_context_input_invalid' } };
    }
    const baseInput = { text: input.text, proposal: input.proposal, snapshot: input.snapshot,
        operationIndex: input.operationIndex };
    const base = assessAutomaticMemoryAuthorization({ ...baseInput, contextClaims: null });
    if (!base.success) return { success: false, error: { code: base.error.code }, runtimeContextVerified: true };
    const binding = base.expectedBinding;
    const claims = {
        principalId: context.principalId,
        turnId: context.turnId,
        sourceTextSha256: context.sourceTextSha256,
        evidenceSha256: binding.evidenceSha256,
        operationFingerprint: binding.operationFingerprint,
        snapshotRevision: binding.snapshotRevision,
        snapshotDigest: binding.snapshotDigest,
        permissionScopes: [],
    };
    const assessment = assessAutomaticMemoryAuthorization({ ...baseInput, contextClaims: claims });
    return { success: assessment.success, runtimeContextVerified: true,
        runtimeContext: { origin: context.origin, principalKind: context.principalKind,
            permissionScopes: [] }, assessment };
}
