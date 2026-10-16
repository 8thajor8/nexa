import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { createRuntimeAgent } from '../src/core/runtime-agent.js';
import { applyChanges, contentDigest, immutableSnapshot } from '../src/memory/repository.js';
import { initializeEmptyMemoryStore } from '../src/memory/backend.js';
import { parseMemoryConfirmation } from '../src/memory/commands.js';

const sentence = 'El usuario ficticio prefiere VS Code como editor de código.';
const command = `Nexa, recordá que ${sentence}`;

function final(text = 'Respuesta sintética.') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

function semanticIntent({ intent = 'remember', confidence = 'high', sourceQuote, subjectReference = '', topic, newValue = '', oldValue = '' } = {}) {
    return { status: 'completed', output: [{ type: 'function_call', name: 'interpret_memory_intent', call_id: 'memory-intent-test',
        arguments: JSON.stringify({ intent, confidence, sourceQuote, subjectReference, topic: topic ?? (intent === 'update_preference'
            || intent === 'update_editor_preference' || intent === 'correct_editor_preference' ? 'editor' : ''), newValue, oldValue }) }], output_text: '' };
}

function options(ask) {
    return { getTools: () => [], ask, logger: () => {}, load: async () => {
        throw new Error('Memory1 must not be opened by the explicit Memory2 mode');
    }, save: async () => { throw new Error('Memory1 save must not be called'); } };
}

async function withStore(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-confirmed-write-'));
    const storePath = path.join(directory, 'schema-v5.json');
    await mkdir(directory, { recursive: true });
    await initializeEmptyMemoryStore({ storePath });
    try { await callback({ directory, storePath }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

async function send(runtime, conversationId, requestId, text) {
    const result = await runtime.sendMessage({ conversationId, requestId, text, source: 'typed' });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return result.text;
}

function createWritableRuntime(storePath, ask = async () => final(), memory2Repository = null, diagnostic = () => {}) {
    const agentOptions = { ...options(ask), allowConfirmedMemoryWrites: true };
    if (!memory2Repository) return createConversationRuntime({ memoryMode: 'memory2-confirmed-write', storePath, agentOptions, diagnostic });
    return createConversationRuntime({ memoryMode: 'memory2-confirmed-write', storePath, agentOptions, diagnostic,
        agentFactory: runtimeOptions => createRuntimeAgent({ ...runtimeOptions,
            agentOptions: { ...runtimeOptions.agentOptions, memory2Repository } }) });
}

async function createInMemoryMemoryRepository(storePath, { failCommit = false } = {}) {
    let store = JSON.parse(await readFile(storePath, 'utf8'));
    let revision = 0;
    const digest = () => contentDigest(Buffer.from(JSON.stringify(store), 'utf8'));
    return {
        async open() { return immutableSnapshot(store, digest()); },
        async readSnapshot() { return immutableSnapshot(store, digest()); },
        async commit(request) {
            if (failCommit) throw new Error('synthetic persistence failure');
            store = applyChanges(store, request.changes, new Date().toISOString());
            revision = store.revision;
            return immutableSnapshot(store, digest());
        },
        async close() {},
        getStore() { return structuredClone(store); },
        getRevision() { return revision; },
    };
}

function memoryContext(request) {
    const output = request.input.find(item => item?.type === 'function_call_output'
        && item.call_id?.startsWith('memory_context_'))?.output;
    return output ? JSON.parse(output) : null;
}

test('Desktop explicit remember previews without writing, then saves only after the matching direct confirmation and survives Runtime restart', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const ask = async request => { providerCalls++; return final('Respuesta sintética.'); };
        let runtime = createWritableRuntime(storePath, ask);
        const conversationId = runtime.createConversation();
        const preview = await send(runtime, conversationId, 'memory-write-preview-01', command);
        assert.match(preview, /¿Querés que recuerde esto/u);
        assert.match(preview, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
        assert.equal(providerCalls, 0, 'the explicit write request must not be sent to the model');
        let contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.revision, 0);
        assert.deepEqual(contents.assertions, []);

        assert.equal(await send(runtime, conversationId, 'memory-write-confirm-01', 'sí'), 'Listo, me acuerdo.');
        contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.assertions.length, 1);
        assert.equal(contents.assertions[0].object.value, sentence);
        assert.equal(contents.assertions[0].status, 'active');
        assert.equal(contents.sources.length, 1);
        assert.equal(contents.evidence.length, 1);
        assert.equal(contents.revision, 1);
        assert.equal(providerCalls, 0);

        await send(runtime, conversationId, 'memory-write-equivalent-preview', command);
        assert.equal(await send(runtime, conversationId, 'memory-write-equivalent-confirm', 'sí'), 'Ese recuerdo ya estaba guardado.');
        contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.revision, 1, 'equivalent proposals do not claim or perform another write');
        assert.equal(contents.assertions.length, 1);
        await runtime.close();

        const requests = [];
        runtime = createWritableRuntime(storePath, async request => {
            requests.push(request);
            return final('Respuesta sintética basada en contexto.');
        });
        const restartedConversation = runtime.createConversation();
        await send(runtime, restartedConversation, 'memory-write-recall-01', '¿Qué editor de código prefiero?');
        const payload = memoryContext(requests[0]);
        assert.ok(payload);
        assert.ok(payload.assertions.some(record => record.object.value === sentence));
        await runtime.close();
    });
});

test('Desktop recognizes an explicit trailing “Recordalo” request and confirms persistence before saving', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            providerCalls++;
            assert.ok(request.tools.some(tool => tool.name === 'interpret_memory_intent'));
            return semanticIntent({ sourceQuote: 'mi editor de código favorito es Sublime Text' });
        });
        const conversationId = runtime.createConversation();
        const request = 'Nexa, para esta prueba, mi editor de código favorito es Sublime Text. Recordalo.';
        const preview = await send(runtime, conversationId, 'memory-write-recordalo-preview', request);
        assert.match(preview, /¿Querés que recuerde esto/u);
        assert.match(preview, /Sublime Text/u);
        assert.equal(providerCalls, 1);
        let contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.revision, 0);
        assert.deepEqual(contents.assertions, []);

        const diagnostic = await runtime.sendMessage({ conversationId, requestId: 'memory-write-recordalo-diagnostic',
            text: 'Nexa, diagnosticá tu memoria', source: 'typed' });
        assert.equal(diagnostic.status, 'completed');
        assert.match(diagnostic.text, /pendiente de tu confirmación/u);
        const detail = JSON.parse(diagnostic.presentation.technicalDetail);
        assert.equal(detail.confirmedWriteAvailability, 'available');
        assert.equal(detail.lastMemoryChange.intentDetected, true);
        assert.equal(detail.lastMemoryChange.proposalGenerated, true);
        assert.equal(detail.lastMemoryChange.confirmationRequested, true);
        assert.equal(detail.lastMemoryChange.persisted, 'no');
        assert.doesNotMatch(diagnostic.presentation.technicalDetail, /Sublime Text|para esta prueba/u);

        assert.equal(await send(runtime, conversationId, 'memory-write-recordalo-confirm', 'sí'), 'Listo, me acuerdo.');
        contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.revision, 1);
        assert.equal(contents.assertions.length, 1);
        assert.equal(contents.assertions[0].object.value, 'mi editor de código favorito es Sublime Text');
        assert.equal(providerCalls, 1);
        await runtime.close();
    });
});

