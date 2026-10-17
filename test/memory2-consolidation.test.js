import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { initializeEmptyMemoryStore } from '../src/memory/backend.js';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { validateMemoryStore } from '../src/memory/schema.js';
import { createOperationalDiagnostics, createTechnicalDiagnosticReport } from '../src/core/system-diagnostics.js';
import { getActiveWindowTool } from '../src/windows/window-control.js';

function final(text = 'Respuesta sintética.') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

function interpreted({ intent, sourceQuote, topic, newValue = '', oldValue = '', confidence = 'high' }) {
    return { status: 'completed', output: [{ type: 'function_call', name: 'interpret_memory_intent', call_id: 'memory-intent-test',
        arguments: JSON.stringify({ intent, confidence, sourceQuote, subjectReference: '', topic: topic ?? (intent === 'update_preference'
            || intent === 'update_editor_preference' || intent === 'correct_editor_preference' ? 'editor' : ''), newValue, oldValue }) }], output_text: '' };
}

function composed(claims) {
    return { status: 'completed', output: [{ type: 'function_call', name: 'compose_memory_history_answer', call_id: 'history-answer-test',
        arguments: JSON.stringify({ claims }) }], output_text: '' };
}

function historyPayload(request) {
    const item = request.input.find(entry => entry?.type === 'function_call_output' && entry.call_id?.startsWith('memory_history_'));
    return item ? JSON.parse(item.output) : null;
}

function options(ask = async () => final(), overrides = {}) {
    return { getTools: () => [], ask, logger: () => {},
        load: async () => { throw new Error('Memory1 must not be opened in confirmed-write mode'); },
        save: async () => { throw new Error('Memory1 must not be saved in confirmed-write mode'); }, ...overrides };
}

function createRuntime(storePath, ask, agentOptions = {}) {
    return createConversationRuntime({ memoryMode: 'memory2-confirmed-write', storePath,
        agentOptions: { ...options(ask), allowConfirmedMemoryWrites: true, ...agentOptions } });
}

function toolCall(name, argumentsValue) {
    return { status: 'completed', output: [{ type: 'function_call', name, call_id: `synthetic-${name}`,
        arguments: JSON.stringify(argumentsValue) }], output_text: '' };
}

async function send(runtime, conversationId, text, requestId) {
    const result = await runtime.sendMessage({ conversationId, requestId, text, source: 'typed' });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return result.text;
}

async function withStore(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory2-consolidation-'));
    const storePath = path.join(directory, 'schema-v5.json');
    await initializeEmptyMemoryStore({ storePath });
    try { await callback({ directory, storePath }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

function addSyntheticTextHistory(store, { key, values, idStart }) {
    const recordedAt = new Date(Date.parse(store.created_at) + 1000).toISOString();
    for (let index = 0; index < values.length; index++) {
        const suffix = String(idStart + index).padStart(12, '0');
        const previousSuffix = index > 0 ? String(idStart + index - 1).padStart(12, '0') : null;
        const assertionId = `mem_00000000-0000-4000-8000-${suffix}`;
        const sourceId = `src_00000000-0000-4000-8000-${suffix}`;
        const evidenceId = `ev_00000000-0000-4000-8000-${suffix}`;
        store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note',
            object: { type: 'text', value: values[index] }, status: index === values.length - 1 ? 'active' : 'superseded',
            valid_from: null, valid_to: null, recorded_at: recordedAt,
            supersedes: previousSuffix ? [`mem_00000000-0000-4000-8000-${previousSuffix}`] : [],
            compatibility: { category: 'user', key } });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: null, recorded_at: recordedAt });
        store.evidence.push({ id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: 1, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null });
    }
    store.revision = 1;
    store.updated_at = recordedAt;
}

function addUnlinkedActivityState(store, { key, value, id, secondsAfterCreation }) {
    const suffix = String(id).padStart(12, '0');
    const recordedAt = new Date(Date.parse(store.created_at) + secondsAfterCreation * 1000).toISOString();
    const assertionId = `mem_00000000-0000-4000-8000-${suffix}`;
    const sourceId = `src_00000000-0000-4000-8000-${suffix}`;
    const evidenceId = `ev_00000000-0000-4000-8000-${suffix}`;
    store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note',
        object: { type: 'text', value }, status: 'active', valid_from: null, valid_to: null, recorded_at: recordedAt,
        supersedes: [], compatibility: { category: 'user', key } });
    store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
        locator: null, occurred_at: null, recorded_at: recordedAt });
    store.evidence.push({ id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
        extraction_confidence: 1, learned_at: recordedAt, last_confirmed_at: null, legacy_ref: null });
    store.revision = 1;
    store.updated_at = recordedAt;
}

async function seed(runtime, conversationId, value, id) {
    await send(runtime, conversationId, `Nexa, recordá que Mi editor de prueba favorito es ${value}.`, `${id}-preview`);
    assert.match(await send(runtime, conversationId, 'sí', `${id}-confirm`), /guardé|me acuerdo/u);
}

