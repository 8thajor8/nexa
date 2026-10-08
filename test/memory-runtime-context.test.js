import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { terminalTests, terminalTurn } from '../test-support/memory-terminal.js';
import { consumeTrustedLocalTurnContext, closeDirectUserSession } from '../src/core/direct-user-input.js';
import { assessAutomaticMemoryWithTrustedLocalContext } from '../src/memory/automatic/runtime-context-adapter.js';

const runTerminalTest = terminalTests(import.meta.url);

runTerminalTest('trusted local context is issued only for exact stdin text', async () => {
    const recipient = {};
    const text = 'Synthetic first-party input.';
    const turn = await terminalTurn(recipient, text);
    const context = consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, text);
    assert.match(context.sessionId, /^[0-9a-f-]{36}$/u);
    assert.match(context.turnId, /^[0-9a-f-]{36}$/u);
    assert.equal(context.origin, 'local_cli');
    assert.equal(context.principalKind, 'local_runtime_session');
    assert.deepEqual(context.permissionScopes, []);
    assert.equal(context.sourceTextSha256, createHash('sha256').update(text, 'utf8').digest('hex'));
    assert.equal(Object.hasOwn(turn, 'message'), true);
    assert.deepEqual(Reflect.ownKeys(turn.runtimeContextCapability), []);
    assert.equal(Object.hasOwn(context, 'text'), false);
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, text),
        { code: 'memory_write_not_authorized' }, 'successful verification is also one-use');
});

runTerminalTest('each stdin turn has a fresh turn id in the same local session', async () => {
    const recipient = {};
    const first = await terminalTurn(recipient, 'First synthetic turn.');
    const a = consumeTrustedLocalTurnContext(first.runtimeContextCapability, recipient, first.message);
    const second = await terminalTurn(recipient, 'Second synthetic turn.');
    const b = consumeTrustedLocalTurnContext(second.runtimeContextCapability, recipient, second.message);
    assert.equal(a.sessionId, b.sessionId);
    assert.notEqual(a.turnId, b.turnId);
});

runTerminalTest('falsified structured capabilities and model or remote claims are rejected', async () => {
    const recipient = {};
    const turn = await terminalTurn(recipient, 'Synthetic input.');
    const fake = Object.freeze(Object.create(null));
    assert.throws(() => consumeTrustedLocalTurnContext(fake, recipient, turn.message), { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnContext({ origin: 'local_cli', sessionId: 'fake', turnId: 'fake',
        sourceTextSha256: '0'.repeat(64), principalId: 'model', permissionScopes: ['memory.automatic.add'] }, recipient, turn.message),
    { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnContext({ origin: 'remote', sessionId: 'remote-session', turnId: 'remote-turn',
        principalId: 'unverified-remote', permissionScopes: [] }, recipient, turn.message),
    { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, {}, turn.message),
        { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' }, 'failed recipient attempt consumes capability');
});

runTerminalTest('altered text consumes and invalidates trusted evidence', async () => {
    const recipient = {};
    const turn = await terminalTurn(recipient, 'Original synthetic text.');
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, 'Altered text.'),
        { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' });
});

runTerminalTest('next turn invalidates unconsumed previous capability', async () => {
    const recipient = {};
    const first = await terminalTurn(recipient, 'Turn one.');
    const second = await terminalTurn(recipient, 'Turn two.');
    assert.throws(() => consumeTrustedLocalTurnContext(first.runtimeContextCapability, recipient, first.message),
        { code: 'memory_write_not_authorized' });
    assert.equal(consumeTrustedLocalTurnContext(second.runtimeContextCapability, recipient, second.message).origin, 'local_cli');
});

runTerminalTest('closing a local runtime session invalidates its outstanding capability', async () => {
    const recipient = {};
    const turn = await terminalTurn(recipient, 'Synthetic input.');
    closeDirectUserSession(recipient);
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' });
});

runTerminalTest('closing the stdin boundary invalidates outstanding capabilities', async () => {
    const recipient = {};
    const turn = await terminalTurn(recipient, 'Synthetic input.');
    const { closeDirectUserInput } = await import('../src/core/direct-user-input.js');
    closeDirectUserInput();
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' });
});

runTerminalTest('runtime adapter consumes context but grants no authorization or write readiness', async () => {
    const recipient = {};
    const text = 'También tengo una Fender.';
    const turn = await terminalTurn(recipient, text);
    const proposal = { candidates: [{ candidate_type: 'purchase', subject_text: 'user', predicate: 'user.owns_item',
        value_text: 'Fender', mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.94,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'addition',
        sensitivity: 'none', suggested_disposition: 'auto_save', evidence_quote: text }] };
    const result = assessAutomaticMemoryWithTrustedLocalContext({ text, proposal, snapshot: null,
        operationIndex: 0, recipient, runtimeContextCapability: turn.runtimeContextCapability });
    assert.equal(result.success, true);
    assert.equal(result.runtimeContextVerified, true);
    assert.equal(result.runtimeContext.origin, 'local_cli');
    assert.deepEqual(result.runtimeContext.permissionScopes, []);
    assert.equal(result.assessment.policyEligibility, 'denied');
    assert.equal(result.assessment.authorization.granted, false);
    assert.equal(result.assessment.authorizationRequestEligible, false);
    assert.equal(result.assessment.executable, false);
    assert.equal(result.assessment.writeReady, false);
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, text),
        { code: 'memory_write_not_authorized' });
});

if (!process.env.NEXA_TERMINAL_CASE) test('EOF invalidates the active capability', () => {
    const script = `import { readDirectUserTurn, consumeTrustedLocalTurnContext } from './src/core/direct-user-input.js';\n`+
        `const recipient = {}; const turn = await readDirectUserTurn(recipient);\n`
        + `const ended = await readDirectUserTurn(recipient); if (ended !== null) process.exit(2);\n`
        + `try { consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message); process.exit(3); }\n`
        + `catch (error) { if (error.code !== 'memory_write_not_authorized') process.exit(4); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(), input: 'EOF test synthetic line\n', encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
});

if (!process.env.NEXA_TERMINAL_CASE) test('process restart creates independent session and turn identifiers', () => {
    const script = `import { readDirectUserTurn, consumeTrustedLocalTurnContext, closeDirectUserInput } from './src/core/direct-user-input.js';\n`
        + `const r = {}; const t = await readDirectUserTurn(r); const c = consumeTrustedLocalTurnContext(t.runtimeContextCapability,r,t.message); console.log(JSON.stringify([c.sessionId,c.turnId])); closeDirectUserInput();`;
    const run = () => {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(), input: 'restart test synthetic\n', encoding: 'utf8', windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.trim());
    };
    const first = run(), second = run();
    assert.notEqual(first[0], second[0]);
    assert.notEqual(first[1], second[1]);
});
