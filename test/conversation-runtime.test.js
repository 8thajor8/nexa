import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';

function final(text) {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

function toolCall(name, args, callId = name) {
    return { status: 'completed', output: [{ type: 'function_call', name,
        arguments: JSON.stringify(args), call_id: callId }] };
}

function agentOptions(overrides = {}) {
    return {
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        getTools: () => [],
        logger: () => {},
        ...overrides,
    };
}

test('creates UUID conversations and returns correlated typed completion events', async () => {
    const seen = [];
    const runtime = createConversationRuntime({ agentOptions: agentOptions({
        ask: async request => { seen.push(request); return final('Hola.'); },
    }) });
    const events = [];
    const unsubscribe = runtime.onEvent(event => events.push(event));
    const conversationId = runtime.createConversation();
    const result = await runtime.sendMessage({ conversationId, requestId: 'typed-1', text: 'Hola', source: 'typed' });

    assert.match(conversationId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(result, { conversationId, requestId: 'typed-1', status: 'completed', text: 'Hola.' });
    assert.deepEqual(events.map(event => [event.conversationId, event.requestId, event.status]), [
        [conversationId, 'typed-1', 'processing'], [conversationId, 'typed-1', 'completed'],
    ]);
    assert.equal(seen[0].input[0].content, 'Hola');
    unsubscribe();
    await runtime.close();
});

test('restores only bounded visible conversation messages into the agent context', async () => {
    const inputs = [];
    const runtime = createConversationRuntime({ memoryMode: 'memory1', agentOptions: agentOptions({
        ask: async request => { inputs.push(request.input); return final('Respuesta nueva.'); },
    }) });
    const conversationId = '00000000-0000-4000-8000-000000000099';
    try {
        assert.equal(runtime.restoreConversation(conversationId, [
            { role: 'user', content: 'Estoy pensando en borrar mis copias.' },
            { role: 'assistant', content: 'Te recomiendo conservar una copia independiente.' },
        ]), true);
        const result = await runtime.sendMessage({ conversationId, requestId: 'restore-context-1',
            text: '¿Y por qué?', source: 'typed' });
        assert.equal(result.status, 'completed');
        assert.deepEqual(inputs[0].filter(item => item.role === 'user' || item.role === 'assistant')
            .map(item => [item.role, item.content]), [
            ['user', 'Estoy pensando en borrar mis copias.'],
            ['assistant', 'Te recomiendo conservar una copia independiente.'],
            ['user', '¿Y por qué?'],
        ]);
        assert.equal(runtime.restoreConversation(conversationId, []), false);
        assert.throws(() => runtime.restoreConversation('../../invalid', []), /conversation_id_invalid/u);
        assert.throws(() => runtime.restoreConversation('00000000-0000-4000-8000-000000000098', [
            { type: 'function_call', name: 'tool', arguments: '{}' },
        ]), /conversation_history_invalid/u);
    } finally { await runtime.close(); }
});

test('preserves conversation context and isolates histories between conversation IDs', async () => {
    const requests = [];
    let answer = 0;
    const runtime = createConversationRuntime({ agentOptions: agentOptions({
        ask: async request => { requests.push(structuredClone(request)); return final(`respuesta-${++answer}`); },
    }) });
    const first = runtime.createConversation();
    const second = runtime.createConversation();
    await runtime.sendMessage({ conversationId: first, requestId: 'ctx-1', text: 'primero', source: 'typed' });
    await runtime.sendMessage({ conversationId: first, requestId: 'ctx-2', text: 'seguí', source: 'typed' });
    await runtime.sendMessage({ conversationId: second, requestId: 'ctx-3', text: 'aislado', source: 'typed' });

    assert.ok(requests[1].input.some(item => item?.role === 'user' && item.content === 'primero'));
    assert.ok(requests[1].input.some(item => item?.role === 'user' && item.content === 'seguí'));
    assert.equal(requests[2].input.some(item => item?.role === 'user' && item.content === 'primero'), false);
    assert.equal(requests[2].input.filter(item => item?.role === 'user').map(item => item.content).join('|'), 'aislado');
    await runtime.close();
});

test('preserves voice modality and marks Desktop turns as direct user input for action authorization', async () => {
    const sources = [];
    let count = 0;
    const runtime = createConversationRuntime({ agentOptions: agentOptions({
        getTools: () => [{ type: 'function', name: 'test_action' }],
        execute: async (_name, _args, context) => { sources.push([context.userMessageSource, context.inputSource]); return { success: true }; },
        ask: async () => ++count === 1 ? toolCall('test_action', {}, 'voice-action') : final('Entendido.'),
    }) });
    const conversationId = runtime.createConversation();
    const result = await runtime.sendMessage({ conversationId, requestId: 'voice-1', text: 'abre la ventana', source: 'voice' });
    assert.equal(result.status, 'completed');
    assert.deepEqual(sources, [['direct_user', 'voice']]);
    await runtime.close();
});

test('rejects unknown conversations and malformed inputs with correlated errors', async () => {
    const runtime = createConversationRuntime();
    const unknown = await runtime.sendMessage({ conversationId: 'missing', requestId: 'unknown-1', text: 'hola', source: 'typed' });
    assert.equal(unknown.error.code, 'conversation_not_found');
    const conversationId = runtime.createConversation();
    assert.equal((await runtime.sendMessage({ conversationId, requestId: 'blank-1', text: '  ', source: 'typed' })).error.code, 'text_invalid');
    assert.equal((await runtime.sendMessage({ conversationId, requestId: 'source-1', text: 'hola', source: 'ptt' })).error.code, 'source_invalid');
    assert.equal((await runtime.sendMessage({ conversationId, requestId: 'missing-source', text: 'hola' })).error.code, 'source_invalid');
    assert.equal((await runtime.sendMessage({ conversationId, requestId: '  ', text: 'hola', source: 'typed' })).error.code, 'request_id_invalid');
    assert.equal(unknown.conversationId, 'missing');
    assert.equal(unknown.requestId, 'unknown-1');
    await runtime.close();
});

test('rejects a duplicate request ID deterministically without a second terminal event', async () => {
    const events = [];
    const runtime = createConversationRuntime({ agentOptions: agentOptions({ ask: async () => final('ok') }) });
    runtime.onEvent(event => events.push(event));
    const conversationId = runtime.createConversation();
    const first = await runtime.sendMessage({ conversationId, requestId: 'repeat-1', text: 'hola', source: 'typed' });
    const duplicate = await runtime.sendMessage({ conversationId, requestId: 'repeat-1', text: 'otra vez', source: 'typed' });
    assert.equal(first.status, 'completed');
    assert.equal(duplicate.error.code, 'request_id_duplicate');
    assert.equal(events.filter(event => event.requestId === 'repeat-1'
        && ['completed', 'cancelled', 'error'].includes(event.status)).length, 1);
    await runtime.close();
});

test('returns busy without queuing concurrent requests and protects shared tool state across conversations', async () => {
    let resolveAsk;
    const runtime = createConversationRuntime({ agentOptions: agentOptions({
        ask: () => new Promise(resolve => { resolveAsk = resolve; }),
    }) });
    const first = runtime.createConversation();
    const second = runtime.createConversation();
    const pending = runtime.sendMessage({ conversationId: first, requestId: 'busy-1', text: 'uno', source: 'typed' });
    for (let attempt = 0; !resolveAsk && attempt < 20; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(typeof resolveAsk, 'function');
    const same = await runtime.sendMessage({ conversationId: first, requestId: 'busy-2', text: 'dos', source: 'typed' });
    const cross = await runtime.sendMessage({ conversationId: second, requestId: 'busy-3', text: 'tres', source: 'typed' });
    assert.equal(same.error.code, 'busy');
    assert.equal(cross.error.code, 'busy');
    assert.match(cross.error.message, /another conversation/u);
    resolveAsk(final('terminado'));
    assert.equal((await pending).status, 'completed');
    await runtime.close();
});

test('sanitizes agent failures and releases the conversation for a later request', async () => {
    let fail = true;
    const runtime = createConversationRuntime({ agentFactory: async () => ({
        async run() { if (fail) { fail = false; throw new Error('secret API key should not leak'); } return 'ok'; },
        async close() {},
    }) });
    const conversationId = runtime.createConversation();
    const failed = await runtime.sendMessage({ conversationId, requestId: 'error-1', text: 'uno', source: 'typed' });
    const succeeded = await runtime.sendMessage({ conversationId, requestId: 'error-2', text: 'dos', source: 'typed' });
    assert.deepEqual(failed.error, { code: 'agent_error', message: 'The conversation request failed.' });
    assert.equal(JSON.stringify(failed).includes('secret API key'), false);
    assert.equal(succeeded.status, 'completed');
    await runtime.close();
});

test('cancellation aborts Responses API work, ignores a late result, and emits exactly one terminal state', async () => {
    let resolveFirst;
    let calls = 0;
    const events = [];
    const traces = [];
    const runtime = createConversationRuntime({ agentOptions: agentOptions({
        ask: request => {
            calls++;
            if (calls === 1) return new Promise(resolve => { resolveFirst = resolve; });
            assert.equal(request.signal.aborted, false);
            return final('nuevo intento');
        },
    }), diagnostic: event => traces.push(event) });
    runtime.onEvent(event => events.push(event));
    const conversationId = runtime.createConversation();
    const pending = runtime.sendMessage({ conversationId, requestId: 'cancel-1', text: 'tardía', source: 'typed' });
    while (!resolveFirst) await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.cancelRequest('cancel-1', 'user'), true);
    assert.equal(events.filter(event => event.requestId === 'cancel-1').at(-1).status, 'processing');
    resolveFirst(final('respuesta tardía que no debe aparecer'));
    const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(JSON.stringify(events).includes('respuesta tardía'), false);
    assert.equal(events.filter(event => event.requestId === 'cancel-1'
        && ['completed', 'cancelled', 'error'].includes(event.status)).length, 1);
    assert.deepEqual(traces.filter(event => event.event === 'cancel_requested')
        .map(event => event.origin), ['user']);
    assert.deepEqual(traces.filter(event => event.event === 'request_cancelled')
        .map(event => event.origin), ['user']);

    const retried = await runtime.sendMessage({ conversationId, requestId: 'cancel-2', text: 'nuevo', source: 'typed' });
    assert.equal(retried.status, 'completed');
    await runtime.close();
});

test('cancellation during an external tool waits for it and does not claim its effect was reverted', async () => {
    let resolveTool;
    let toolEffects = 0;
    let askCount = 0;
    const events = [];
    const runtime = createConversationRuntime({ agentOptions: agentOptions({
        getTools: () => [{ type: 'function', name: 'external_action' }],
        ask: async () => ++askCount === 1 ? toolCall('external_action', {}, 'external-1') : final('late'),
        execute: () => new Promise(resolve => { resolveTool = () => { toolEffects++; resolve({ success: true }); }; }),
    }) });
    runtime.onEvent(event => events.push(event));
    const conversationId = runtime.createConversation();
    const pending = runtime.sendMessage({ conversationId, requestId: 'cancel-tool-1', text: 'hazlo', source: 'typed' });
    while (!resolveTool) await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.cancelRequest('cancel-tool-1'), true);
    resolveTool();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(toolEffects, 1);
    assert.equal(events.filter(event => event.requestId === 'cancel-tool-1'
        && ['completed', 'cancelled', 'error'].includes(event.status)).length, 1);
    await runtime.close();
});

test('close aborts active work and closes all conversation agents once', async () => {
    let resolveAsk;
    let closes = 0;
    const traces = [];
    const runtime = createConversationRuntime({ diagnostic: event => traces.push(event), agentFactory: async () => ({
        run: (_text, _source, { signal }) => new Promise(resolve => {
            resolveAsk = () => resolve('late');
            signal.addEventListener('abort', () => resolveAsk(), { once: true });
        }),
        async close() { closes++; },
    }) });
    const conversationId = runtime.createConversation();
    const pending = runtime.sendMessage({ conversationId, requestId: 'close-1', text: 'work', source: 'typed' });
    await new Promise(resolve => setImmediate(resolve));
    await runtime.close();
    assert.equal((await pending).status, 'cancelled');
    assert.equal(closes, 1);
    assert.deepEqual(traces.filter(event => event.event === 'cancel_requested')
        .map(event => event.origin), ['runtime_close']);
    await runtime.close();
    assert.throws(() => runtime.createConversation(), /conversation_runtime_closed/u);
});

test('runtime close preserves an earlier lifecycle cancellation origin', async () => {
    const traces = [];
    const runtime = createConversationRuntime({ diagnostic: event => traces.push(event), agentFactory: async () => ({
        run: (_text, _source, { signal }) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve('late'), { once: true });
        }),
        async close() {},
    }) });
    const conversationId = runtime.createConversation();
    const pending = runtime.sendMessage({ conversationId, requestId: 'origin-1', text: 'work', source: 'typed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.cancelRequest('origin-1', 'navigation'), true);
    await runtime.close();
    assert.equal((await pending).status, 'cancelled');
    assert.deepEqual(traces.filter(event => event.event === 'cancel_requested')
        .map(event => event.origin), ['navigation']);
    assert.deepEqual(traces.filter(event => event.event === 'request_cancelled')
        .map(event => event.origin), ['navigation']);
});

