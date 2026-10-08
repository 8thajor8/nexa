import { createHash, randomUUID } from 'node:crypto';
import { consumeTrustedLocalSpeakerContext, consumeDirectUserConfirmation,
    isTrustedLocalTurnActive } from './direct-user-input.js';
import { createWindowsPrincipalProvider } from './windows-principal-provider.js';
import { createWindowsHelloProvider } from './windows-hello-provider.js';

const resolvedContexts = new WeakMap();
const speakerContexts = new WeakMap();
const pendingBindings = new WeakMap();
const PERSON_ID = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PRINCIPAL_ID = /^windows-sid:S-1-(?:\d+-)+\d+$/iu;
const UUID = /^[0-9a-f-]{36}$/iu;

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function denied(code) { return Object.freeze({ success: false, error: Object.freeze({ code }) }); }

/** Testable volatile store. Production bindings are not persisted in this C.5f stage. */
function createVolatileSelfBindingStore() {
    const bindings = new Map();
    return Object.freeze({
        async get(principalId) { return bindings.get(principalId) ?? null; },
        async set(record) { bindings.set(record.principalId, Object.freeze({ ...record })); return true; },
        async revoke(principalId) { return bindings.delete(principalId); },
    });
}

/**
 * Trusted bridge from a stdin-issued turn proof to a principal and optional
 * verified Self binding. No serializable caller claim can create its output.
 * The application composes the no-argument singleton below. Provider injection
 * exists only for trusted host composition and tests; the agent/tools cannot
 * supply or replace these dependencies.
 */