test('contextual remember quotes one recent user statement, previews it, and persists only after confirmation', async () => {
    await withStore(async ({ storePath }) => {
        let interpreterCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            if (!request.tools.some(tool => tool.name === 'interpret_memory_intent')) return final('Entendido.');
            interpreterCalls++;
            assert.ok(request.input.some(item => item.role === 'user' && item.content === 'Mi pareja se llama Alex.'));
            return semanticIntent({ sourceQuote: 'Mi pareja se llama Alex.' });
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'context-save-source', 'Mi pareja se llama Alex.');
        const preview = await send(runtime, conversationId, 'context-save-request', 'Guardalo.');
        assert.match(preview, /¿Querés que recuerde esto/u);
        assert.match(preview, /Mi pareja se llama Alex/u);
        assert.equal(interpreterCalls, 1);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        assert.equal(await send(runtime, conversationId, 'context-save-confirm', 'sí'), 'Listo, me acuerdo.');
        const persisted = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(persisted.revision, 1);
        assert.equal(persisted.assertions.length, 1);
        assert.equal(persisted.assertions[0].object.value, 'Mi pareja se llama Alex.');
        await runtime.close();
    });
});

test('contextual save handles a persistent preference and a rejected preview without writing', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async request => request.tools.some(tool => tool.name === 'interpret_memory_intent')
            ? semanticIntent({ sourceQuote: 'Prefiero respuestas cortas.' }) : final('De acuerdo.'));
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'context-preference-source', 'Prefiero respuestas cortas.');
        const preview = await send(runtime, conversationId, 'context-preference-save', 'Tenelo en cuenta para todo.');
        assert.match(preview, /Prefiero respuestas cortas/u);
        assert.match(await send(runtime, conversationId, 'context-preference-reject', 'Mejor no'), /no guardé/u);
        const persisted = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(persisted.revision, 0);
        assert.deepEqual(persisted.assertions, []);
        await runtime.close();
    });
});

test('three-turn contextual durable save uses only user evidence and persists once without a second confirmation', async () => {
    await withStore(async ({ storePath }) => {
        const source = 'En esta simulación, la pareja de Sam se llama Alex.';
        const assistantParaphrase = 'Entiendo: Alex es la pareja de Sam en este escenario ficticio.';
        let providerCalls = 0;
        let interpretedQuote;
        const runtime = createWritableRuntime(storePath, async request => {
            providerCalls++;
            if (!request.tools.some(tool => tool.name === 'interpret_memory_intent')) return final(assistantParaphrase);
            const assistantTurn = request.input.find(item => item.role === 'assistant');
            interpretedQuote = assistantTurn?.content ?? source;
            return semanticIntent({ sourceQuote: interpretedQuote });
        });
        const conversationId = runtime.createConversation();
        assert.equal(await send(runtime, conversationId, 'context-durable-source', source), assistantParaphrase);
        const saved = await send(runtime, conversationId, 'context-durable-save', 'Guardalo permanentemente.');
        assert.match(saved, /guardé el recuerdo/u);
        assert.equal(interpretedQuote, source,
            'if an assistant paraphrase is supplied, the simulated interpreter prefers it and the evidence validator would reject it');
        let persisted = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(persisted.revision, 1);
        assert.equal(persisted.assertions.length, 1);
        assert.equal(persisted.assertions[0].object.value, source);

        await send(runtime, conversationId, 'context-durable-duplicate', `Guardá que ${source}`);
        persisted = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(persisted.revision, 1, 'repeating the explicit save must not create a duplicate');
        assert.equal(persisted.assertions.length, 1);
        assert.equal(providerCalls, 2, 'the contextual request is interpreted once; deterministic explicit saves need no model call');
        await runtime.close();
    });
});

test('“Recordá esto para siempre” directly authorizes one verified contextual save', async () => {
    await withStore(async ({ storePath }) => {
        const source = 'Para este escenario ficticio, el equipo Lumen se reúne los jueves.';
        const runtime = createWritableRuntime(storePath, async request => request.tools.some(tool => tool.name === 'interpret_memory_intent')
            ? semanticIntent({ sourceQuote: source }) : final('Anotado para esta prueba.'));
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'context-forever-source', source);
        const saved = await send(runtime, conversationId, 'context-forever-save', 'Recordá esto para siempre.');
        assert.match(saved, /guardé el recuerdo/u);
        const persisted = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(persisted.revision, 1);
        assert.equal(persisted.assertions.length, 1);
        assert.equal(persisted.assertions[0].object.value, source);
        await runtime.close();
    });
});