test('historical facts reach Responses API in verified order and produce a natural cited answer without writes', async () => {
    await withStore(async ({ storePath }) => {
        let modelCalls = 0;
        const instance = createRuntime(storePath, async request => {
            modelCalls++;
            const facts = historyPayload(request);
            assert.equal(facts.status, 'verified');
            assert.equal(facts.sequenceComplete, true);
            assert.deepEqual(facts.facts.map(item => item.state), ['replaced', 'replaced', 'current']);
            assert.deepEqual(facts.facts.map(item => item.relationToNext), ['superseded_by_next', 'superseded_by_next', 'no_verified_successor']);
            assert.match(request.instructions, /español natural/u);
            assert.deepEqual(request.tools.map(tool => tool.name), ['compose_memory_history_answer']);
            return composed([{ text: 'Antes de Cursor usabas VS Code; antes, Neovim.', role: 'previous', factIndexes: [1, 0] }]);
        });
        const conversationId = instance.createConversation();
        await seed(instance, conversationId, 'Neovim', 'history-neovim');
        await send(instance, conversationId, 'Nexa, cambié de editor. Ahora prefiero VS Code', 'history-update-vscode');
        await send(instance, conversationId, 'dale', 'history-confirm-vscode');
        await send(instance, conversationId, 'Nexa, cambié de editor. Ahora prefiero Cursor', 'history-update-cursor');
        await send(instance, conversationId, 'sí', 'history-confirm-cursor');

        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const answer = await send(instance, conversationId, 'Nexa, ¿qué editor usaba antes de Cursor?', 'history-query');
        assert.match(answer, /Antes de Cursor usabas VS Code; antes, Neovim/u);
        assert.equal(modelCalls, 1, 'the existing Responses API call composes the answer from retrieved facts');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision);
        await instance.close();
    });
});

test('contextual current and previous followups use the selected Memory2 history, not a prior assistant inference', async () => {
    await withStore(async ({ storePath }) => {
        let composeCount = 0;
        const instance = createRuntime(storePath, async request => {
            const toolNames = request.tools.map(tool => tool.name);
            const current = request.input.filter(item => item?.role === 'user').at(-1)?.content;
            if (toolNames.includes('interpret_memory_intent')) {
                const newValue = current.includes('VS Code') ? 'VS Code' : 'Cursor';
                const oldValue = newValue === 'VS Code' ? 'Sublime Text' : 'VS Code';
                return interpreted({ intent: 'update_editor_preference', sourceQuote: current, newValue, oldValue });
            }
            if (toolNames.includes('compose_memory_history_answer')) {
                composeCount++;
                const facts = historyPayload(request);
                assert.equal(request.input.filter(item => item?.role === 'assistant').length, 0,
                    'history generation must not receive earlier assistant claims as evidence');
                assert.deepEqual(facts.facts.map(item => item.value), [
                    'Mi editor de prueba favorito es Sublime Text.',
                    'Mi editor de prueba favorito es VS Code.',
                    'Mi editor de prueba favorito es Cursor.',
                ]);
                if (current === 'Nexa, ¿qué editor usaba antes de VS Code?')
                    return composed([{ text: 'Antes de VS Code usabas Sublime Text.', role: 'previous', factIndexes: [0] }]);
                if (current === '¿Y antes?') {
                    assert.equal(facts.requestedDimension, 'previous');
                    return composed([{ text: 'Antes usabas VS Code.', role: 'previous', factIndexes: [1] }]);
                }
            }
            if (current === '¿Y ahora?') return final('Ahora usás Cursor.');
            if (current === '¿Cuál es mi editor de prueba favorito?') return final('Ahora usas VS Code.');
            if (current === 'Nexa, por favor decime cuál es mi editor de prueba favorito actualmente para esta conversación.')
                return final('Ahora usas VS Code.');
            return final();
        });
        const conversationId = instance.createConversation();
        await seed(instance, conversationId, 'Sublime Text', 'followup-sublime');
        await send(instance, conversationId, 'Nexa, cambié de editor. Ahora prefiero VS Code', 'followup-vscode');
        await send(instance, conversationId, 'sí', 'followup-vscode-confirm');
        await send(instance, conversationId, 'Nexa, cambié de editor. Ahora prefiero Cursor', 'followup-cursor');
        await send(instance, conversationId, 'sí', 'followup-cursor-confirm');

        assert.equal(await send(instance, conversationId, 'Nexa, ¿qué editor usaba antes de VS Code?', 'followup-history'),
            'Antes de VS Code usabas Sublime Text.');
        assert.equal(await send(instance, conversationId, '¿Y ahora?', 'followup-current'), 'Ahora usás Cursor.');
        assert.equal(await send(instance, conversationId, '¿Y antes?', 'followup-previous'), 'Antes usabas VS Code.');
        await send(instance, conversationId,
            'Nexa, por favor decime cuál es mi editor de prueba favorito actualmente para esta conversación.', 'followup-wrong-current');
        assert.equal(await send(instance, conversationId, '¿Y ahora?', 'followup-current-after-error'), 'Ahora usás Cursor.');
        assert.equal(composeCount, 2);
        await instance.close();
    });
});