export function createTrustedSpeakerIdentityBoundary(options = {}) {
    const allowedKeys = ['principalProvider', 'windowsHelloProvider', 'bindingStore', 'ownerSelfProvider'];
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
        || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !allowedKeys.includes(key)
            || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key) ?? {}, 'value')))
        throw new TypeError('speaker_identity_boundary_invalid');
    // Provider injection exists only for node:test fixtures. A normal runtime
    // caller can instantiate only the fail-closed production providers.
    if (Reflect.ownKeys(options).length && !process.env.NODE_TEST_CONTEXT)
        throw new TypeError('speaker_identity_test_injection_unavailable');
    const { principalProvider = createWindowsPrincipalProvider(),
        windowsHelloProvider = createWindowsHelloProvider(), bindingStore = createVolatileSelfBindingStore(),
        ownerSelfProvider = { async getSelfPersonId() { return null; } } } = options;
    if (typeof principalProvider?.getCurrentPrincipal !== 'function'
        || typeof windowsHelloProvider?.verifyUser !== 'function' || typeof bindingStore?.get !== 'function'
        || typeof bindingStore?.set !== 'function' || typeof bindingStore?.revoke !== 'function'
        || typeof ownerSelfProvider?.getSelfPersonId !== 'function')
        throw new TypeError('speaker_identity_boundary_invalid');
    // Dependencies are fixed here. Callers cannot replace the stdin proof
    // verifier or confirmation consumer. The standard app never injects these.

    async function directContext(input) {
        if (!exactRecord(input, ['capability', 'recipient', 'text']) || !input.recipient
            || typeof input.text !== 'string' || !input.text.isWellFormed()) return null;
        try {
            const context = await consumeTrustedLocalSpeakerContext(input.capability, input.recipient, input.text);
            if (context?.origin !== 'direct_user' || context.authenticationState !== 'unverified_local_session'
                || context.selfBindingStatus !== 'unlinked' || context.selfPersonId !== null
                || !UUID.test(context.sessionId ?? '') || !UUID.test(context.turnId ?? '')
                || !/^[a-f0-9]{64}$/u.test(context.sourceTextSha256 ?? '')
                || context.sourceTextSha256 !== sha256(input.text)) return null;
            return context;
        } catch { return null; }
    }

    async function currentPrincipal() {
        try {
            const principal = await principalProvider.getCurrentPrincipal();
            if (!exactRecord(principal, ['id', 'kind', 'authenticationState', 'method'])
                || !PRINCIPAL_ID.test(principal.id ?? '') || principal.kind !== 'windows_account_sid'
                || principal.authenticationState !== 'os_account_session_unverified'
                || principal.method !== 'windows_process_token') return null;
            return principal;
        } catch { return null; }
    }

    async function verifiedBinding(principalId) {
        try {
            const record = await bindingStore.get(principalId);
            if (!exactRecord(record, ['principalId', 'selfPersonId', 'verificationMethod', 'verifiedAt', 'status'])
                || record.principalId !== principalId || !PERSON_ID.test(record.selfPersonId ?? '')
                || record.verificationMethod !== 'windows_hello_user_consent'
                || record.status !== 'active' || typeof record.verifiedAt !== 'string'
                || !Number.isFinite(Date.parse(record.verifiedAt))) return null;
            const ownerSelfId = await ownerSelfProvider.getSelfPersonId();
            return ownerSelfId === record.selfPersonId ? record : null;
        } catch { return null; }
    }

    async function resolveTurn(input) {
        const context = await directContext(input);
        if (!context) return denied('speaker_context_unavailable');
        const principal = await currentPrincipal();
        const binding = principal ? await verifiedBinding(principal.id) : null;
        const capability = Object.freeze(Object.create(null));
        resolvedContexts.set(capability, { recipient: input.recipient, sessionId: context.sessionId,
            turnId: context.turnId, sourceTextSha256: context.sourceTextSha256,
            origin: 'direct_user', principalId: principal?.id ?? null,
            authenticationState: principal ? 'os_account_session_unverified' : 'unknown',
            selfBindingStatus: binding ? 'linked' : 'unlinked', selfPersonId: binding?.selfPersonId ?? null,
            verifyLinkedSelf: async () => Boolean(principal && binding
                && await verifiedBinding(principal.id).then(current => current?.selfPersonId === binding.selfPersonId)),
            consumed: false });
        return Object.freeze({ success: true, capability });
    }

    async function prepareSelfBinding(input) {
        const context = await directContext(input);
        if (!context) return denied('speaker_context_unavailable');
        const principal = await currentPrincipal();
        if (!principal) return denied('windows_principal_unavailable');
        const selfPersonId = await ownerSelfProvider.getSelfPersonId().catch(() => null);
        if (!PERSON_ID.test(selfPersonId ?? '')) return denied('memory2_self_unavailable');
        let verification;
        try { verification = await windowsHelloProvider.verifyUser({ purpose: 'bind_self' }); }
        catch { return denied('windows_hello_unavailable'); }
        if (verification?.status !== 'verified' || verification.method !== 'windows_hello_user_consent')
            return denied(verification?.status === 'not_verified' ? 'windows_hello_not_verified' : 'windows_hello_unavailable');
        const existing = await bindingStore.get(principal.id).catch(() => null);
        if (existing) return denied('self_binding_already_exists');
        const requestId = randomUUID();
        const challenge = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
        const phrase = `CONFIRM LINK SELF ${challenge}`;
        const operationFingerprint = sha256(JSON.stringify({ purpose: 'link_self', principalId: principal.id,
            selfPersonId, sessionId: context.sessionId, turnId: context.turnId, requestId }));
        const request = Object.freeze(Object.create(null));
        pendingBindings.set(request, { action: 'link', recipient: input.recipient, principalId: principal.id,
            selfPersonId, sessionId: context.sessionId, sourceTurnId: context.turnId, requestId,
            operationFingerprint, phrase, expiresAt: Date.now() + 60_000 });
        return Object.freeze({ success: true, request, confirmationInput: Object.freeze({ recipient: input.recipient,
            requestId, operationFingerprint, phrase,
            preview: 'Vincular la cuenta local actual con la entidad Self existente. Esto no autoriza escrituras de memoria.' }) });
    }

    async function prepareSelfBindingRevocation(input) {
        const context = await directContext(input);
        if (!context) return denied('speaker_context_unavailable');
        const principal = await currentPrincipal();
        if (!principal) return denied('windows_principal_unavailable');
        const existing = await verifiedBinding(principal.id);
        if (!existing) return denied('self_binding_not_found');
        let verification;
        try { verification = await windowsHelloProvider.verifyUser({ purpose: 'revoke_self_binding' }); }
        catch { return denied('windows_hello_unavailable'); }
        if (verification?.status !== 'verified' || verification.method !== 'windows_hello_user_consent')
            return denied(verification?.status === 'not_verified' ? 'windows_hello_not_verified' : 'windows_hello_unavailable');
        const requestId = randomUUID();
        const challenge = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
        const phrase = `CONFIRM REVOKE SELF ${challenge}`;
        const operationFingerprint = sha256(JSON.stringify({ purpose: 'revoke_self', principalId: principal.id,
            selfPersonId: existing.selfPersonId, sessionId: context.sessionId, turnId: context.turnId, requestId }));
        const request = Object.freeze(Object.create(null));
        pendingBindings.set(request, { action: 'revoke', recipient: input.recipient, principalId: principal.id,
            selfPersonId: existing.selfPersonId, sessionId: context.sessionId, sourceTurnId: context.turnId,
            requestId, operationFingerprint, phrase, expiresAt: Date.now() + 60_000 });
        return Object.freeze({ success: true, request, confirmationInput: Object.freeze({ recipient: input.recipient,
            requestId, operationFingerprint, phrase,
            preview: 'Revocar el vínculo entre la cuenta local actual y Self.' }) });
    }

    async function completeBinding(input) {
        if (!exactRecord(input, ['request', 'confirmationCapability'])) return denied('self_binding_confirmation_invalid');
        const request = pendingBindings.get(input.request);
        if (!request) return denied('self_binding_request_invalid');
        pendingBindings.delete(input.request);
        if (Date.now() > request.expiresAt) return denied('self_binding_request_expired');
        let proof;
        try { proof = consumeDirectUserConfirmation(input.confirmationCapability, { recipient: request.recipient,
            requestId: request.requestId, operationFingerprint: request.operationFingerprint, phrase: request.phrase }); }
        catch { return denied('self_binding_confirmation_invalid'); }
        if (proof.sessionId !== request.sessionId || !isTrustedLocalTurnActive(request.recipient,
            request.sessionId, proof.confirmationTurnId)) return denied('self_binding_confirmation_invalid');
        if (request.action === 'link') {
            const record = Object.freeze({ principalId: request.principalId, selfPersonId: request.selfPersonId,
                verificationMethod: 'windows_hello_user_consent', verifiedAt: new Date().toISOString(), status: 'active' });
            try { await bindingStore.set(record); } catch { return denied('self_binding_store_unavailable'); }
            return Object.freeze({ success: true, linked: true, authenticationGranted: false, writeAuthorizationGranted: false });
        }
        try { await bindingStore.revoke(request.principalId); }
        catch { return denied('self_binding_store_unavailable'); }
        return Object.freeze({ success: true, revoked: true, authenticationGranted: false, writeAuthorizationGranted: false });
    }

    return Object.freeze({ resolveTurn, prepareSelfBinding, prepareSelfBindingRevocation,
        completeSelfBinding: completeBinding, completeSelfBindingRevocation: completeBinding });
}