test('contextual relationship save normalizes only a uniquely user-verified person and accepts authorization after a comma', async () => {
    await withStore(async ({ storePath }) => {
        const memoryRepository = await createInMemoryMemoryRepository(storePath);
        const runtime = createWritableRuntime(storePath, async request => {
            if (!request.tools.some(tool => tool.name === 'interpret_memory_intent')) return final('Respuesta sintética.');
            const current = request.input.filter(item => item.role === 'user').at(-1)?.content;
            return current.includes('Alex') ? semanticIntent({ sourceQuote: 'Alex es mi pareja' })
                : semanticIntent({ sourceQuote: 'Es mi pareja', subjectReference: 'Alex' });
        }, memoryRepository);
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'relation-ref-question', '¿Quién es Alex?');
        await send(runtime, conversationId, 'relation-ref-assistant', 'Alex parece ser alguien importante.');
        const saved = await send(runtime, conversationId, 'relation-ref-save', 'Es mi pareja, guardalo permanentemente.');
        assert.match(saved, /guardé el recuerdo/u);
        let data = memoryRepository.getStore();
        assert.equal(data.assertions[0].object.value, 'Alex es mi pareja');
        assert.equal(data.revision, 1);
        await send(runtime, conversationId, 'relation-ref-duplicate', 'Alex es mi pareja, guardalo permanentemente.');
        data = memoryRepository.getStore();
        assert.equal(data.revision, 1, 'equivalent normalized assertions must not create duplicates');
        assert.equal(data.assertions.length, 1);

        const secondConversation = runtime.createConversation();
        await send(runtime, secondConversation, 'relation-important-source', 'Alex es importante para mí.');
        await send(runtime, secondConversation, 'relation-important-assistant', 'Entiendo que Alex es importante.');
        const secondSave = await send(runtime, secondConversation, 'relation-important-save',
            'Es mi pareja, guardalo permanentemente.');
        assert.match(secondSave, /ya estaba guardado/u);
        assert.equal(memoryRepository.getStore().assertions[0].object.value, 'Alex es mi pareja');
        await runtime.close();
    });
});

test('subject-omitted relationship asks for clarification without a user-verified unique referent', async () => {
    await withStore(async ({ storePath }) => {
        const memoryRepository = await createInMemoryMemoryRepository(storePath);
        const runtime = createWritableRuntime(storePath, async request => {
            if (!request.tools.some(tool => tool.name === 'interpret_memory_intent')) return final('Respuesta sintética.');
            return semanticIntent({ sourceQuote: 'Es mi pareja', subjectReference: 'Alex' });
        }, memoryRepository);
        const noContext = runtime.createConversation();
        const absent = await send(runtime, noContext, 'relation-no-subject', 'Es mi pareja, guardalo permanentemente.');
        assert.match(absent, /(?:a|de) qui[eé]n|qu[eé].*referente|qu[eé].*dato|qu[eé] quer[eé]s que recuerde|aclar/iu);
        assert.equal(memoryRepository.getRevision(), 0);

        const ambiguous = runtime.createConversation();
        await send(runtime, ambiguous, 'relation-two-people', 'Alex y Sam son importantes en este ejemplo.');
        const clarify = await send(runtime, ambiguous, 'relation-two-save', 'Es mi pareja, guardalo permanentemente.');
        assert.match(clarify, /(?:a|de) qui[eé]n|qu[eé].*referente|qu[eé].*dato|qu[eé] quer[eé]s que recuerde|aclar/iu);
        assert.equal(memoryRepository.getRevision(), 0);

        const assistantOnly = runtime.createConversation();
        await send(runtime, assistantOnly, 'relation-assistant-only-user', '¿Quién es esa persona?');
        await send(runtime, assistantOnly, 'relation-assistant-only-assistant', 'Alex es esa persona.');
        const noEvidence = await send(runtime, assistantOnly, 'relation-assistant-only-save', 'Es mi pareja, guardalo permanentemente.');
        assert.match(noEvidence, /(?:a|de) qui[eé]n|qu[eé].*referente|qu[eé].*dato|qu[eé] quer[eé]s que recuerde|aclar/iu);
        assert.equal(memoryRepository.getRevision(), 0);
        await runtime.close();
    });
});

test('contextual durable relationship does not claim success when Memory2 persistence fails', async () => {
    await withStore(async ({ storePath }) => {
        const memoryRepository = await createInMemoryMemoryRepository(storePath, { failCommit: true });
        const runtime = createWritableRuntime(storePath, async request => request.tools.some(tool => tool.name === 'interpret_memory_intent')
            ? semanticIntent({ sourceQuote: 'Alex es mi pareja' }) : final(), memoryRepository);
        const conversationId = runtime.createConversation();
        const result = await send(runtime, conversationId, 'relation-persist-failure',
            'Alex es mi pareja, guardalo permanentemente.');
        assert.match(result, /No pude guardar el recuerdo/u);
        assert.equal(memoryRepository.getRevision(), 0);
        await runtime.close();
    });
});

test('durable save still clarifies ambiguity and never claims success when persistence fails', async () => {
    await withStore(async ({ storePath }) => {
        let interpreterCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            if (!request.tools.some(tool => tool.name === 'interpret_memory_intent')) return final('Respuesta sintética.');
            interpreterCalls++;
            if (interpreterCalls === 1)
                return semanticIntent({ intent: 'clarify', sourceQuote: '' });
            return semanticIntent({ sourceQuote: 'En esta simulación, la estación favorita de Sol es otoño.' });
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'context-durable-ambiguous-a', 'En esta simulación, Sol prefiere respuestas breves.');
        await send(runtime, conversationId, 'context-durable-ambiguous-b', 'En este escenario, el color favorito de Sol es azul.');
        const ambiguous = await send(runtime, conversationId, 'context-durable-ambiguous-save', 'Guardalo permanentemente.');
        assert.match(ambiguous, /todavía no están claros|aclar/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);

        const source = 'En esta simulación, la estación favorita de Sol es otoño.';
        await send(runtime, conversationId, 'context-durable-failure-source', source);
        await writeFile(storePath, '{invalid synthetic fixture}', 'utf8');
        const failed = await send(runtime, conversationId, 'context-durable-failure-save', 'Guardalo permanentemente.');
        assert.match(failed, /No pude guardar el recuerdo/u);
        assert.doesNotMatch(failed, /guardé el recuerdo|Listo, me acuerdo/u);
        await runtime.close();
    });
});

test('a casual mention of remembering does not authorize a durable write', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            providerCalls++;
            if (request.tools.some(tool => tool.name === 'interpret_memory_intent'))
                return semanticIntent({ sourceQuote: 'En esta conversación ficticia, Sol prefiere respuestas breves.' });
            return final('Claro.');
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'context-casual-source', 'En este ejemplo ficticio, el proyecto se llama Lumen.');
        await send(runtime, conversationId, 'context-casual-mention', 'Algún día estaría bueno que lo recuerdes.');
        const emptyConversationId = runtime.createConversation();
        const ungrounded = await send(runtime, emptyConversationId, 'context-durable-no-source', 'Guardalo permanentemente.');
        assert.match(ungrounded, /No pude validar/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        assert.equal(providerCalls, 3);
        await runtime.close();
    });
});

