import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDirectUserTurn, closeDirectUserInput } from '../src/core/direct-user-input.js';
import { authorizeMemoryRemember, authorizeMemoryForget, validateRememberProposal } from '../src/memory/authorization.js';

// Test driver writes synthetic input to a child process's actual OS stdin.
// Production has no injectable input stream, synthetic issuer, or test flag.
export function terminalTests(url) {
    return (name, body) => {
        if (process.env.NEXA_TERMINAL_CASE) {
            if (process.env.NEXA_TERMINAL_CASE !== name) return;
            test(name, async t => {
                t.after(() => { closeDirectUserInput(); process.disconnect?.(); });
                await body(t);
            });
            return;
        }
        test(name, { timeout: 20000 }, async t => {
            const childEnv = { ...process.env, NEXA_TERMINAL_CASE: name };
            delete childEnv.NODE_TEST_CONTEXT;
            const child = spawn(process.execPath, [fileURLToPath(url)], {
                env: childEnv, windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            });
            t.after(() => { if (child.exitCode === null) child.kill(); });
            let output = '';
            child.stdout.on('data', data => { output += data; });
            child.stderr.on('data', data => { output += data; });
            child.on('message', message => {
                if (message.type === 'terminal-line') child.stdin.write(message.line + '\n');
            });
            const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
            assert.equal(code, 0, output);
        });
    };
}
export function sendTerminalLine(line) {
    assert.equal(typeof process.send, 'function', 'requires isolated terminal test child');
    process.send({ type: 'terminal-line', line });
}
export async function terminalTurn(recipient, line) {
    sendTerminalLine(line);
    return readDirectUserTurn(recipient);
}
export async function grantFor(service, proposal) {
    validateRememberProposal(proposal);
    const turn = await terminalTurn(service, '/remember ' + JSON.stringify(proposal));
    return authorizeMemoryRemember({ capability: turn.capability, recipient: service, proposal });
}
export async function forgetGrant(service, target) {
    const line = target.type === 'assertion' ? '/forget assertion ' + target.id
        : '/forget slot ' + target.compatibility.category + ':' + target.compatibility.key;
    const turn = await terminalTurn(service, line);
    return authorizeMemoryForget({ capability: turn.capability, recipient: service, target });
}
