import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { parseMemoryCommand } from '../memory/commands.js';

const turns = new WeakMap();
let reader, lines, current, reading = false;

function denied() {
    const error = new Error('A current terminal user turn is required.');
    error.code = 'memory_write_not_authorized';
    return error;
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
    try {
        if (!reader) {
            reader = createInterface({ input: stdin, output: stdout, crlfDelay: Infinity,
                terminal: Boolean(stdin.isTTY && stdout.isTTY) });
            lines = reader[Symbol.asyncIterator]();
        }
        if (stdin.isTTY) stdout.write('Vos > ');
        const next = await lines.next();
        if (next.done) return null;
        const command = parseMemoryCommand(next.value);
        const capability = Object.freeze(Object.create(null));
        turns.set(capability, { recipient, command: structuredClone(command), used: false });
        current = capability;
        return Object.freeze({ message: next.value, command, capability });
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

export function releaseDirectUserTurn(capability) { turns.delete(capability); }

export function closeDirectUserInput() {
    if (current) turns.delete(current);
    reader?.close();
    stdin.pause();
    reader = undefined; lines = undefined; current = undefined;
}