test('current routine timing stays conversational while cessation date uses verified history', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        addSyntheticTextHistory(store, { key: 'synthetic-weekly-routine', idStart: 631,
            values: ['Los martes ensayo con mi banda.'] });
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');
        const requests = [];
        const instance = createRuntime(storePath, async request => {
            requests.push(structuredClone(request));
            return final('Ensayás con tu banda los martes.');
        });
        const conversationId = instance.createConversation();
        try {
            assert.equal(await send(instance, conversationId, '¿Cuándo ensayo?', 'routine-current-query'),
                'Ensayás con tu banda los martes.');
            assert.equal(requests.length, 1, 'a current routine question must reach the conversational model');
            assert.equal(requests[0].tools.some(tool => tool.name === 'compose_memory_history_answer'), false,
                'a routine question must not use the historical date-answer route');
            assert.ok(requests[0].input.some(item => item?.call_id?.startsWith('memory_context_')),
                'the current routine remains available through ordinary Memory2 context retrieval');

            assert.equal(await send(instance, conversationId, '¿Cuándo dejé de ensayar?', 'routine-history-query'),
                'No tengo registrada una fecha verificable para ese cambio.');
            assert.equal(requests.length, 1,
                'a cessation-date question remains on the read-only historical route and refuses to invent a date');
        } finally { await instance.close(); }
    });
});

test('an unlinked explicit activity cessation resolves current state and history without merging other topics', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        addUnlinkedActivityState(store, { key: 'legacy-diving', value: 'Practico buceo.', id: 711,
            secondsAfterCreation: 1 });
        addUnlinkedActivityState(store, { key: 'practice-diving', value: 'Ya no practico buceo.', id: 712,
            secondsAfterCreation: 2 });
        addUnlinkedActivityState(store, { key: 'practice-swimming', value: 'Practico natación.', id: 713,
            secondsAfterCreation: 3 });
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');

        const repository = createJsonMemoryRepository({ storePath });
        await repository.open();
        try {
            const provider = createMemoryContextProvider({ repository });
            const currentSearch = await provider.search({ query: 'buceo', includeHistorical: false });
            assert.deepEqual(currentSearch.assertions.map(item => item.object.value), ['Ya no practico buceo.']);
            assert.deepEqual(currentSearch.conflicts, [], 'the current search does not report a completed cessation as a conflict');
            const historicalSearch = await provider.search({ query: 'buceo', includeHistorical: true });
            assert.ok(historicalSearch.assertions.some(item => item.object.value === 'Practico buceo.'),
                'an explicit historical search still retains the earlier activity');
        } finally { await repository.close(); }

        const requests = [];
        const instance = createRuntime(storePath, async request => {
            requests.push(structuredClone(request));
            const history = historyPayload(request);
            if (history) {
                assert.equal(history.status, 'verified');
                assert.equal(history.hasPrevious, true);
                assert.deepEqual(history.facts.map(item => [item.value, item.state]), [
                    ['Practico buceo.', 'replaced'], ['Ya no practico buceo.', 'current'],
                ]);
                return composed([{ text: 'Sí, antes practicabas buceo.', role: 'previous', factIndexes: [0] }]);
            }
            return final('Actualmente ya no practicás buceo.');
        });
        const conversationId = instance.createConversation();
        try {
            assert.equal(await send(instance, conversationId, '¿Sigo practicando buceo?', 'activity-current'),
                'Actualmente ya no practicás buceo.');
            const currentPayloadItem = requests[0].input.find(item => item?.type === 'function_call_output'
                && item.call_id?.startsWith('memory_context_'));
            assert.ok(currentPayloadItem);
            const currentPayload = JSON.parse(currentPayloadItem.output);
            assert.ok(currentPayload.assertions.some(item => item.object.value === 'Ya no practico buceo.'));
            assert.equal(currentPayload.assertions.some(item => item.object.value === 'Practico buceo.'), false,
                'the superseded positive record is not supplied as a current-state contradiction');
            assert.ok(currentPayload.assertions.some(item => item.object.value === 'Practico natación.'),
                'a different activity remains a separate current fact');

            assert.equal(await send(instance, conversationId, '¿Practicaba buceo antes?', 'activity-history'),
                'Sí, antes practicabas buceo.');
            assert.equal(requests.length, 2);

            const beforeDateQuestion = requests.length;
            assert.equal(await send(instance, conversationId, '¿Cuándo dejé de practicar buceo?', 'activity-date'),
                'No tengo registrada una fecha verificable para ese cambio.');
            assert.equal(requests.length, beforeDateQuestion,
                'the history route does not invent a cessation date');
        } finally { await instance.close(); }
    });
});