test('contextual save asks on ambiguous references, missing antecedents, assistant-only evidence, and tentative source facts', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async request => {
            const userMessages = request.input.filter(item => item.role === 'user').map(item => item.content);
            const current = userMessages.at(-1);
            if (current === 'Guardá eso.') return semanticIntent({ intent: 'clarify', confidence: 'high', sourceQuote: '' });
            if (current === 'Guardalo.' && userMessages.filter(message => message === 'Prefiero respuestas cortas.').length > 1)
                return semanticIntent({ sourceQuote: 'Prefiero respuestas cortas.' });
            if (current === 'Guardalo.' && userMessages.includes('Quizás compre una moto.'))
                return semanticIntent({ sourceQuote: 'Quizás compre una moto.' });
            if (current === 'Guardalo.' && userMessages.includes('Pedime consejo.'))
                return semanticIntent({ sourceQuote: 'Tu color favorito es azul.' });
            if (current === 'Pedime consejo.') return final('Tu color favorito es azul.');
            return semanticIntent({ sourceQuote: 'Nexa dijo que mi dato es azul.' });
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'context-ambiguous-a', 'Prefiero respuestas cortas.');
        await send(runtime, conversationId, 'context-ambiguous-b', 'Mi color favorito es verde.');
        assert.match(await send(runtime, conversationId, 'context-ambiguous-save', 'Guardá eso.'), /no preparé ni guardé/iu);
        const missing = await send(runtime, conversationId, 'context-missing-save', 'Recordalo para siempre.');
        assert.match(missing, /No pude validar/u);
        await send(runtime, conversationId, 'context-assistant-only', 'Pedime consejo.');
        assert.match(await send(runtime, conversationId, 'context-assistant-only-save', 'Guardalo.'), /No pude validar/u);
        await send(runtime, conversationId, 'context-tentative-source', 'Quizás compre una moto.');
        assert.match(await send(runtime, conversationId, 'context-tentative-save', 'Guardalo.'), /todavía no están claros/u);
        const persisted = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(persisted.revision, 0);
        assert.deepEqual(persisted.assertions, []);
        const duplicateSourceConversation = runtime.createConversation();
        await send(runtime, duplicateSourceConversation, 'context-duplicate-source-a', 'Prefiero respuestas cortas.');
        await send(runtime, duplicateSourceConversation, 'context-duplicate-source-b', 'Prefiero respuestas cortas.');
        assert.match(await send(runtime, duplicateSourceConversation, 'context-duplicate-source-save', 'Guardalo.'), /todavía no están claros/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0,
            'the same quote in multiple prior user messages is ambiguous and must not prepare a write');
        await runtime.close();
    });
});

test('diagnostics report a detected explicit write intent that was rejected before proposal without retaining its text', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const request = `Nexa, ${'dato sintético '.repeat(90)}dato sintético. Recordalo.`;
        const sourceQuote = request.slice('Nexa, '.length, -' Recordalo.'.length);
        const runtime = createWritableRuntime(storePath, async () => {
            providerCalls++;
            return semanticIntent({ sourceQuote });
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-write-unparsed-intent', request);
        assert.equal(providerCalls, 1, 'unsupported overlong phrase remains a model turn, not a write');
        assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).assertions, []);
        const diagnostic = await runtime.sendMessage({ conversationId, requestId: 'memory-write-unparsed-diagnostic',
            text: 'Nexa, diagnosticá tu memoria', source: 'typed' });
        assert.match(diagnostic.text, /No pude validar la interpretación/u);
        assert.match(diagnostic.text, /No preparé una propuesta ni guardé ningún recuerdo/u);
        assert.doesNotMatch(diagnostic.presentation.technicalDetail, /dato sintético/u);
        const detail = JSON.parse(diagnostic.presentation.technicalDetail);
        assert.equal(detail.lastMemoryChange.intentDetected, true);
        assert.equal(detail.lastMemoryChange.proposalGenerated, false);
        assert.equal(detail.lastMemoryChange.errorCode, 'memory_intent_validation_failed');
        await runtime.close();
    });
});

test('semantic interpretation prepares a quoted colloquial preference and still requires explicit confirmation', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            providerCalls++;
            assert.match(request.instructions, /INTERPRETACIÓN DE INTENCIÓN DE MEMORIA/u);
            assert.ok(request.tools.some(tool => tool.name === 'interpret_memory_intent'));
            assert.equal(request.toolChoice, 'required');
            return semanticIntent({ sourceQuote: 'mi editor favorito es Cursor' });
        });
        const conversationId = runtime.createConversation();
        const preview = await send(runtime, conversationId, 'memory-semantic-preview', 'Che Nexa, anotá que mi editor favorito es Cursor.');
        assert.match(preview, /¿Querés que recuerde esto/u);
        assert.match(preview, /Cursor/u);
        assert.equal(providerCalls, 1);
        const beforeConfirm = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(beforeConfirm.revision, 0);
        assert.deepEqual(beforeConfirm.assertions, []);
        const diagnostic = await runtime.sendMessage({ conversationId, requestId: 'memory-semantic-status',
            text: 'Nexa, diagnosticá tu memoria', source: 'typed' });
        const detail = JSON.parse(diagnostic.presentation.technicalDetail);
        assert.equal(detail.lastMemoryChange.interpretationMechanism, 'semantic');
        assert.equal(detail.semanticInterpreterAvailable, true);
        assert.equal(detail.lastMemoryChange.semanticInterpreterAvailable, true);
        assert.equal(detail.lastMemoryChange.semanticInterpreterInvoked, true);
        assert.equal(detail.lastMemoryChange.semanticInterpretation, 'structured_intent');
        assert.equal(detail.lastMemoryChange.runtimeValidation, 'accepted');
        assert.equal(detail.lastMemoryChange.intentAccepted, true);
        assert.equal(detail.lastMemoryChange.proposalGenerated, true);
        assert.doesNotMatch(diagnostic.presentation.technicalDetail, /Cursor|editor favorito/u);

        assert.equal(await send(runtime, conversationId, 'memory-semantic-confirm', 'De una'), 'Listo, me acuerdo.');
        const afterConfirm = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(afterConfirm.revision, 1);
        assert.equal(afterConfirm.assertions[0].object.value, 'mi editor favorito es Cursor');
        await runtime.close();
    });
});