test('importing the conversation API does not launch the interactive CLI', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import './src/core/conversation-runtime.js'; console.log('conversation-api-imported');"], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /conversation-api-imported/u);
});

test('runtime uses the shared read-only Memory2 composition and does not mutate a synthetic store', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-conversation-memory2-'));
    const storePath = path.join(directory, 'store-v5.json');
    const t = '2026-10-10T12:00:00.000Z';
    const p = 'person_00000000-0000-4000-8000-000000000001';
    const a = 'mem_00000000-0000-4000-8000-000000000001';
    const s = 'src_00000000-0000-4000-8000-000000000001';
    const e = 'ev_00000000-0000-4000-8000-000000000001';
    const fixture = {
        schema_version: 5, store_id: 'store_00000000-0000-4000-8000-000000000001', self_person_id: p,
        revision: 1, created_at: t, updated_at: t,
        entities: [{ id: p, type: 'person', created_at: t }],
        assertions: [{ id: a, kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note',
            object: { type: 'text', value: 'Conversation synthetic only.' }, status: 'active', valid_from: null,
            valid_to: null, recorded_at: t, supersedes: [], compatibility: { category: 'user', key: 'runtime-api' } }],
        sources: [{ id: s, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: t }],
        evidence: [{ id: e, assertion_id: a, source_id: s, derivation: 'explicit', extraction_confidence: 1,
            learned_at: t, last_confirmed_at: null, legacy_ref: null }],
        migrations: [], automatic_operations: [],
    };
    const original = Buffer.from(JSON.stringify(fixture, null, 2) + '\n');
    await writeFile(storePath, original);
    const requests = [];
    const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', storePath,
        agentOptions: agentOptions({ ask: async request => { requests.push(structuredClone(request)); return final('Contexto leído.'); } }) });
    try {
        const conversationId = runtime.createConversation();
        assert.equal((await runtime.sendMessage({ conversationId, requestId: 'm2-read-1', text: '¿Qué sabés de mí?', source: 'typed' })).status, 'completed');
        assert.ok(requests[0].input.some(item => item.type === 'function_call_output'
            && item.output.includes('Conversation synthetic only.')));
        assert.deepEqual(await readFile(storePath), original);
        assert.deepEqual(await readdir(directory), ['store-v5.json']);
    } finally {
        await runtime.close();
        assert.deepEqual(await readFile(storePath), original);
        await rm(directory, { recursive: true, force: true });
    }
});