test('bare reason followup keeps chat context while explicit registered-motive questions stay in Memory2 history', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        addSyntheticTextHistory(store, { key: 'synthetic-editor-topic', idStart: 591,
            values: ['Mi editor de prueba favorito es Cursor.'] });
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');
        const requests = [];
        const instance = createRuntime(storePath, async request => {
            requests.push(structuredClone(request));
            const userText = request.input.filter(item => item?.role === 'user').at(-1)?.content;
            return final(userText === '¿Cuál es mi editor de prueba favorito?'
                ? 'Tu editor de prueba favorito registrado es Cursor.' : 'Te recomendé conservarlo para tener una copia recuperable.');
        });
        const conversationId = instance.createConversation();
        assert.equal(await send(instance, conversationId, '¿Cuál es mi editor de prueba favorito?', 'followup-prime'),
            'Tu editor de prueba favorito registrado es Cursor.');
        assert.ok(requests[0].input.some(item => item?.call_id?.startsWith('memory_context_')),
            'the first turn must retrieve Memory2 context and populate the topic IDs');
        const before = JSON.parse(await readFile(storePath, 'utf8'));

        assert.equal(await send(instance, conversationId, '¿Cuándo cambié mi editor habitual?', 'followup-date-no-evidence'),
            'No tengo registrada una fecha verificable para ese cambio.');
        assert.equal(requests.length, 1,
            'a historical date question without a verified date must use the safe fallback without asking the model to infer one');

        assert.equal(await send(instance, conversationId, '¿Y por qué?', 'followup-reason-contextual'),
            'Te recomendé conservarlo para tener una copia recuperable.');
        const conversational = requests.at(-1);
        assert.equal(conversational.tools.some(tool => tool.name === 'compose_memory_history_answer'), false);
        assert.ok(conversational.input.some(item => item?.role === 'assistant'
            && item.content?.some?.(part => part.type === 'output_text'
                && part.text === 'Tu editor de prueba favorito registrado es Cursor.')));

        assert.equal(await send(instance, conversationId, '¿Qué motivo tenía registrado para ese cambio?', 'followup-reason-explicit'),
            'No tengo registrado el motivo de ese cambio.');
        assert.equal(requests.length, 2, 'explicit missing-history fallback does not ask the model to invent a motive');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision,
            'informational followups do not mutate Memory2');
        await instance.close();
    });
});

test('ordinary why and correction followups keep the prior answer when Memory2 topic IDs are present', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        addSyntheticTextHistory(store, { key: 'synthetic-backup-topic', idStart: 601,
            values: ['El usuario conserva una copia de seguridad independiente para proteger sus archivos.'] });
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');

        const scenarios = [
            { followup: '¿Y por qué sería mala idea?', initial: 'Estoy pensando en borrar todas las copias de seguridad de mi computadora para liberar espacio. ¿Qué opinás?',
                answer: 'Borrar todas te dejaría sin una copia para recuperar tus archivos si falla el equipo.' },
            { followup: '¿Por qué me recomendaste eso?', initial: 'Estoy pensando en borrar todas las copias de seguridad de mi computadora para liberar espacio. ¿Qué opinás?',
                answer: 'Borrar todas te dejaría sin una copia para recuperar tus archivos si falla el equipo.' },
            { followup: '¿Y por qué?', initial: 'Estoy pensando en borrar todas las copias de seguridad de mi computadora para liberar espacio. ¿Qué opinás?',
                answer: 'Borrar todas te dejaría sin una copia para recuperar tus archivos si falla el equipo.' },
            { followup: 'No, me refería al segundo', initial: 'Tengo dos opciones para mis copias: borrar todas o mover una a un disco externo. ¿Qué opinás?',
                answer: 'Mover una copia a un disco externo es más seguro; borrar todas te deja sin recuperación.' },
        ];

        for (const [index, scenario] of scenarios.entries()) {
            const requests = [];
            const instance = createRuntime(storePath, async request => {
                requests.push(structuredClone(request));
                const userText = request.input.filter(item => item?.role === 'user').at(-1)?.content;
                if (userText === scenario.initial) return final(scenario.answer);
                return final('Respuesta contextual sintética.');
            });
            const conversationId = instance.createConversation();
            await send(instance, conversationId, scenario.initial, `contextual-reference-${index}-initial`);
            const memoryContext = requests[0].input.find(item => item?.type === 'function_call_output'
                && item.call_id?.startsWith('memory_context_'));
            assert.ok(memoryContext, 'the fixture must produce retrieved Memory2 topic IDs');
            assert.match(memoryContext.output, /copia de seguridad independiente/u);
            assert.equal(await send(instance, conversationId, scenario.followup, `contextual-reference-${index}-followup`),
                'Respuesta contextual sintética.');
            const followupRequest = requests.at(-1);
            assert.equal(followupRequest.input.filter(item => item?.role === 'user').at(-1)?.content, scenario.followup);
            assert.equal(followupRequest.tools.some(tool => tool.name === 'compose_memory_history_answer'), false,
                'ordinary references must not be routed to the Memory2 history composer');
            assert.ok(followupRequest.input.some(item => item?.role === 'user' && item.content === scenario.initial));
            assert.ok(followupRequest.input.some(item => item?.role === 'assistant'
                && item.content?.some?.(part => part.type === 'output_text' && part.text === scenario.answer)),
            'the immediately preceding assistant response must reach the model');
            await instance.close();
        }
    });
});

