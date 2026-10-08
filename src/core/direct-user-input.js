import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { parseMemoryCommand } from '../memory/commands.js';

const turns = new WeakMap();
const runtimeSessions = new WeakMap();
const activeSessions = new Set();
const contextCapabilities = new WeakMap();
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
    }
    contextCapabilities.delete(capability);
}

function closeSession(session) {
    if (!session) return;
    for (const capability of session.capabilities) contextCapabilities.delete(capability);
    session.capabilities.clear();
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
                principalKind: 'local_runtime_session', activeTurnId: null, capabilities: new Set(), closed: false };
            runtimeSessions.set(recipient, session);
            activeSessions.add(session);
        }
        const turnId = randomUUID();
        const sourceTextSha256 = createHash('sha256').update(next.value, 'utf8').digest('hex');
        session.activeTurnId = turnId;
        const command = parseMemoryCommand(next.value);
        const capability = Object.freeze(Object.create(null));
        turns.set(capability, { recipient, command: structuredClone(command), used: false });
        current = capability;
        const runtimeContextCapability = Object.freeze(Object.create(null));
        contextCapabilities.set(runtimeContextCapability, {
            recipient, session, turnId, sourceTextSha256, origin: 'local_cli',
            purpose: 'automatic_memory_assessment', consumed: false,
        });
        turns.get(capability).runtimeContextCapability = runtimeContextCapability;
        session.capabilities.add(runtimeContextCapability);
        currentContext = runtimeContextCapability;
        return Object.freeze({ message: next.value, command, capability, runtimeContextCapability });
    } finally { reading = false; }
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
    const turn = turns.get(capability);
    turns.delete(capability);
    if (turn?.runtimeContextCapability) expireContext(turn.runtimeContextCapability);
}

/** Consumes a one-use, purpose-bound proof issued only while reading real stdin.
 * The first verification attempt consumes it, including recipient/text failures.
 */
export function consumeTrustedLocalTurnContext(capability, recipient, originalText) {
    const state = capability && typeof capability === 'object' ? contextCapabilities.get(capability) : null;
    if (!state || state.consumed) throw denied();
    state.consumed = true;
    state.session.capabilities.delete(capability);
    contextCapabilities.delete(capability);
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