test('memory diagnostics retain a sanitized initialization failure without retrying agent creation', async () => {
    let attempts = 0;
    const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', agentFactory: async () => {
        attempts++;
        const error = new Error('C:\\private\\store.json contains protected content');
        error.code = 'memory_store_invalid';
        throw error;
    } });
    try {
        const conversationId = runtime.createConversation();
        const failed = await runtime.sendMessage({ conversationId, requestId: 'diag-init-fail-1',
            text: 'Hola Nexa', source: 'typed' });
        assert.equal(failed.status, 'error');
        const diagnosis = await runtime.sendMessage({ conversationId, requestId: 'diag-init-fail-2',
            text: 'Nexa, diagnosticá tu memoria', source: 'typed' });
        assert.equal(diagnosis.status, 'completed');
        assert.match(diagnosis.text, /memory_store_invalid/u);
        assert.match(diagnosis.text, /No intenté leer recuerdos/u);
        assert.doesNotMatch(diagnosis.text, /C:\\private|protected content/u);
        assert.equal(attempts, 1);
    } finally { await runtime.close(); }
});

test('system status and tool catalog carry per-response technical metadata without calling the agent', async () => {
    const runtime = createConversationRuntime({
        agentFactory: () => { throw new Error('agent must not start'); },
        memoryMode: 'memory2-readonly',
        agentOptions: { getTools: () => [{ name: 'spotify_play' }, { name: 'open_app' }] },
    });
    const conversationId = runtime.createConversation();
    const memory = await runtime.sendMessage({ conversationId, requestId: 'format-memory-1',
        text: '¿Qué sistema de memoria estás usando?', source: 'typed' });
    assert.equal(memory.status, 'completed');
    assert.match(memory.text, /Diagnóstico de Nexa/u);
    assert.doesNotMatch(memory.text, /spotify_play|open_app/u);
    assert.equal(memory.presentation.kind, 'diagnostic');
    assert.match(memory.presentation.technicalDetail, /memory2-readonly/u);

    const tools = await runtime.sendMessage({ conversationId, requestId: 'format-tools-1',
        text: '¿Qué herramientas tenés disponibles?', source: 'typed' });
    assert.equal(tools.status, 'completed');
    assert.match(tools.text, /Música y Spotify/u);
    assert.doesNotMatch(tools.text, /spotify_play|open_app/u);
    assert.equal(tools.presentation.kind, 'tool_catalog');
    assert.match(tools.presentation.technicalDetail, /spotify_play/u);
    const spotify = await runtime.sendMessage({ conversationId, requestId: 'format-spotify-1',
        text: '¿Qué podés hacer con Spotify?', source: 'typed' });
    assert.equal(spotify.status, 'completed');
    assert.match(spotify.text, /Herramientas de Spotify/u);
    assert.doesNotMatch(spotify.text, /Computadora y aplicaciones|open_app/u);
    assert.match(spotify.text, /No comprobé el estado de conexión/u);
    await runtime.close();
});