test('explicit historical reason questions still retrieve documented Memory2 reasons', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        addSyntheticTextHistory(store, { key: 'synthetic-editor-reason', idStart: 621, values: [
            'Mi editor habitual era Zed.',
            'Mi editor habitual ahora es Cursor porque necesitaba compatibilidad con mis proyectos actuales.',
        ] });
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');

        const requests = [];
        const instance = createRuntime(storePath, async request => {
            requests.push(structuredClone(request));
            const facts = historyPayload(request);
            assert.ok(facts, 'explicit historical questions must use the verified history path');
            assert.equal(facts.requestedDimension, 'reason');
            const index = facts.facts.findIndex(fact => fact.state === 'current' && fact.value.includes('porque'));
            assert.notEqual(index, -1, 'the documented reason must be supplied as evidence');
            return composed([{ text: 'Cambiaste a Cursor porque necesitabas compatibilidad con proyectos actuales.',
                role: 'current', factIndexes: [index] }]);
        });
        const conversationId = instance.createConversation();
        for (const [index, question] of [
            '¿Por qué cambié mi editor habitual?',
            '¿Qué motivo tenía registrado para ese cambio?',
        ].entries()) {
            const answer = await send(instance, conversationId, question, `explicit-reason-${index}`);
            assert.match(answer, /compatibilidad/u);
        }
        assert.equal(requests.length, 2);
        await instance.close();
    });
});

test('a new retrieved topic replaces the prior topic and ambiguous multi-topic followups ask for clarification', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        addSyntheticTextHistory(store, { key: 'synthetic-editor-topic', idStart: 401, values: [
            'Mi editor de prueba favorito es Sublime Text.', 'Mi editor de prueba favorito es Cursor.' ] });
        addSyntheticTextHistory(store, { key: 'synthetic-language-topic', idStart: 411, values: [
            'Mi lenguaje de prueba favorito es Rust.', 'Mi lenguaje de prueba favorito es Go.' ] });
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');

        const instance = createRuntime(storePath, async request => {
            const current = request.input.filter(item => item?.role === 'user').at(-1)?.content;
            if (request.tools.some(tool => tool.name === 'compose_memory_history_answer')) {
                const facts = historyPayload(request);
                if (current === '¿Y el editor anterior?') {
                    assert.deepEqual(facts.facts.map(item => item.value), [
                        'Mi editor de prueba favorito es Sublime Text.', 'Mi editor de prueba favorito es Cursor.' ]);
                    return composed([{ text: 'Antes usabas Sublime Text.', role: 'previous', factIndexes: [0] }]);
                }
                assert.deepEqual(facts.facts.map(item => item.value), [
                    'Mi lenguaje de prueba favorito es Rust.', 'Mi lenguaje de prueba favorito es Go.' ]);
                return composed([{ text: 'Antes de Go usabas Rust.', role: 'previous', factIndexes: [0] }]);
            }
            return final('Respuesta sintética.');
        });
        const conversationId = instance.createConversation();
        await send(instance, conversationId, '¿Cuál es mi editor de prueba favorito?', 'topic-editor-current');
        await send(instance, conversationId, '¿Cuál es mi lenguaje de prueba favorito?', 'topic-language-current');
        assert.equal(await send(instance, conversationId, '¿Y antes?', 'topic-language-before'), 'Antes de Go usabas Rust.');
        assert.equal(await send(instance, conversationId, '¿Y el editor anterior?', 'topic-editor-before'),
            'Antes usabas Sublime Text.');
        await instance.close();

        const ambiguousRuntime = createRuntime(storePath, async () => final('No debería componer una selección ambigua.'));
        const broadConversation = ambiguousRuntime.createConversation();
        await send(ambiguousRuntime, broadConversation, '¿Cuáles son mis preferencias de prueba?', 'topic-broad');
        assert.equal(await send(ambiguousRuntime, broadConversation, '¿Y antes?', 'topic-ambiguous-before'),
            'Encontré más de un historial posible. ¿A cuál te referís?');
        await ambiguousRuntime.close();
    });
});

test('historical retrieval works for a synthetic topic without editor or product-name rules', async () => {
    await withStore(async ({ storePath }) => {
        const store = JSON.parse(await readFile(storePath, 'utf8'));
        const time = new Date(Date.parse(store.created_at) + 1000).toISOString();
        const oldId = 'mem_00000000-0000-4000-8000-000000000101';
        const currentId = 'mem_00000000-0000-4000-8000-000000000102';
        const sourceIds = ['src_00000000-0000-4000-8000-000000000101', 'src_00000000-0000-4000-8000-000000000102'];
        const values = ['Mi lenguaje de programación favorito es Rust.', 'Mi lenguaje de programación favorito es Go.'];
        store.assertions.push(
            { id: oldId, kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note', object: { type: 'text', value: values[0] },
                status: 'superseded', valid_from: null, valid_to: null, recorded_at: time, supersedes: [],
                compatibility: { category: 'user', key: 'synthetic-language' } },
            { id: currentId, kind: 'fact', subject: { type: 'owner' }, predicate: 'user.note', object: { type: 'text', value: values[1] },
                status: 'active', valid_from: null, valid_to: null, recorded_at: time, supersedes: [oldId],
                compatibility: { category: 'user', key: 'synthetic-language' } });
        for (let index = 0; index < 2; index++) {
            store.sources.push({ id: sourceIds[index], kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
                locator: null, occurred_at: null, recorded_at: time });
            store.evidence.push({ id: `ev_00000000-0000-4000-8000-${String(101 + index).padStart(12, '0')}`, assertion_id: index ? currentId : oldId,
                source_id: sourceIds[index], derivation: 'explicit', extraction_confidence: 1, learned_at: time,
                last_confirmed_at: null, legacy_ref: null });
        }
        store.revision = 1;
        store.updated_at = time;
        validateMemoryStore(store);
        await writeFile(storePath, JSON.stringify(store), 'utf8');

        const instance = createRuntime(storePath, async request => {
            const facts = historyPayload(request);
            assert.deepEqual(facts.facts.map(item => item.value), values);
            return composed([{ text: 'Antes de Go usabas Rust.', role: 'previous', factIndexes: [0] }]);
        });
        const conversationId = instance.createConversation();
        const answer = await send(instance, conversationId, '¿Qué lenguaje usaba antes de Go?', 'history-language');
        assert.equal(answer, 'Antes de Go usabas Rust.');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 1);
        await instance.close();
    });
});

