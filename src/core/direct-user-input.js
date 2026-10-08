import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { parseMemoryCommand } from '../memory/commands.js';

const turns = new WeakMap();
const runtimeSessions = new WeakMap();
const activeSessions = new Set();
const contextCapabilities = new WeakMap();
const exposureCapabilities = new WeakMap();
const confirmationCapabilities = new WeakMap();
const speakerCapabilities = new WeakMap();
let reader, lines, current, currentContext, reading = false;

function denied() {
    const error = new Error('A current terminal user turn is required.');
    error.code = 'memory_write_not_authorized';
    return error;
}

function expireContext(capability) {
    if (!capability) return;
    const state = contextCapabilities.get(capability);
    if (state) {
        state.session.capabilities.delete(capability);
        if (state.exposureCapability) {
            state.session.capabilities.delete(state.exposureCapability);
            exposureCapabilities.delete(state.exposureCapability);
        }
        if (state.speakerCapability) {
            state.session.capabilities.delete(state.speakerCapability);
            speakerCapabilities.delete(state.speakerCapability);
        }
    }
    contextCapabilities.delete(capability);
}

function closeSession(session) {
    if (!session) return;
    for (const capability of session.capabilities) {
        contextCapabilities.delete(capability);
        exposureCapabilities.delete(capability);
        speakerCapabilities.delete(capability);
    }
    for (const capability of session.confirmations) confirmationCapabilities.delete(capability);
    session.capabilities.clear();
    session.confirmations.clear();
    session.activeTurnId = null;
    session.closed = true;
    activeSessions.delete(session);
}

/** The sole issuer: reads the process terminal, never a caller-supplied string,
 * stream, callback, factory, or event. The OS input owner is the trust root.
 * Arbitrary code execution/OS control is outside this in-process data boundary.
 * No model/tool API is wired to this reader. A newer read expires the old turn.
 */
export async function readDirectUserTurn(recipient) {
    if (arguments.length !== 1 || !recipient || typeof recipient !== 'object' || reading) throw denied();
    reading = true;
    if (current) turns.delete(current);
    if (currentContext) expireContext(currentContext);
    try {
        if (!reader) {
            reader = createInterface({ input: stdin, output: stdout, crlfDelay: Infinity,
                terminal: Boolean(stdin.isTTY && stdout.isTTY) });
            lines = reader[Symbol.asyncIterator]();
        }
        if (stdin.isTTY) stdout.write('Vos > ');
        const next = await lines.next();
        if (next.done) {
            for (const session of activeSessions) closeSession(session);
            runtimeSessions.delete(recipient);
            current = undefined;
            currentContext = undefined;
            return null;
        }
        let session = runtimeSessions.get(recipient);
        if (!session || session.closed) {
            session = { sessionId: randomUUID(), principalId: `local-cli-session:${randomUUID()}`,
                principalKind: 'local_runtime_session', activeTurnId: null, capabilities: new Set(),
                confirmations: new Set(), closed: false };
            runtimeSessions.set(recipient, session);
            activeSessions.add(session);
        }
        const turnId = randomUUID();
        for (const proof of session.confirmations) confirmationCapabilities.delete(proof);
        session.confirmations.clear();
        const sourceTextSha256 = createHash('sha256').update(next.value, 'utf8').digest('hex');
        session.activeTurnId = turnId;
        const command = parseMemoryCommand(next.value);
        const capability = Object.freeze(Object.create(null));
        turns.set(capability, { recipient, command: structuredClone(command), used: false });
        current = capability;
        const runtimeContextCapability = Object.freeze(Object.create(null));
        const runtimeExposureCapability = Object.freeze(Object.create(null));
        const speakerIdentityCapability = Object.freeze(Object.create(null));
        contextCapabilities.set(runtimeContextCapability, {
            recipient, session, turnId, sourceTextSha256, origin: 'local_cli',
            purpose: 'automatic_memory_assessment', consumed: false, exposureCapability: runtimeExposureCapability,
            speakerCapability: speakerIdentityCapability,
        });
        exposureCapabilities.set(runtimeExposureCapability, {
            recipient, session, turnId, sourceTextSha256, origin: 'local_cli',
            purpose: 'automatic_memory_exposure_recording', consumed: false,
        });
        speakerCapabilities.set(speakerIdentityCapability, {
            recipient, session, turnId, sourceTextSha256, origin: 'local_cli', consumed: false,
            runtimeContextCapability,
        });
        turns.get(capability).runtimeContextCapability = runtimeContextCapability;
        session.capabilities.add(runtimeContextCapability);
        session.capabilities.add(runtimeExposureCapability);
        session.capabilities.add(speakerIdentityCapability);
        currentContext = runtimeContextCapability;
        return Object.freeze({ message: next.value, command, capability, runtimeContextCapability,
            runtimeExposureCapability, speakerIdentityCapability });
    } finally { reading = false; }
}

