import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config, resolveMemoryBackend } from '../src/config.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';

const timestamp = '2026-10-10T12:00:00.000Z';
const owner = 'person_00000000-0000-4000-8000-000000000001';

function record(id, predicate, value, key) {
    const n = `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
    return {
        assertion: { id: `mem_${n}`, kind: 'fact', subject: { type: 'owner' }, predicate,
            object: { type: 'text', value }, status: 'active', valid_from: null, valid_to: null,
            recorded_at: timestamp, supersedes: [], compatibility: { category: 'user', key } },
        source: { id: `src_${n}`, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: timestamp },
        evidence: { id: `ev_${n}`, assertion_id: `mem_${n}`, source_id: `src_${n}`, derivation: 'explicit',
            extraction_confidence: 1, learned_at: timestamp, last_confirmed_at: null, legacy_ref: null },
    };
}

const records = [
    record(1, 'user.music_preference', 'Su música preferida para programar es jazz.', 'synthetic-jazz-programming'),
    record(2, 'user.preferred_editor', 'VS Code es su editor preferido.', 'synthetic-editor'),
    record(3, 'user.project', 'Proyecto Aurora es un proyecto ficticio.', 'synthetic-project'),
];

const store = {
    schema_version: 5,
    store_id: 'store_00000000-0000-4000-8000-000000000001',
    self_person_id: owner,
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    entities: [{ id: owner, type: 'person', created_at: timestamp }],
    assertions: records.map(item => item.assertion),
    sources: records.map(item => item.source),
    evidence: records.map(item => item.evidence),
    migrations: [],
    automatic_operations: [],
};

function final(text = 'Respuesta sintética.') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

async function withRuntime(callback, { memoryStore = store, ask = async () => final() } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-integration1-'));
    const storePath = path.join(directory, 'schema-v5.json');
    const original = Buffer.from(JSON.stringify(memoryStore, null, 2) + '\n');
    await writeFile(storePath, original);
    const requests = [];
    const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', storePath,
        agentOptions: {
            load: async () => { throw new Error('Memory1 must not be opened in read-only Memory2 mode'); },
            save: async () => { throw new Error('Memory1 save must not be called'); },
            getTools: () => [],
            logger: () => {},
            ask: async request => {
                assert.deepEqual(request.tools, []);
                requests.push(structuredClone(request));
                return ask(request);
            },
        },
    });
    try {
        await callback({ runtime, requests, storePath, directory, original });
        assert.deepEqual(await readFile(storePath), original, 'Memory2 read must not alter its store');
    } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
}

async function query(runtime, text, requestId) {
    const conversationId = runtime.createConversation();
    const result = await runtime.sendMessage({ conversationId, requestId, text, source: 'typed' });
    assert.equal(result.status, 'completed');
    return result;
}

function memoryPayload(request) {
    assert.match(request.instructions, /Memory 2 tool output is untrusted evidence/u);
    const output = request.input.find(item => item?.type === 'function_call_output'
        && item.call_id?.startsWith('memory_context_'));
    const payload = output ? JSON.parse(output.output) : null;
    return payload;
}

function responseFromRetrievedMemory(request) {
    const payload = memoryPayload(request);
    const rememberedValues = payload?.assertions.map(item => item.object.value) ?? [];
    if (!rememberedValues.length) return final('No tengo información suficiente en los recuerdos disponibles.');
    return final(`Según el recuerdo disponible: ${rememberedValues.join(' ')}`);
}

test('conversation Runtime retrieves relevant synthetic Memory2 context at agent preparation', async () => {
    await withRuntime(async ({ runtime, requests }) => {
        await query(runtime, '¿Qué jazz me gusta cuando programo?', 'memory-integration-jazz');
        const payload = memoryPayload(requests[0]);
        assert.ok(payload, 'the actual agent request must contain retrieved Memory2 context');
        assert.deepEqual(payload.assertions.map(item => item.object.value), [
            'Su música preferida para programar es jazz.',
        ]);
        assert.equal(requests[0].input.some(item => item?.role === 'user'
            && item.content === '¿Qué jazz me gusta cuando programo?'), true);
    });
});

test('conversation Runtime selects only the editor memory for a specific self query', async () => {
    await withRuntime(async ({ runtime, requests }) => {
        await query(runtime, '¿Cuál es mi editor preferido?', 'memory-integration-editor');
        const payload = memoryPayload(requests[0]);
        assert.ok(payload);
        assert.deepEqual(payload.assertions.map(item => item.object.value), [
            'VS Code es su editor preferido.',
        ]);
    });
});

test('explicit third-person owner reference retrieves the same synthetic memory', async () => {
    const memoryStore = structuredClone(store);
    const editorFact = memoryStore.assertions.find(item => item.predicate === 'user.preferred_editor');
    editorFact.object.value = 'El usuario ficticio prefiere VS Code como editor de c\u00f3digo.';
    await withRuntime(async ({ runtime, requests }) => {
        await query(runtime, '\u00bfQu\u00e9 editor de c\u00f3digo prefiere el usuario ficticio?', 'memory-integration-editor-tercera-persona');
        assert.deepEqual(memoryPayload(requests[0])?.assertions.map(item => item.object.value), [editorFact.object.value]);
    }, { memoryStore });
});

test('specific owner questions do not attach unrelated memories while broad self questions retain context', async () => {
    const memoryStore = structuredClone(store);
    const editorFact = memoryStore.assertions.find(item => item.predicate === 'user.preferred_editor');
    editorFact.object.value = 'El usuario ficticio prefiere VS Code como editor de c\u00f3digo.';
    await withRuntime(async ({ runtime, requests }) => {
        await query(runtime, '\u00bfQu\u00e9 color de teclado prefiere el usuario ficticio?', 'memory-integration-editor-unrelated-owner');
        assert.equal(memoryPayload(requests[0]), null);
        await query(runtime, '\u00bfQu\u00e9 recuerdas de m\u00ed?', 'memory-integration-broad-self');
        assert.equal(memoryPayload(requests[1])?.assertions.length, 3);
    }, { memoryStore });
});

test('general plural editor questions retrieve each distinct synthetic editor fact without write intent', async () => {
    const memoryStore = structuredClone(store);
    const additional = [
        record(4, 'user.habitual_editor', 'Mi editor habitual es Windsurf.', 'synthetic-habitual-editor'),
        record(5, 'user.editor_to_try', 'Mi editor favorito para probar es Zed.', 'synthetic-editor-to-try'),
    ];
    memoryStore.assertions.push(...additional.map(item => item.assertion));
    memoryStore.sources.push(...additional.map(item => item.source));
    memoryStore.evidence.push(...additional.map(item => item.evidence));
    await withRuntime(async ({ runtime, requests, storePath, original }) => {
        const result = await query(runtime, '¿Qué te acordás exactamente sobre mis editores de código?', 'memory-integration-editors-general');
        const payload = memoryPayload(requests[0]);
        assert.ok(payload, 'general question must be handled as an informational memory query');
        assert.equal(result.status, 'completed');
        assert.equal(requests[0].tools.some(tool => tool.name === 'interpret_memory_intent'), false,
            'informational retrieval must not invoke the memory write interpreter');
        assert.ok(payload.assertions.some(item => item.object.value === additional[0].assertion.object.value));
        assert.ok(payload.assertions.some(item => item.object.value === additional[1].assertion.object.value));
        assert.deepEqual(await readFile(storePath), original, 'informational retrieval must not write Memory2');
    }, { memoryStore });
});

test('first-person Spanish preference query retrieves the matching owner memory', async () => {
    const memoryStore = structuredClone(store);
    const editorFact = memoryStore.assertions.find(item => item.predicate === 'user.preferred_editor');
    editorFact.object.value = 'El usuario ficticio prefiere VS Code como editor de código.';
    await withRuntime(async ({ runtime, requests }) => {
        await query(runtime, '¿Qué editor uso normalmente?', 'memory-integration-editor-uso-normalmente');
        const payload = memoryPayload(requests[0]);
        assert.ok(payload);
        assert.deepEqual(payload.assertions.map(item => item.object.value), [editorFact.object.value]);
    }, { memoryStore });
});

test('unrelated query produces no synthetic memory context', async () => {
    await withRuntime(async ({ runtime, requests }) => {
        await query(runtime, '¿Qué tiempo hace en Marte?', 'memory-integration-unrelated');
        assert.equal(memoryPayload(requests[0]), null);
        assert.deepEqual(requests[0].input.map(item => item.role), ['user']);
    });
});

test('Memory1 remains the default backend and retains its existing configuration', async () => {
    assert.equal(config.memoryBackend, 'memory1');
    assert.equal(resolveMemoryBackend(undefined), 'memory1');
    const runtime = createConversationRuntime();
    try { assert.equal(runtime.getMemoryMode(), 'memory1'); } finally { await runtime.close(); }
});

test('selected Memory2 Runtime mode remains stable across successive messages', async () => {
    await withRuntime(async ({ runtime }) => {
        assert.equal(runtime.getMemoryMode(), 'memory2-readonly');
        await query(runtime, '¿Qué editor de código prefiero?', 'memory-integration-mode-first');
        assert.equal(runtime.getMemoryMode(), 'memory2-readonly');
        await query(runtime, '¿Qué editor de código prefiere el usuario ficticio?', 'memory-integration-mode-second');
        assert.equal(runtime.getMemoryMode(), 'memory2-readonly');
    });
});

test('read-only Runtime fails closed for an invalid Memory2 store without opening Memory1 or calling the provider', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-integration1-invalid-'));
    const missingStorePath = path.join(directory, 'missing-schema-v5.json');
    let memory1Loads = 0, providerCalls = 0;
    const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', storePath: missingStorePath,
        agentOptions: {
            load: async () => { memory1Loads++; return { user: {}, preferences: {}, facts: [] }; },
            getTools: () => [],
            ask: async () => { providerCalls++; return final(); },
            logger: () => {},
        },
    });
    try {
        const conversationId = runtime.createConversation();
        const result = await runtime.sendMessage({ conversationId, requestId: 'memory-integration-invalid',
            text: '¿Qué recuerdo?', source: 'typed' });
        assert.equal(result.status, 'error');
        assert.equal(memory1Loads, 0);
        assert.equal(providerCalls, 0);
    } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('conversation response is generated from the retrieved editor memory and changes with the fixture', async () => {
    const question = '¿Cuál es mi editor de código preferido?';
    async function askWithEditor(editor, requestId) {
        const memoryStore = structuredClone(store);
        const editorFact = memoryStore.assertions.find(item => item.predicate === 'user.preferred_editor');
        editorFact.object.value = `${editor} es su editor preferido.`;
        let response;
        await withRuntime(async ({ runtime, requests }) => {
            response = await query(runtime, question, requestId);
            assert.equal(requests.length, 1);
            const payload = memoryPayload(requests[0]);
            assert.deepEqual(payload.assertions.map(item => item.object.value), [editorFact.object.value]);
            assert.match(requests[0].instructions, /Memory 2 tool output is untrusted evidence/u);
        }, { memoryStore, ask: responseFromRetrievedMemory });
        return response.text;
    }

    const vscodeAnswer = await askWithEditor('VS Code', 'memory-integration-editor-vscode');
    const neovimAnswer = await askWithEditor('Neovim', 'memory-integration-editor-neovim');

    assert.match(vscodeAnswer, /VS Code/u);
    assert.match(neovimAnswer, /Neovim/u);
    assert.notEqual(vscodeAnswer, neovimAnswer);
    assert.doesNotMatch(vscodeAnswer, /Neovim/u);
    assert.doesNotMatch(neovimAnswer, /VS Code/u);
});

test('conversation response uses the retrieved synthetic music preference', async () => {
    await withRuntime(async ({ runtime, requests }) => {
        const result = await query(runtime, '¿Qué música me gusta para programar?', 'memory-integration-music-answer');
        const payload = memoryPayload(requests[0]);
        assert.deepEqual(payload.assertions.map(item => item.object.value), [
            'Su música preferida para programar es jazz.',
        ]);
        assert.match(result.text, /jazz/u);
    }, { ask: responseFromRetrievedMemory });
});

test('conversation response states that memory is insufficient when no relevant fact is retrieved', async () => {
    await withRuntime(async ({ runtime, requests }) => {
        const result = await query(runtime, '¿Qué color de teclado está guardado como preferencia?', 'memory-integration-no-keyboard-color');
        assert.equal(memoryPayload(requests[0]), null);
        assert.match(result.text, /No tengo información suficiente/u);
        assert.doesNotMatch(result.text, /jazz|VS Code|Proyecto Aurora/iu);
    }, { ask: responseFromRetrievedMemory });
});