test('colloquial correction prepares one exact update and changes the current value only after confirmation', async () => {
    await withStore(async ({ storePath }) => {
        const correction = 'Che, me equivoqué, no era Cursor, era Windsurf.';
        const instance = createRuntime(storePath, async request => {
            assert.match(request.instructions, /corrige|corregir/u);
            return interpreted({ intent: 'correct_editor_preference', sourceQuote: correction,
                oldValue: 'Cursor', newValue: 'Windsurf' });
        });
        const conversationId = instance.createConversation();
        await seed(instance, conversationId, 'Cursor', 'correction-cursor');
        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const proposal = await send(instance, conversationId, correction, 'correction-proposal');
        assert.match(proposal, /Cursor/u);
        assert.match(proposal, /Windsurf/u);
        assert.match(proposal, /¿Querés que actualice esa preferencia/u);
        assert.doesNotMatch(proposal, /Tengo registrado «Mi editor de prueba favorito/u);
        assert.match(proposal, /vence en dos minutos/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision,
            'a correction proposal must not write');

        assert.equal(await send(instance, conversationId, 'dale', 'correction-confirm'), 'Listo, actualicé tu preferencia.');
        const after = JSON.parse(await readFile(storePath, 'utf8'));
        validateMemoryStore(after);
        assert.equal(after.assertions.filter(item => item.status === 'active').length, 1);
        assert.match(after.assertions.find(item => item.status === 'active').object.value, /Windsurf/u);
        assert.equal(after.assertions.find(item => item.object.value.includes('Cursor')).status, 'superseded');
        await instance.close();
    });
});

test('logical forget requires confirmation, persists its inactive state, and disappears from ordinary context after restart', async () => {
    await withStore(async ({ storePath }) => {
        const request = 'Nexa, olvidate de mi editor favorito.';
        const calls = [];
        const ask = async input => {
            calls.push(input);
            return interpreted({ intent: 'forget_editor_preference', sourceQuote: request });
        };
        let instance = createRuntime(storePath, ask);
        const conversationId = instance.createConversation();
        await seed(instance, conversationId, 'Cursor', 'forget-cursor');
        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const proposal = await send(instance, conversationId, request, 'forget-proposal');
        assert.match(proposal, /¿Querés que deje de usar esa preferencia como vigente/u);
        assert.doesNotMatch(proposal, /Tengo registrada «Mi editor de prueba favorito/u);
        assert.match(proposal, /no voy a borrar físicamente/u);
        assert.match(proposal, /vence en dos minutos/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision);

        assert.equal(await send(instance, conversationId, 'sí', 'forget-confirm'),
            'Listo, dejé de usar ese recuerdo como preferencia vigente. El registro histórico se conserva; no eliminé físicamente los datos.');
        let store = JSON.parse(await readFile(storePath, 'utf8'));
        validateMemoryStore(store);
        assert.equal(store.assertions.length, 1, 'logical forget preserves the assertion');
        assert.equal(store.assertions[0].status, 'superseded');
        assert.ok(store.assertions[0].valid_to);
        assert.equal(store.automatic_operations.length, 0, 'logical forget does not forge an automatic-authorization receipt');
        await instance.close();

        instance = createRuntime(storePath, async input => {
            calls.push(input);
            const raw = input.input.find(item => item?.type === 'function_call_output' && item.call_id?.startsWith('memory_context_'))?.output;
            const payload = raw ? JSON.parse(raw) : null;
            const assertions = Array.isArray(payload?.assertions) ? payload.assertions : [];
            if (input.input.at(-1)?.content === '¿Qué editor prefiero?')
                assert.equal(assertions.some(item => /Cursor/u.test(item.object.value)), false);
            if (input.input.at(-1)?.content === '¿Qué editor usaba antes?') {
                const facts = historyPayload(input);
                assert.equal(facts.status, 'forgotten');
                assert.equal(facts.facts[0].state, 'forgotten');
                return composed([{ text: 'No hay una preferencia vigente; Cursor quedó en el historial como olvidado.',
                    role: 'forgotten', factIndexes: [0] }]);
            }
            return final('No tengo una preferencia vigente de editor.');
        });
        const restarted = instance.createConversation();
        const ordinaryAnswer = await send(instance, restarted, '¿Qué editor prefiero?', 'forget-after-restart');
        assert.match(ordinaryAnswer, /No tengo una preferencia vigente/u);
        const historyAnswer = await send(instance, restarted, '¿Qué editor usaba antes?', 'forgotten-history-query');
        assert.match(historyAnswer, /no hay una preferencia vigente/iu);
        assert.match(historyAnswer, /olvidad[oa]/u);
        assert.match(historyAnswer, /Cursor/u);
        store = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(store.revision, before.revision + 1, 'historical reads remain read-only after logical forget');
        await instance.close();
    });
});