test('semantic remember stores only the fact and presents a natural confirmation for trailing reminder instructions', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async request => {
            assert.match(request.instructions, /sourceQuote debe contener únicamente el hecho/u);
            return semanticIntent({ sourceQuote: 'mi editor habitual es Windsurf' });
        });
        const conversationId = runtime.createConversation();
        const input = 'Che Nexa, mi editor habitual es Windsurf. Acordate de eso.';
        const proposal = await send(runtime, conversationId, 'memory-fact-only-preview', input);
        assert.match(proposal, /^Dale, ¿Querés que recuerde esto:/u);
        assert.match(proposal, /mi editor habitual es Windsurf/u);
        assert.doesNotMatch(proposal, /Acordate de eso|vence en dos minutos/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        assert.equal(await send(runtime, conversationId, 'memory-fact-only-confirm', 'dale'), 'Listo, me acuerdo.');
        const stored = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(stored.revision, 1);
        assert.equal(stored.assertions[0].object.value, 'mi editor habitual es Windsurf');
        await runtime.close();
    });
});

test('semantic remember handles a non-editor preference with a trailing “tenelo presente” instruction', async () => {
    await withStore(async ({ storePath }) => {
        let calls = 0;
        const runtime = createWritableRuntime(storePath, async () => {
            calls++;
            return semanticIntent({ sourceQuote: 'De ahora en más prefiero café sin azúcar' });
        });
        const conversationId = runtime.createConversation();
        const preview = await send(runtime, conversationId, 'memory-general-fact-preview',
            'De ahora en más prefiero café sin azúcar. Tenelo presente.');
        assert.match(preview, /¿Querés que recuerde esto/u);
        assert.doesNotMatch(preview, /Tenelo presente/u);
        assert.equal(calls, 1);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        assert.equal(await send(runtime, conversationId, 'memory-general-fact-confirm', 'dale'), 'Listo, me acuerdo.');
        const stored = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(stored.assertions[0].object.value, 'De ahora en más prefiero café sin azúcar');
        await runtime.close();
    });
});

test('semantic editor update reuses the existing candidate and confirmed-update safeguards', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async () => semanticIntent({
            intent: 'update_editor_preference', sourceQuote: 'Sublime', newValue: 'Sublime' }));
        const conversationId = runtime.createConversation();
        const first = await send(runtime, conversationId, 'memory-semantic-update-seed',
            'Nexa, recordá que mi editor de código favorito es VS Code.');
        assert.match(first, /¿Querés que recuerde esto|Dale, ¿querés que recuerde esto/u);
        await send(runtime, conversationId, 'memory-semantic-update-seed-confirm', 'sí');
        const update = await send(runtime, conversationId, 'memory-semantic-update-request',
            'Me cambié de editor, ahora prefiero Sublime.');
        assert.match(update, /¿La actualizo/u);
        assert.match(update, /Sublime/u);
        const contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.revision, 1, 'preparing an update must not persist it');
        assert.equal(contents.assertions.filter(item => item.status === 'active').length, 1);
        assert.equal(await send(runtime, conversationId, 'memory-semantic-update-confirm', 'Perfecto, hacelo'), 'Listo, actualicé tu preferencia.');
        const updated = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(updated.revision, 2);
        assert.equal(updated.assertions.filter(item => item.status === 'active').length, 1);
        assert.match(updated.assertions.find(item => item.status === 'active').object.value, /Sublime/u);
        await runtime.close();
    });
});

test('semantic update matches the retrieved habitual editor fact, preserves its wording, and keeps history', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async request => {
            if (request.tools.some(tool => tool.name === 'interpret_memory_intent')) {
                return semanticIntent({ intent: 'update_preference', confidence: 'high',
                    sourceQuote: 'Ahora uso Zed como editor habitual, ya no Windsurf',
                    topic: 'editor habitual', newValue: 'Zed', oldValue: 'Windsurf' });
            }
            if (request.tools.some(tool => tool.name === 'compose_memory_history_answer')) {
                const history = JSON.parse(request.input.find(item => item?.type === 'function_call_output'
                    && item.call_id?.startsWith('memory_history_')).output);
                const previous = history.facts.find(fact => fact.state === 'replaced');
                return { status: 'completed', output: [{ type: 'function_call', name: 'compose_memory_history_answer',
                    call_id: 'memory-history-test', arguments: JSON.stringify({ claims: [{
                        text: `Antes usabas ${previous.value}.`, role: 'previous', factIndexes: [previous.index],
                    }] }) }], output_text: '' };
            }
            const context = memoryContext(request);
            return final(context.assertions.find(item => item.status === 'active')?.object.value ?? 'Sin dato actual.');
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'habitual-editor-seed', 'Nexa, recordá que Mi editor habitual es Windsurf.');
        await send(runtime, conversationId, 'habitual-editor-seed-confirm', 'dale');
        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const oldRecord = before.assertions.find(item => item.status === 'active');

        const proposal = await send(runtime, conversationId, 'habitual-editor-proposal',
            'Che Nexa, ahora uso Zed como editor habitual, ya no Windsurf. Acordate de eso.');
        assert.match(proposal, /Windsurf.*Zed/u);
        assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')), before,
            'the selected record must remain unchanged until the user confirms');
        const diagnostic = await runtime.sendMessage({ conversationId, requestId: 'habitual-editor-diagnostic',
            text: 'Nexa, diagnóstico técnico de memoria', source: 'typed' });
        const details = JSON.parse(diagnostic.presentation.technicalDetail);
        assert.equal(details.lastMemoryChange.selectedRecordId, oldRecord.id);
        assert.equal(details.lastMemoryChange.matchStrategy, 'topic_and_old_value');
        assert.doesNotMatch(diagnostic.presentation.technicalDetail, /Windsurf|Zed|editor habitual/u);

        assert.equal(await send(runtime, conversationId, 'habitual-editor-confirm', 'dale'),
            'Listo, actualicé tu preferencia.');
        const after = JSON.parse(await readFile(storePath, 'utf8'));
        const current = after.assertions.find(item => item.status === 'active');
        assert.equal(current.object.value, 'Mi editor habitual es Zed.');
        assert.equal(current.supersedes[0], oldRecord.id);
        assert.equal(after.assertions.find(item => item.id === oldRecord.id).status, 'superseded');
        assert.equal(after.revision, before.revision + 1);
        const currentAnswer = await send(runtime, conversationId, 'habitual-editor-current', '¿Cuál es mi editor habitual?');
        assert.match(currentAnswer, /Zed/u);
        assert.doesNotMatch(currentAnswer, /Windsurf/u);
        assert.match(await send(runtime, conversationId, 'habitual-editor-previous', '¿Y antes?'), /Windsurf/u);
        await runtime.close();
    });
});