function exactConfirmationInput(input) {
    const keys = ['recipient', 'requestId', 'operationFingerprint', 'preview', 'phrase'];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) return false;
    const own = Reflect.ownKeys(input);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))
        && input.recipient && typeof input.recipient === 'object'
        && typeof input.requestId === 'string' && /^[0-9a-f-]{36}$/u.test(input.requestId)
        && typeof input.operationFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(input.operationFingerprint)
        && typeof input.preview === 'string' && input.preview.length <= 4000
        && typeof input.phrase === 'string'
        && (/^CONFIRM ADD [A-F0-9]{8,80}$/u.test(input.phrase)
            || /^CONFIRM REPLACE mem_[0-9a-f-]{36} [A-F0-9]{8,80}$/u.test(input.phrase)
            || /^CONFIRM LINK SELF [A-F0-9]{8,80}$/u.test(input.phrase)
            || /^CONFIRM REVOKE SELF [A-F0-9]{8,80}$/u.test(input.phrase));
}

function confirmationDisplayText(value) {
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u001b]/gu, ' ').slice(0, 4000);
}

/**
 * Displays a code-owned preview and consumes the next real stdin line as a
 * confirmation event. The line is never returned as a conversational turn.
 * This proves only local input origin, not human identity or OS ownership.
 */
export async function readDirectUserConfirmation(input) {
    if (arguments.length !== 1 || !exactConfirmationInput(input) || reading) throw denied();
    const session = runtimeSessions.get(input.recipient);
    if (!session || session.closed) throw denied();
    reading = true;
    if (current) turns.delete(current);
    if (currentContext) expireContext(currentContext);
    current = undefined;
    currentContext = undefined;
    try {
        if (!reader) {
            reader = createInterface({ input: stdin, output: stdout, crlfDelay: Infinity,
                terminal: Boolean(stdin.isTTY && stdout.isTTY) });
            lines = reader[Symbol.asyncIterator]();
        }
        stdout.write('\n' + confirmationDisplayText(input.preview) + '\n');
        stdout.write(`Para confirmar, escribí exactamente: ${input.phrase}\n> `);
        const next = await lines.next();
        if (next.done) {
            for (const active of activeSessions) closeSession(active);
            runtimeSessions.delete(input.recipient);
            return null;
        }
        const confirmationTurnId = randomUUID();
        session.activeTurnId = confirmationTurnId;
        if (next.value !== input.phrase) return Object.freeze({ confirmed: false });
        const capability = Object.freeze(Object.create(null));
        confirmationCapabilities.set(capability, { recipient: input.recipient, session, sessionId: session.sessionId,
            confirmationTurnId, requestId: input.requestId, operationFingerprint: input.operationFingerprint,
            phrase: input.phrase, consumed: false });
        session.confirmations.add(capability);
        return Object.freeze({ confirmed: true, capability });
    } finally { reading = false; }
}

/** Consume local confirmation proof once, including when a binding mismatches. */
export function consumeDirectUserConfirmation(capability, binding) {
    const state = capability && typeof capability === 'object' ? confirmationCapabilities.get(capability) : null;
    if (!state || state.consumed) throw denied();
    state.consumed = true;
    state.session.confirmations.delete(capability);
    confirmationCapabilities.delete(capability);
    const keys = ['recipient', 'requestId', 'operationFingerprint', 'phrase'];
    const validBinding = binding && typeof binding === 'object' && !Array.isArray(binding)
        && Object.getPrototypeOf(binding) === Object.prototype && Reflect.ownKeys(binding).length === keys.length
        && Reflect.ownKeys(binding).every(key => typeof key === 'string' && keys.includes(key)
            && Object.hasOwn(Object.getOwnPropertyDescriptor(binding, key) ?? {}, 'value'))
        && binding.recipient === state.recipient && binding.requestId === state.requestId
        && binding.operationFingerprint === state.operationFingerprint && binding.phrase === state.phrase;
    if (!validBinding || state.session.closed || runtimeSessions.get(state.recipient) !== state.session
        || state.session.activeTurnId !== state.confirmationTurnId || currentContext !== undefined) throw denied();
    return Object.freeze({ sessionId: state.sessionId, confirmationTurnId: state.confirmationTurnId,
        requestId: state.requestId, operationFingerprint: state.operationFingerprint });
}

/** Non-authorizing lifecycle check used to invalidate internal capabilities. */
export function isTrustedLocalTurnActive(recipient, sessionId, turnId) {
    const session = recipient && typeof recipient === 'object' ? runtimeSessions.get(recipient) : null;
    return Boolean(session && !session.closed && session.sessionId === sessionId && session.activeTurnId === turnId);
}