test('Memory2 guidance separates remembered preference from live Windows state and preserves conversational context', async () => {
    await withStore(async ({ storePath }) => {
        const requests = [];
        const diagnosticEvents = [];
        let windowReads = 0;
        const instance = createRuntime(storePath, async request => {
            requests.push(request);
            const toolNames = request.tools.map(tool => tool.name);
            if (toolNames.includes('interpret_memory_intent')) {
                const text = request.input.at(-1)?.content;
                const value = text.includes('Cursor') ? 'Cursor' : 'VS Code';
                return interpreted({ intent: 'remember', sourceQuote: text.replace(/^Nexa, recordá que /u, '').replace(/\.$/u, '') });
            }
            const userText = request.input.filter(item => item?.role === 'user').at(-1)?.content;
            assert.match(request.instructions, /conocimiento persistente de Memory2 del estado observable actual/u);
            assert.match(request.instructions, /contexto conversacional reciente/u);
            assert.match(request.instructions, /pregunta cuál quiere saber/u);
            assert.match(request.instructions, /música preferida y la pista sonando/u);
            assert.match(request.instructions, /navegador habitual y el abierto/u);
            const memoryOutput = request.input.find(item => item?.type === 'function_call_output'
                && item.output?.includes('"assertions"'))?.output;
            assert.ok(toolNames.includes('get_active_window'));
            assert.match(request.tools.find(tool => tool.name === 'get_active_window').description,
                /estado observable actual/u);
            if (userText === '¿Qué editor prefiero?') {
                assert.match(memoryOutput ?? '', /Cursor/u, 'the remembered preference is supplied as Memory2 evidence');
                return final('Tu preferencia registrada es Cursor.');
            }
            if (userText === '¿Y cuál tengo abierto ahora?') {
                assert.ok(request.input.some(item => item?.role === 'user' && item.content === '¿Qué editor prefiero?'),
                    'the recent preference topic remains available to interpret the follow-up');
                if (request.input.some(item => item?.call_id === 'synthetic-get_active_window'))
                    return final('Tu preferencia registrada es Cursor; ahora mismo tenés VS Code abierto.');
                return toolCall('get_active_window', {});
            }
            if (userText === '¿Y ese es el que uso habitualmente?') {
                assert.match(memoryOutput ?? '', /Cursor/u, 'Memory2 still supplies the habitual preference');
                assert.ok(request.input.some(item => item?.call_id === 'synthetic-get_active_window'),
                    'the prior Windows observation remains available for the contextual comparison');
                return final('No. Ahora tenés VS Code abierto; tu editor habitual es Cursor.');
            }
            return final('Tu preferencia registrada es Cursor; ahora mismo está abierta otra aplicación.');
        }, { getTools: () => [getActiveWindowTool], logger: (event, details) => diagnosticEvents.push({ event, details }),
            execute: async name => {
            assert.equal(name, 'get_active_window');
            windowReads++;
            return { success: true, window: { title: 'VS Code', process: 'Code.exe' } };
        } });
        const conversationId = instance.createConversation();
        await send(instance, conversationId, 'Nexa, recordá que mi editor de prueba favorito es Cursor.', 'source-memory-seed');
        await send(instance, conversationId, 'sí', 'source-memory-seed-confirm');
        assert.match(await send(instance, conversationId, '¿Qué editor prefiero?', 'source-preference'), /Cursor/u);
        assert.match(await send(instance, conversationId, '¿Y cuál tengo abierto ahora?', 'source-current'), /VS Code/u);
        assert.match(await send(instance, conversationId, '¿Y ese es el que uso habitualmente?', 'source-compare'), /no.*VS Code.*habitual.*Cursor/iu);
        assert.equal(windowReads, 1, 'only the explicit live-state question should call Windows');
        assert.equal(requests.filter(request => request.input.at(-1)?.content === '¿Qué editor prefiero?').length, 1,
            'source selection uses the existing model turn and adds no classifier request');
        assert.ok(diagnosticEvents.some(item => item.event === 'information_source_context'
            && item.details.windowsStateToolsAvailable === true));
        assert.ok(diagnosticEvents.some(item => item.event === 'information_source_selected'
            && item.details.source === 'windows_live_state' && item.details.tool === 'get_active_window'));
        assert.ok(diagnosticEvents.some(item => item.event === 'memory_proposal_presented'
            && item.details.operation === 'remember' && item.details.presentation === 'natural_confirmation'));
        await instance.close();
    });
});