/** Runtime-owned singleton. It accepts only capabilities issued by real stdin. */
export const trustedSpeakerIdentityBoundary = createTrustedSpeakerIdentityBoundary();

/** Internal policy consumer: only capabilities issued by the boundary verify. */
export function consumeTrustedSpeakerIdentity(capability, sourceTextSha256) {
    const state = capability && typeof capability === 'object' ? resolvedContexts.get(capability) : null;
    if (!state || state.consumed) return null;
    state.consumed = true;
    resolvedContexts.delete(capability);
    if (state.sourceTextSha256 !== sourceTextSha256
        || !isTrustedLocalTurnActive(state.recipient, state.sessionId, state.turnId)) return null;
    const context = Object.freeze(Object.create(null));
    speakerContexts.set(context, { ...state, consumedForAuthorization: false });
    return context;
}

/** Returns an internal description only for an opaque context minted above. */
export function trustedSpeakerIdentityDetails(context) {
    const state = context && typeof context === 'object' ? speakerContexts.get(context) : null;
    if (!state) return null;
    return Object.freeze({ origin: state.origin, principalId: state.principalId,
        authenticationState: state.authenticationState, selfBindingStatus: state.selfBindingStatus,
        selfPersonId: state.selfPersonId, sessionId: state.sessionId, turnId: state.turnId,
        sourceTextSha256: state.sourceTextSha256 });
}

/** Re-check the current owner Self binding at the write boundary. */
export async function trustedSpeakerIdentityBindingIsCurrent(context) {
    const state = context && typeof context === 'object' ? speakerContexts.get(context) : null;
    if (!state || state.selfBindingStatus !== 'linked' || !PERSON_ID.test(state.selfPersonId ?? '')
        || typeof state.verifyLinkedSelf !== 'function') return false;
    try { return await state.verifyLinkedSelf(); } catch { return false; }
}

/**
 * Explicit one-use transition from a verified source-turn identity context to
 * an authorization request. The original turn must still be active here; the
 * resulting opaque context is then carried only inside the coordinator grant.
 */
export async function consumeTrustedSpeakerAuthorizationContext(context, expected) {
    const state = context && typeof context === 'object' ? speakerContexts.get(context) : null;
    if (!state || state.consumedForAuthorization) return null;
    state.consumedForAuthorization = true;
    const keys = ['recipient', 'text'];
    if (!exactRecord(expected, keys) || expected.recipient !== state.recipient
        || typeof expected.text !== 'string' || sha256(expected.text) !== state.sourceTextSha256
        || !isTrustedLocalTurnActive(state.recipient, state.sessionId, state.turnId)
        || state.origin !== 'direct_user' || state.authenticationState !== 'os_account_session_unverified'
        || state.selfBindingStatus !== 'linked' || !PERSON_ID.test(state.selfPersonId ?? '')) return null;
    try { if (!await state.verifyLinkedSelf()) return null; } catch { return null; }
    return context;
}