test('topic selection prevents an old value from choosing between distinct editor attributes', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async request => request.tools.some(tool => tool.name === 'interpret_memory_intent')
            ? semanticIntent({ intent: 'update_preference', sourceQuote: 'Ahora uso Cursor habitualmente, ya no Windsurf',
                topic: 'editor', newValue: 'Cursor', oldValue: 'Windsurf' }) : final());
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'attribute-habitual-seed', 'Recordá que mi editor habitual es Windsurf.');
        await send(runtime, conversationId, 'attribute-habitual-confirm', 'dale');
        await send(runtime, conversationId, 'attribute-testing-seed', 'Recordá que mi editor favorito para probar es Windsurf.');
        await send(runtime, conversationId, 'attribute-testing-confirm', 'dale');
        const before = JSON.parse(await readFile(storePath, 'utf8'));

        const response = await send(runtime, conversationId, 'attribute-underspecified-update',
            'Ahora uso Cursor habitualmente, ya no Windsurf. Acordate de eso.');
        assert.match(response, /varios recuerdos vigentes/u,
            'the shared topic “editor” and old product value cannot select an attribute');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision);
        await runtime.close();
    });
});

test('generic semantic transitions select current facts by topic and exact old value', async () => {
    const cases = [
        { fact: 'Mi navegador habitual es Chrome.', request: 'Me pasé de Chrome a Firefox.',
            quote: 'Me pasé de Chrome a Firefox', topic: 'navegador', oldValue: 'Chrome', newValue: 'Firefox' },
        { fact: 'Mi lenguaje preferido es JavaScript.', request: 'Últimamente prefiero TypeScript en lugar de JavaScript.',
            quote: 'prefiero TypeScript en lugar de JavaScript', topic: 'lenguaje preferido', oldValue: 'JavaScript', newValue: 'TypeScript' },
        { fact: 'Mi bebida habitual es café con azúcar.', request: 'Ahora tomo café sin azúcar; antes lo tomaba con azúcar.',
            quote: 'Ahora tomo café sin azúcar; antes lo tomaba con azúcar', topic: 'bebida habitual', oldValue: 'con azúcar', newValue: 'café sin azúcar' },
        { fact: 'Mi aplicación habitual es A.', request: 'Cambié mi aplicación habitual de A a B.',
            quote: 'mi aplicación habitual de A a B', topic: 'aplicación habitual', oldValue: 'A', newValue: 'B' },
    ];
    for (const [index, item] of cases.entries()) {
        await withStore(async ({ storePath }) => {
            const runtime = createWritableRuntime(storePath, async request => request.tools.some(tool => tool.name === 'interpret_memory_intent')
                ? semanticIntent({ intent: 'update_preference', sourceQuote: item.quote, topic: item.topic,
                    oldValue: item.oldValue, newValue: item.newValue }) : final());
            const conversationId = runtime.createConversation();
            await send(runtime, conversationId, `generic-update-seed-${index}`, `Nexa, recordá que ${item.fact}`);
            await send(runtime, conversationId, `generic-update-seed-confirm-${index}`, 'sí');
            const proposal = await send(runtime, conversationId, `generic-update-preview-${index}`, item.request);
            assert.match(proposal, new RegExp(item.oldValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
            assert.match(proposal, new RegExp(item.newValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
            assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 1);
            await send(runtime, conversationId, `generic-update-confirm-${index}`, 'sí');
            const stored = JSON.parse(await readFile(storePath, 'utf8'));
            assert.equal(stored.assertions.filter(record => record.status === 'active').length, 1);
            assert.ok(stored.assertions.find(record => record.status === 'active').object.value.includes(item.newValue));
            assert.equal(stored.revision, 2);
            await runtime.close();
        });
    }
});

test('generic semantic update asks for clarification when topic and old value match multiple current facts', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async () => semanticIntent({
            intent: 'update_preference', sourceQuote: 'Me pasé de Chrome a Firefox',
            topic: 'navegador', oldValue: 'Chrome', newValue: 'Firefox' }));
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'ambiguous-generic-seed-one',
            'Nexa, recordá que Mi navegador habitual es Chrome.');
        await send(runtime, conversationId, 'ambiguous-generic-seed-one-confirm', 'sí');
        await send(runtime, conversationId, 'ambiguous-generic-seed-two',
            'Nexa, recordá que Mi navegador principal es Chrome.');
        await send(runtime, conversationId, 'ambiguous-generic-seed-two-confirm', 'sí');
        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const response = await send(runtime, conversationId, 'ambiguous-generic-update', 'Me pasé de Chrome a Firefox');
        assert.match(response, /varios recuerdos vigentes/u);
        assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')), before);
        await runtime.close();
    });
});

test('colloquial preference change plus remember request becomes an update proposal, not a contradictory new fact', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            providerCalls++;
            assert.equal(request.toolChoice, 'required');
            return semanticIntent({ intent: 'update_editor_preference', confidence: 'high',
                sourceQuote: 'me pase a Cursor, ya no uso VS Code', newValue: 'Cursor', oldValue: 'VS Code' });
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-natural-seed', 'Nexa, recordá que mi editor de código favorito es VS Code.');
        await send(runtime, conversationId, 'memory-natural-seed-confirm', 'sí');
        providerCalls = 0;

        const proposal = await send(runtime, conversationId, 'memory-natural-update',
            'Che nexa, me pase a Cursor, ya no uso VS Code. acordate dale?');
        assert.match(proposal, /Ah, entonces cambiaste «VS Code» por «Cursor»/u);
        assert.match(proposal, /VS Code/u);
        assert.match(proposal, /Cursor/u);
        assert.equal(providerCalls, 1, 'the direct request uses one structured interpretation call');
        const pending = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(pending.revision, 1, 'no update is persisted before confirmation');
        assert.equal(pending.assertions.filter(item => item.status === 'active').length, 1);
        await send(runtime, conversationId, 'memory-natural-update-confirm', 'De una');
        const updated = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(updated.revision, 2);
        assert.equal(updated.assertions.filter(item => item.status === 'active').length, 1);
        assert.match(updated.assertions.find(item => item.status === 'active').object.value, /Cursor/u);
        await runtime.close();
    });
});