test('historical questions without verified facts use a safe fallback without calling the model or mutating the store', async () => {
    await withStore(async ({ storePath }) => {
        let modelCalls = 0;
        const instance = createRuntime(storePath, async request => {
            modelCalls++;
            return final();
        });
        const conversationId = instance.createConversation();
        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const answer = await send(instance, conversationId, '¿Qué editor usaba antes?', 'history-empty');
        assert.match(answer, /No encontré un historial verificable/u);
        assert.equal(await send(instance, conversationId, '¿Qué motivo tenía registrado para ese cambio?', 'history-empty-reason'),
            'No tengo registrado el motivo de ese cambio.');
        assert.equal(await send(instance, conversationId, '¿Por qué cambié mi editor habitual?', 'history-empty-editor-reason'),
            'No tengo registrado el motivo de ese cambio.');
        assert.equal(modelCalls, 0);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision);
        await instance.close();
    });
});

test('history generation rejects an unsupported or uncited claim and falls back without writing', async () => {
    await withStore(async ({ storePath }) => {
        let instance = createRuntime(storePath, async request => {
            assert.equal(historyPayload(request).status, 'verified');
            return composed([{ text: 'Tu editor actual es Emacs.', role: 'current', factIndexes: [999] }]);
        });
        const conversationId = instance.createConversation();
        await seed(instance, conversationId, 'Cursor', 'history-grounding-cursor');
        await send(instance, conversationId, 'Nexa, cambié de editor. Ahora prefiero VS Code', 'history-grounding-update');
        await send(instance, conversationId, 'sí', 'history-grounding-update-confirm');
        const before = JSON.parse(await readFile(storePath, 'utf8'));
        const answer = await send(instance, conversationId, '¿Qué editor usaba antes?', 'history-uncited-claim');
        assert.match(answer, /No pude redactar una respuesta fiable/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision);
        await instance.close();

        instance = createRuntime(storePath, async () => { throw new Error('synthetic provider failure'); });
        const restarted = instance.createConversation();
        const unavailableAnswer = await send(instance, restarted, '¿Qué editor usaba antes?', 'history-provider-error');
        assert.match(unavailableAnswer, /No pude redactar una respuesta fiable/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, before.revision);
        await instance.close();
    });
});

test('history diagnostics report delivery and generation state without retaining fact content', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-confirmed-write' });
    diagnostics.recordMemoryChange({ operation: 'history', result: 'read', historyFactsDelivered: true,
        historyResponse: 'generated', requestedDimension: 'previous', privateFact: 'must-not-be-retained' });
    const state = diagnostics.snapshot().lastMemoryChange;
    assert.equal(state.historyFactsDelivered, true);
    assert.equal(state.historyResponse, 'generated');
    assert.equal(state.requestedDimension, 'previous');
    assert.equal(JSON.stringify(state).includes('must-not-be-retained'), false);
    const report = JSON.parse(createTechnicalDiagnosticReport({ memory: {}, lastMemoryChange: state }, 'memory'));
    assert.equal(report.lastMemoryChange.historyFactsDelivered, true);
    assert.equal(report.lastMemoryChange.historyResponse, 'generated');
    assert.equal(report.lastMemoryChange.requestedDimension, 'previous');
    diagnostics.recordMemoryChange({ operation: 'history', result: 'read', historyFactsDelivered: null,
        historyResponse: 'error' });
    assert.equal(diagnostics.snapshot().lastMemoryChange.historyFactsDelivered, null);
    assert.equal(diagnostics.snapshot().lastMemoryChange.historyResponse, 'error');
});

test('cancelled forget and permanent deletion requests do not change or physically delete records', async () => {
    await withStore(async ({ storePath }) => {
        const forgetRequest = 'Nexa, olvidate de mi editor favorito.';
        const permanentRequest = 'Nexa, elimina definitivamente mi preferencia de editor.';
        const instance = createRuntime(storePath, async input => {
            const current = input.input.at(-1)?.content;
            if (current === forgetRequest) return interpreted({ intent: 'forget_editor_preference', sourceQuote: forgetRequest });
            if (current === permanentRequest) return interpreted({ intent: 'permanent_delete_request', sourceQuote: permanentRequest });
            return final();
        });
        const conversationId = instance.createConversation();
        await seed(instance, conversationId, 'Cursor', 'forget-cancel-cursor');
        const revision = JSON.parse(await readFile(storePath, 'utf8')).revision;
        await send(instance, conversationId, forgetRequest, 'forget-cancel-proposal');
        assert.match(await send(instance, conversationId, 'no', 'forget-cancel'), /no olvidé/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, revision);

        const response = await send(instance, conversationId, permanentRequest, 'permanent-delete-request');
        assert.match(response, /No puedo prometer su eliminación física/u);
        const unchanged = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(unchanged.revision, revision);
        assert.equal(unchanged.assertions.length, 1);
        assert.equal(unchanged.assertions[0].status, 'active');
        await instance.close();
    });
});