export function consumeDirectUserTurn(capability, recipient) {
    const turn = turns.get(capability);
    if (!turn || turn.used || turn.recipient !== recipient) throw denied();
    turn.used = true;
    return structuredClone(turn.command);
}

export function isDirectUserTurnCurrent(capability, recipient) {
    return turns.has(capability) && turns.get(capability).recipient === recipient;
}

export function releaseDirectUserTurn(capability) {
    turns.delete(capability);
    // Provenance remains valid only for the post-response completion window.
}

/** Consumes a one-use, purpose-bound proof issued only while reading real stdin.
 * The first verification attempt consumes it, including recipient/text failures.
 */
export function consumeTrustedLocalTurnContext(capability, recipient, originalText) {
    const state = capability && typeof capability === 'object' ? contextCapabilities.get(capability) : null;
    if (!state || state.consumed) throw denied();
    state.consumed = true;
    const actualHash = typeof originalText === 'string'
        ? createHash('sha256').update(originalText, 'utf8').digest('hex') : null;
    if (state.recipient !== recipient || state.session.closed
        || state.session.activeTurnId !== state.turnId || currentContext !== capability
        || actualHash !== state.sourceTextSha256) throw denied();
    return Object.freeze({ sessionId: state.session.sessionId, turnId: state.turnId,
        principalId: state.session.principalId, principalKind: state.session.principalKind,
        origin: state.origin, sourceTextSha256: state.sourceTextSha256,
        purpose: state.purpose, permissionScopes: Object.freeze([]) });
}

/** Consume a separate, stdin-issued proof for trusted speaker-context resolution.
 * The returned local principal is a runtime session label, never authentication.
 */
export function consumeTrustedLocalSpeakerContext(capability, recipient, originalText) {
    const state = capability && typeof capability === 'object' ? speakerCapabilities.get(capability) : null;
    if (!state || state.consumed) throw denied();
    state.consumed = true;
    speakerCapabilities.delete(capability);
    state.session.capabilities.delete(capability);
    const actualHash = typeof originalText === 'string'
        ? createHash('sha256').update(originalText, 'utf8').digest('hex') : null;
    if (state.recipient !== recipient || state.session.closed
        || state.session.activeTurnId !== state.turnId || currentContext !== state.runtimeContextCapability
        || actualHash !== state.sourceTextSha256 || runtimeSessions.get(recipient) !== state.session) throw denied();
    return Object.freeze({ origin: 'direct_user', principalId: state.session.principalId,
        principalKind: 'local_runtime_session', authenticationState: 'unverified_local_session',
        sessionId: state.session.sessionId, turnId: state.turnId,
        sourceTextSha256: state.sourceTextSha256, selfBindingStatus: 'unlinked', selfPersonId: null });
}

/** Consumes the separate proof used by trusted runtime source-exposure hooks. */
export function consumeTrustedLocalTurnExposure(capability, recipient, originalText) {
    const state = capability && typeof capability === 'object' ? exposureCapabilities.get(capability) : null;
    if (!state || state.consumed) throw denied();
    state.consumed = true;
    const actualHash = typeof originalText === 'string'
        ? createHash('sha256').update(originalText, 'utf8').digest('hex') : null;
    if (state.recipient !== recipient || state.session.closed
        || state.session.activeTurnId !== state.turnId || actualHash !== state.sourceTextSha256
        || runtimeSessions.get(recipient) !== state.session) throw denied();
    return Object.freeze({ sessionId: state.session.sessionId, turnId: state.turnId,
        principalId: state.session.principalId, principalKind: state.session.principalKind,
        origin: state.origin, sourceTextSha256: state.sourceTextSha256,
        purpose: state.purpose, permissionScopes: Object.freeze([]) });
}

/** End the post-response provenance window; it grants no operation permission. */
export function finalizeTrustedLocalTurnContext(capability, recipient) {
    const state = capability && typeof capability === 'object' ? contextCapabilities.get(capability) : null;
    if (!state || state.recipient !== recipient) return false;
    const currentTurn = state.session.activeTurnId === state.turnId;
    expireContext(capability);
    if (currentTurn) state.session.activeTurnId = null;
    if (currentContext === capability) currentContext = undefined;
    return true;
}

export function closeDirectUserSession(recipient) {
    const session = recipient && typeof recipient === 'object' ? runtimeSessions.get(recipient) : null;
    if (session) closeSession(session);
    runtimeSessions.delete(recipient);
    if (currentContext && contextCapabilities.get(currentContext)?.session === session) expireContext(currentContext);
}

export function closeDirectUserInput() {
    if (current) turns.delete(current);
    if (currentContext) expireContext(currentContext);
    for (const session of activeSessions) closeSession(session);
    current = undefined;
    currentContext = undefined;
    // WeakMap state is process-private and all prior sessions are now closed.
    reader?.close();
    stdin.pause();
    reader = undefined; lines = undefined; current = undefined;
}