test('semantic update accepts accent and case normalization only when quote and values are evidenced in the user text', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async () => semanticIntent({
            intent: 'update_editor_preference', confidence: 'high',
            sourceQuote: 'me pasé a cursor, ya no uso vs code',
            newValue: 'Me pasé a Cursor, ya no uso VS Code.', oldValue: 'Ya no uso VS Code.' }));
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-normalized-seed',
            'Nexa, recordá que mi editor de código favorito es VS Code.');
        await send(runtime, conversationId, 'memory-normalized-seed-confirm', 'sí');
        const proposal = await send(runtime, conversationId, 'memory-normalized-update',
            'Che nexa, me pase a Cursor, ya no uso VS Code. acordate dale?');
        assert.match(proposal, /¿Querés que actualice esa preferencia/u);
        assert.match(proposal, /VS Code/u);
        assert.match(proposal, /Cursor/u);
        const beforeConfirm = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(beforeConfirm.revision, 1, 'normalization must not bypass confirmation');
        assert.equal(await send(runtime, conversationId, 'memory-normalized-update-confirm', 'sí'),
            'Listo, actualicé tu preferencia.');
        const afterConfirm = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(afterConfirm.revision, 2);
        assert.match(afterConfirm.assertions.find(item => item.status === 'active').object.value, /Cursor/u);
        await runtime.close();
    });
});

test('semantic validation diagnostics identify missing or unsupported evidence without retaining user text', async () => {
    await withStore(async ({ storePath }) => {
        const cases = [
            { name: 'quote', args: { intent: 'remember', confidence: 'high', sourceQuote: 'recordá una clave inventada', subjectReference: '', topic: '', newValue: '', oldValue: '' },
                category: 'source_quote_not_validated' },
            { name: 'instruction-in-quote', args: { intent: 'remember', confidence: 'high',
                sourceQuote: 'mi editor habitual es Windsurf. Acordate de eso', subjectReference: '', topic: '', newValue: '', oldValue: '' },
            category: 'source_quote_contains_instruction',
            request: 'Che Nexa, mi editor habitual es Windsurf. Acordate de eso.' },
            { name: 'new-value', args: { intent: 'update_editor_preference', confidence: 'high', topic: 'editor',
                sourceQuote: 'ya no uso VS Code, ahora prefiero Cursor', subjectReference: '', newValue: 'Inventado', oldValue: 'VS Code' },
            category: 'new_value_not_validated' },
            { name: 'old-value', args: { intent: 'update_editor_preference', confidence: 'high', topic: 'editor',
                sourceQuote: 'ya no uso VS Code, ahora prefiero Cursor', subjectReference: '', newValue: 'Cursor', oldValue: 'Inventado' },
            category: 'old_value_not_validated' },
            { name: 'new-value-missing', args: { intent: 'update_editor_preference', confidence: 'high', topic: 'editor',
                sourceQuote: 'ya no uso VS Code, ahora prefiero Cursor', subjectReference: '', newValue: '', oldValue: 'VS Code' },
            category: 'new_value_missing' },
            { name: 'new-value-malformed', args: { intent: 'update_editor_preference', confidence: 'high', topic: 'editor',
                sourceQuote: 'ya no uso VS Code, ahora prefiero Cursor', subjectReference: '', newValue: `Cursor\u0001`, oldValue: 'VS Code' },
            category: 'new_value_malformed' },
            { name: 'required-field', args: { intent: 'remember', confidence: 'high', sourceQuote: 'mi dato es azul' },
                category: 'required_field_missing' },
        ];
        for (const item of cases) {
            const runtime = createWritableRuntime(storePath, async () => ({ status: 'completed', output: [
                { type: 'function_call', name: 'interpret_memory_intent', call_id: `memory-intent-${item.name}`,
                    arguments: JSON.stringify(item.args) }], output_text: '' }));
            const conversationId = runtime.createConversation();
            const request = item.request ?? (item.name === 'quote' ? 'Nexa, acordate que mi editor favorito es Cursor.'
                : 'Nexa, cambié de editor: ya no uso VS Code, ahora prefiero Cursor. anotá el cambio.');
            const rejected = await send(runtime, conversationId, `memory-validation-${item.name}`, request);
            assert.match(rejected, /No pude validar/u);
            const diagnostic = await runtime.sendMessage({ conversationId, requestId: `memory-validation-${item.name}-diag`,
                text: 'Nexa, diagnóstico técnico de memoria', source: 'typed' });
            const details = JSON.parse(diagnostic.presentation.technicalDetail);
            assert.equal(details.lastMemoryChange.validationCategory, item.category);
            assert.match(diagnostic.text, new RegExp(item.category));
            assert.doesNotMatch(diagnostic.presentation.technicalDetail, /Inventado|acordate|editor favorito|ya no uso/u);
            assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0,
                'rejected interpretation must never write');
            await runtime.close();
        }
    });
});

test('clear preference transition is interpreted semantically and still waits for confirmation', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async () => semanticIntent({
            intent: 'update_editor_preference', sourceQuote: 'Ya no uso VS Code, ahora prefiero Cursor',
            newValue: 'Cursor', oldValue: 'VS Code' }));
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-transition-seed', 'Nexa, recordá que mi editor favorito es VS Code.');
        await send(runtime, conversationId, 'memory-transition-seed-confirm', 'sí');
        const proposal = await send(runtime, conversationId, 'memory-transition-request', 'Ya no uso VS Code, ahora prefiero Cursor.');
        assert.match(proposal, /¿Querés que actualice esa preferencia/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 1);
        await runtime.close();
    });
});

test('semantic interpreter handles common shorthand spelling without accepting model-invented facts', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const runtime = createWritableRuntime(storePath, async () => {
            providerCalls++;
            return semanticIntent({ sourceQuote: 'mi editor es Cursor' });
        });
        const conversationId = runtime.createConversation();
        const preview = await send(runtime, conversationId, 'memory-semantic-shorthand',
            'Nexa, recorda q mi editor es Cursor.');
        assert.match(preview, /¿Querés que recuerde esto/u);
        assert.equal(providerCalls, 1);
        await send(runtime, conversationId, 'memory-semantic-shorthand-cancel', 'Mejor no');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        await runtime.close();

        const invalidRuntime = createWritableRuntime(storePath, async () => semanticIntent({
            sourceQuote: 'mi editor favorito es Inventado' }));
        const invalidConversation = invalidRuntime.createConversation();
        const rejected = await send(invalidRuntime, invalidConversation, 'memory-semantic-fabricated-quote',
            'Anotá que mi editor favorito es Cursor.');
        assert.match(rejected, /No pude validar qué querés recordar/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        await invalidRuntime.close();
    });
});