test('explicit Nexa diagnostics bypass the agent and voice diagnostics keep a speakable summary with technical detail attached', async () => {
    let agentCalls = 0;
    const runtime = createConversationRuntime({
        agentFactory: () => { agentCalls++; throw new Error('agent must not start for a direct diagnostic'); },
        memoryMode: 'memory2-readonly',
    });
    const conversationId = runtime.createConversation();
    try {
        for (const [requestId, text] of [['nexa-status-1', 'Nexa, dame tu diagnóstico'],
            ['nexa-status-2', '¿Cómo están tus sistemas?']]) {
            const result = await runtime.sendMessage({ conversationId, requestId, text, source: 'typed' });
            assert.equal(result.status, 'completed');
            assert.match(result.text, /Diagnóstico de Nexa/u);
            assert.equal(result.presentation.kind, 'diagnostic');
        }
        const voice = await runtime.sendMessage({ conversationId, requestId: 'nexa-voice-diagnostic-1',
            text: 'Diagnóstico de voz', source: 'voice' });
        assert.equal(voice.status, 'completed');
        assert.match(voice.text, /Diagnóstico de Voice/u);
        assert.doesNotMatch(voice.text, /Memory2|Spotify|Windows|Herramientas registradas/u);
        assert.doesNotMatch(voice.text, /Herramientas registradas \(|runtime-[0-9a-f-]{36}/iu);
        assert.equal(voice.presentation.kind, 'diagnostic');
        assert.match(voice.presentation.technicalDetail, /"schema"/u);
        const technicalVoice = await runtime.sendMessage({ conversationId, requestId: 'nexa-voice-diagnostic-2',
            text: 'Dame el diagnóstico técnico de Voice', source: 'typed' });
        assert.match(technicalVoice.text, /Diagnóstico de Voice/u);
        assert.doesNotMatch(technicalVoice.text, /Memory2|Spotify|Windows|Herramientas registradas/u);
        assert.match(technicalVoice.presentation.technicalDetail, /"component":\s*"voice"/u);
        assert.equal(agentCalls, 0);
    } finally { await runtime.close(); }
});