test('ambiguous mentions do not invoke semantic memory preparation or write anything', async () => {
    await withStore(async ({ storePath }) => {
        let providerCalls = 0;
        const runtime = createWritableRuntime(storePath, async request => {
            providerCalls++;
            assert.equal(request.tools.some(tool => tool.name === 'interpret_memory_intent'), false);
            return final('Podés seguir probándolo y decidir después.');
        });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-ambiguous-mention',
            'Estoy probando Cursor, pero todavía no sé si me gusta.');
        assert.equal(providerCalls, 1);
        const tentative = await send(runtime, conversationId, 'memory-explicit-tentative',
            'Anotá que quizá prefiero Cursor.');
        assert.match(tentative, /el dato todavía es incierto/u);
        assert.equal(providerCalls, 1, 'the deterministic uncertainty guard avoids a semantic model call');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        await runtime.close();
    });
});

test('semantic output must be high confidence and quote exact user text; acknowledgements alone never confirm without a pending proposal', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async () => semanticIntent({ confidence: 'medium',
            sourceQuote: 'mi editor favorito es Cursor' }));
        const conversationId = runtime.createConversation();
        const ambiguous = await send(runtime, conversationId, 'memory-semantic-medium',
            'Anotá que mi editor favorito es Cursor.');
        assert.match(ambiguous, /no preparé ni guardé/iu);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        await runtime.close();

        assert.equal(parseMemoryConfirmation('Dale, guardalo'), 'confirm');
        assert.equal(parseMemoryConfirmation('Sip'), 'confirm');
        assert.equal(parseMemoryConfirmation('Perfecto, hacelo'), 'confirm');
        assert.equal(parseMemoryConfirmation('No, pará, todavía no guardes eso'), 'cancel');
        assert.equal(parseMemoryConfirmation('Nono'), 'cancel');
        assert.equal(parseMemoryConfirmation('Mejor no'), 'cancel');
        assert.equal(parseMemoryConfirmation('Joya'), null, 'a simple acknowledgment is not consent');
    });
});

test('semantic service failure is reported as an observed interpreter failure without raw model errors', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath, async () => { throw new Error('private provider detail'); });
        const conversationId = runtime.createConversation();
        const response = await runtime.sendMessage({ conversationId, requestId: 'memory-semantic-service-failure',
            text: 'Nexa, acordate que mi color favorito es azul.', source: 'typed' });
        assert.equal(response.status, 'completed');
        assert.match(response.text, /No pude validar/u);
        const diagnostic = await runtime.sendMessage({ conversationId, requestId: 'memory-semantic-service-diagnostic',
            text: 'Nexa, diagnóstico técnico de memoria', source: 'typed' });
        const detail = JSON.parse(diagnostic.presentation.technicalDetail);
        assert.equal(detail.lastMemoryChange.semanticInterpreterInvoked, true);
        assert.equal(detail.lastMemoryChange.semanticInterpretation, 'failed');
        assert.equal(detail.lastMemoryChange.runtimeValidation, 'not_run');
        assert.equal(detail.lastMemoryChange.errorCode, 'memory_intent_interpretation_failed');
        assert.doesNotMatch(diagnostic.presentation.technicalDetail, /private provider detail/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        await runtime.close();
    });
});

test('affirmation in another conversation cannot confirm or consume the pending proposal', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath);
        const ownerConversation = runtime.createConversation();
        const otherConversation = runtime.createConversation();
        await send(runtime, ownerConversation, 'memory-write-bound-preview', command);
        const unrelatedConfirmation = await runtime.sendMessage({ conversationId: otherConversation,
            requestId: 'memory-write-bound-other', text: 'sí', source: 'typed' });
        assert.equal(unrelatedConfirmation.status, 'error', 'the separately scoped agent cannot access the already-open write store');
        let contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.deepEqual(contents.assertions, []);
        assert.equal((await send(runtime, ownerConversation, 'memory-write-bound-confirm', 'sí')), 'Listo, me acuerdo.');
        contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.assertions.length, 1);
        await runtime.close();
    });
});

test('expired confirmation and duplicate confirmation never produce duplicate writes', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath);
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-write-expiry-preview', command);
        const originalNow = Date.now;
        try {
            Date.now = () => originalNow() + 121_000;
            assert.match(await send(runtime, conversationId, 'memory-write-expired-yes', 'sí'), /venci[oó]/iu);
        } finally { Date.now = originalNow; }
        let contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.deepEqual(contents.assertions, []);

        await send(runtime, conversationId, 'memory-write-once-preview', command);
        await send(runtime, conversationId, 'memory-write-once-yes', 'confirmo');
        const duplicate = await send(runtime, conversationId, 'memory-write-once-duplicate', 'sí');
        assert.doesNotMatch(duplicate, /lo guardé/u);
        contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.assertions.length, 1);
        assert.equal(contents.revision, 1);
        await runtime.close();
    });
});

test('cancellation, confirmation without a proposal, and failed persistence never claim a successful write', async () => {
    await withStore(async ({ storePath }) => {
        const runtime = createWritableRuntime(storePath);
        const conversationId = runtime.createConversation();
        const noProposal = await send(runtime, conversationId, 'memory-write-no-proposal', 'sí');
        assert.doesNotMatch(noProposal, /lo guardé/u);
        await send(runtime, conversationId, 'memory-write-cancel-preview', command);
        assert.match(await send(runtime, conversationId, 'memory-write-cancel-no', 'no'), /no guardé/u);
        assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).assertions, []);

        await send(runtime, conversationId, 'memory-write-failure-preview', command);
        await writeFile(storePath, '{invalid test fixture}', 'utf8');
        const failed = await send(runtime, conversationId, 'memory-write-failure-confirm', 'sí');
        assert.match(failed, /No pude guardar/u);
        assert.doesNotMatch(failed, /Listo, lo guardé/u);
        await runtime.close();
    });
});

test('read-only Memory2 keeps the store byte-identical when given an explicit remember command', async () => {
    await withStore(async ({ storePath }) => {
        const before = await readFile(storePath);
        const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', storePath,
            agentOptions: options(async () => final('No se escribió nada.')) });
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'memory-write-readonly-attempt', command);
        await runtime.close();
        assert.deepEqual(await readFile(storePath), before);
    });
});
