import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { askOpenAI } from '../src/brain/openai.js';
import { createAgent } from '../src/core/agent.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { createConversationStore } from '../src/core/conversation-store.js';
import { selectConversationContext } from '../src/core/conversation-context.js';

const UUID = '00000000-0000-4000-8000-000000000501';

function final(text) {
    return { status: 'completed', output_text: text, output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }] };
}

function toolCall(name, args, callId = 'synthetic-call-1') {
    return { status: 'completed', output_text: '', output: [{ type: 'function_call', name,
        arguments: JSON.stringify(args), call_id: callId }] };
}

function responseRecorder(responses = []) {
    const requests = [];
    const client = { responses: { async create(request, options) {
        requests.push(structuredClone(request));
        const next = responses.shift();
        if (typeof next === 'function') return next(request, options);
        if (next instanceof Error) throw next;
        return next ?? final('Respuesta sintética.');
    } } };
    return { client, requests };
}

function measuredInput(input) {
    return {
        items: input.length,
        conversationalMessages: input.filter(item => ['user', 'assistant'].includes(item?.role)).length,
        toolResults: input.filter(item => item?.type === 'function_call_output').length,
        serializedCharacters: JSON.stringify(input).length,
    };
}

function runtimeWithResponses(recorder, options = {}) {
    return createConversationRuntime({ memoryMode: 'memory1', ...options,
        agentOptions: { load: async () => ({ user: {}, preferences: {}, facts: [] }),
            save: async () => {}, getTools: () => [], logger: () => {},
            ask: request => askOpenAI({ ...request, client: recorder.client }),
            ...options.agentOptions } });
}

async function send(runtime, conversationId, sequence, text, source = 'typed') {
    return runtime.sendMessage({ conversationId, requestId: `continuity-${sequence}`, text, source });
}

test('CURRENT: immediate references, corrections, topic changes, and text/PTT share one active context', async t => {
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder);
    const conversationId = runtime.createConversation();
    t.after(() => runtime.close());

    await send(runtime, conversationId, 1, 'Estoy pensando en borrar las copias de seguridad.');
    await send(runtime, conversationId, 2, '¿Y por qué sería mala idea?', 'voice');
    await send(runtime, conversationId, 3, 'No, me refería al segundo argumento.');
    await send(runtime, conversationId, 4, 'Cambiemos de tema: contame sobre jazz.');
    await send(runtime, conversationId, 5, 'Volvamos a lo de las copias.', 'voice');

    const input = recorder.requests.at(-1).input;
    const text = JSON.stringify(input);
    for (const marker of ['Estoy pensando en borrar las copias de seguridad.', '¿Y por qué sería mala idea?',
        'No, me refería al segundo argumento.', 'Cambiemos de tema: contame sobre jazz.', 'Volvamos a lo de las copias.']) {
        assert.ok(text.includes(marker), `active input lost a recent user turn: ${marker}`);
    }
    assert.equal(recorder.requests.length, 5);
    assert.deepEqual(measuredInput(input), {
        items: 9, conversationalMessages: 9, toolResults: 0, serializedCharacters: JSON.stringify(input).length,
    });
});

test('CONV-05C: active and restored sessions select the same recent visible message window', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-continuity-eval-'));
    t.after(async () => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await rm(directory, { recursive: true, force: true });
    });
    const storeOptions = { baseDirectory: path.join(directory, 'synthetic-conversations') };
    const store = createConversationStore(storeOptions);
    await store.createConversation(UUID);
    const activeRecorder = responseRecorder();
    const activeRuntime = runtimeWithResponses(activeRecorder);
    assert.equal(activeRuntime.restoreConversation(UUID, []), true);

    for (let turn = 1; turn <= 10; turn++) {
        const userText = `Synthetic turn ${turn}: decision marker ${turn}.`;
        const result = await send(activeRuntime, UUID, `long-${turn}`, userText);
        assert.equal(result.status, 'completed');
        await store.appendMessage(UUID, { role: 'user', content: userText });
        await store.appendMessage(UUID, { role: 'assistant', content: result.text });
    }
    const activeResult = await send(activeRuntime, UUID, 'long-active-followup', 'Return to decision marker 1.');
    assert.equal(activeResult.status, 'completed');
    const activeInput = activeRecorder.requests.at(-1).input;
    const activeMetrics = measuredInput(activeInput);
    const activeCurrentIndex = activeInput.findLastIndex(item => item?.role === 'user');
    const activeHistoryMetrics = measuredInput(activeInput.slice(0, activeCurrentIndex));
    assert.equal(JSON.stringify(activeInput).includes('Synthetic turn 1: decision marker 1.'), false);
    await activeRuntime.close();

    const reopenedStore = createConversationStore(storeOptions);
    const restoredPage = await reopenedStore.listMessages(UUID, { limit: 100 });
    assert.equal(restoredPage.messages.length, 20);
    const restoredRecorder = responseRecorder();
    const restoredRuntime = runtimeWithResponses(restoredRecorder);
    assert.equal(restoredRuntime.restoreConversation(UUID, restoredPage.messages), true);
    const restoredResult = await send(restoredRuntime, UUID, 'long-restored-followup', 'Return to decision marker 1.');
    assert.equal(restoredResult.status, 'completed');
    const restoredInput = restoredRecorder.requests.at(-1).input;
    const restoredMetrics = measuredInput(restoredInput);
    const restoredCurrentIndex = restoredInput.findLastIndex(item => item?.role === 'user');
    const restoredHistoryMetrics = measuredInput(restoredInput.slice(0, restoredCurrentIndex));
    assert.equal(JSON.stringify(restoredInput).includes('Synthetic turn 1: decision marker 1.'), false);
    assert.ok(JSON.stringify(restoredInput).includes('Synthetic turn 5: decision marker 5.'));
    assert.equal(activeMetrics.conversationalMessages, 13);
    assert.equal(restoredMetrics.conversationalMessages, 13);
    const visibleMessages = input => input.filter(item => ['user', 'assistant'].includes(item?.role))
        .map(item => [item.role, typeof item.content === 'string' ? item.content
            : (item.content ?? []).filter(part => part?.type === 'output_text').map(part => part.text).join('')]);
    assert.deepEqual(visibleMessages(activeInput), visibleMessages(restoredInput));
    assert.ok(activeHistoryMetrics.conversationalMessages <= 12);
    assert.ok(activeHistoryMetrics.serializedCharacters <= 12_000);
    assert.ok(restoredHistoryMetrics.conversationalMessages <= 12);
    assert.ok(restoredHistoryMetrics.serializedCharacters <= 12_000);
    t.diagnostic(`synthetic long-history metrics: active=${JSON.stringify(activeMetrics)} history=${JSON.stringify(activeHistoryMetrics)} restored=${JSON.stringify(restoredMetrics)} history=${JSON.stringify(restoredHistoryMetrics)}; visible history is equivalent`);
    await restoredRuntime.close();
});

test('CONV-05C compatibility: active context keeps tool protocol; old visible-only restore remains supported', async t => {
    const recorder = responseRecorder([
        toolCall('synthetic_lookup', { key: 'fixture' }),
        final('Encontré el evento sintético para mañana.'),
        final('El resultado anterior era el evento sintético para mañana.'),
    ]);
    const runtime = runtimeWithResponses(recorder, { agentOptions: {
        getTools: () => [{ type: 'function', name: 'synthetic_lookup', parameters: { type: 'object' } }],
        execute: async () => ({ success: true, result: 'synthetic-event-tomorrow' }),
    } });
    const conversationId = runtime.createConversation();
    t.after(() => runtime.close());
    const first = await send(runtime, conversationId, 'tool-1', 'Buscá el evento sintético.');
    assert.equal(first.status, 'completed');
    await send(runtime, conversationId, 'tool-2', '¿Qué encontraste?');

    const laterTurn = recorder.requests[2].input;
    const activeToolMetrics = measuredInput(laterTurn);
    assert.ok(laterTurn.some(item => item?.type === 'function_call_output'
        && item.output.includes('synthetic-event-tomorrow')));
    assert.ok(laterTurn.some(item => item?.role === 'assistant'
        && JSON.stringify(item).includes('Encontré el evento sintético para mañana.')));

    const visibleOnly = [{ role: 'user', content: 'Buscá el evento sintético.' },
        { role: 'assistant', content: first.text }];
    const restoredRecorder = responseRecorder();
    const restoredRuntime = runtimeWithResponses(restoredRecorder);
    assert.equal(restoredRuntime.restoreConversation(conversationId, visibleOnly), true);
    await send(restoredRuntime, conversationId, 'tool-restored', '¿Qué encontraste?');
    const restoredInput = restoredRecorder.requests[0].input;
    const restoredToolMetrics = measuredInput(restoredInput);
    assert.equal(restoredInput.some(item => item?.type === 'function_call_output'), false);
    assert.ok(JSON.stringify(restoredInput).includes('Encontré el evento sintético para mañana.'));
    assert.equal(activeToolMetrics.toolResults, 1);
    assert.equal(restoredToolMetrics.toolResults, 0);
    t.diagnostic(`synthetic tool-context metrics: active=${JSON.stringify(activeToolMetrics)} restored=${JSON.stringify(restoredToolMetrics)}`);
    await restoredRuntime.close();
});

test('CONV-05D: provider error rolls back its partial turn and preserves prior completed context', async t => {
    const errorRecorder = responseRecorder([final('Synthetic pre-error context.'), new Error('synthetic provider failure'), final('Sigo.')]);
    const errorRuntime = runtimeWithResponses(errorRecorder);
    const errorConversation = errorRuntime.createConversation();
    await send(errorRuntime, errorConversation, 'error-pre', 'Synthetic successful context before error.');
    const failed = await send(errorRuntime, errorConversation, 'error-1', 'Synthetic failed user turn.');
    assert.equal(failed.status, 'error');
    await send(errorRuntime, errorConversation, 'error-2', 'Synthetic retry after error.');
    const afterErrorMetrics = measuredInput(errorRecorder.requests[2].input);
    const retryInput = JSON.stringify(errorRecorder.requests[2].input);
    assert.ok(retryInput.includes('Synthetic retry after error.'));
    assert.equal(retryInput.includes('Synthetic failed user turn.'), false);
    assert.ok(retryInput.includes('Synthetic successful context before error.'));
    assert.equal(afterErrorMetrics.conversationalMessages, 3);
    await errorRuntime.close();

    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const cancelRecorder = responseRecorder([
        async (_request, options) => new Promise((_resolve, reject) => {
            entered();
            options.signal.addEventListener('abort', () => {
                const error = new Error('synthetic abort'); error.name = 'AbortError'; reject(error);
            }, { once: true });
        }),
        final('La siguiente solicitud continúa.'),
    ]);
    const cancelRuntime = runtimeWithResponses(cancelRecorder);
    const cancelConversation = cancelRuntime.createConversation();
    const pending = send(cancelRuntime, cancelConversation, 'cancel-1', 'Synthetic cancelled user turn.');
    await started;
    assert.equal(cancelRuntime.cancelRequest('continuity-cancel-1', 'test'), true);
    assert.equal((await pending).status, 'cancelled');
    await send(cancelRuntime, cancelConversation, 'cancel-2', 'Synthetic post-cancel turn.');
    const postCancelInput = JSON.stringify(cancelRecorder.requests[1].input);
    assert.equal(postCancelInput.includes('Synthetic cancelled user turn.'), false);
    assert.ok(postCancelInput.includes('Synthetic post-cancel turn.'));
    const afterCancelMetrics = measuredInput(cancelRecorder.requests[1].input);
    t.diagnostic(`synthetic failure/cancellation metrics: afterError=${JSON.stringify(afterErrorMetrics)} afterCancel=${JSON.stringify(afterCancelMetrics)}; completed context survives provider errors, while partial failed/cancelled turns are excluded`);
    await cancelRuntime.close();
});

test('CONV-05D: restoration ignores an incomplete persisted user turn but keeps earlier completed exchanges', async t => {
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder);
    t.after(() => runtime.close());
    assert.equal(runtime.restoreConversation(UUID, [
        { role: 'user', content: 'Synthetic completed antecedent.' },
        { role: 'assistant', content: 'Synthetic completed answer.' },
        { role: 'user', content: 'Synthetic persisted turn without final answer.' },
    ]), true);
    await send(runtime, UUID, 'restore-after-incomplete', 'Synthetic post-restart follow-up.');
    const input = JSON.stringify(recorder.requests[0].input);
    assert.ok(input.includes('Synthetic completed antecedent.'));
    assert.ok(input.includes('Synthetic completed answer.'));
    assert.equal(input.includes('Synthetic persisted turn without final answer.'), false);
    assert.ok(input.includes('Synthetic post-restart follow-up.'));
});

test('CONV-05D: error after a successful tool preserves the actual call/result and does not re-execute it', async t => {
    let sideEffects = 0;
    const recorder = responseRecorder([
        toolCall('synthetic_action', { action: 'apply' }, 'action-call-1'),
        new Error('synthetic failure after tool'),
        final('Continúo con el resultado previo.'),
    ]);
    const runtime = runtimeWithResponses(recorder, { agentOptions: {
        getTools: () => [{ type: 'function', name: 'synthetic_action', parameters: { type: 'object' } }],
        execute: async () => { sideEffects++; return { success: true, result: 'synthetic-action-completed' }; },
    } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    const failed = await send(runtime, id, 'action-fail-after', 'Ejecuta la acción sintética.');
    assert.equal(failed.status, 'error');
    await send(runtime, id, 'action-followup', '¿Qué pasó con la acción?');
    assert.equal(sideEffects, 1);
    const input = recorder.requests.at(-1).input;
    assert.ok(input.some(item => item?.type === 'function_call' && item.call_id === 'action-call-1'));
    assert.ok(input.some(item => item?.type === 'function_call_output' && item.call_id === 'action-call-1'
        && item.output.includes('synthetic-action-completed')));
    assert.ok(JSON.stringify(input).includes('Ejecuta la acción sintética.'));
    assert.ok(JSON.stringify(input).includes('¿Qué pasó con la acción?'));
});

test('CONV-05E1: a confirmed desktop action survives provider failure and restart without replay', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-tool-outcome-restart-'));
    t.after(async () => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await rm(directory, { recursive: true, force: true });
    });
    const storeOptions = { baseDirectory: path.join(directory, 'conversations') };
    const store = createConversationStore(storeOptions);
    const id = UUID;
    await store.createConversation(id);
    const firstUser = await store.appendMessage(id, { role: 'user', content: 'Abrí la aplicación sintética.' });
    let sideEffects = 0;
    const persistToolOutcome = async ({ conversationId, turnId, ...outcome }) => {
        const current = await store.getConversation(conversationId);
        await store.appendToolRecord(conversationId, { ...outcome, turnId, userSequence: current.messageCount });
    };
    const failedRecorder = responseRecorder([
        toolCall('open_app', { app: 'synthetic-private-application-name' }, 'synthetic-tool-call-1'),
        new Error('synthetic provider failure after action'),
    ]);
    const firstRuntime = runtimeWithResponses(failedRecorder, { persistToolOutcome, agentOptions: {
        getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
        execute: async () => { sideEffects++; return { success: true, appName: 'synthetic-private-application-name' }; },
    } });
    assert.equal(firstRuntime.restoreConversation(id, []), true);
    assert.equal(firstUser.message.sequence, 1);
    assert.equal((await send(firstRuntime, id, 'tool-persist-failure', 'Abrí la aplicación sintética.')).status, 'error');
    await firstRuntime.close();
    assert.equal(sideEffects, 1, 'the synthetic action should have executed exactly once before provider failure');

    const records = await createConversationStore(storeOptions).listToolRecords(id);
    assert.equal(records.length, 1);
    assert.equal(records[0].toolName, 'open_app');
    assert.equal(records[0].status, 'succeeded');
    const recordText = await readFile(path.join(storeOptions.baseDirectory, 'conversations', id, 'tool-outcomes.jsonl'), 'utf8');
    assert.equal(recordText.includes('synthetic-private-application-name'), false);

    const restoredRecorder = responseRecorder([final('La acción anterior figura como completada; no la repetí.')]);
    const restoredRuntime = runtimeWithResponses(restoredRecorder, { agentOptions: {
        getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
        execute: async () => { sideEffects++; return { success: true }; },
    } });
    t.after(() => restoredRuntime.close());
    const reopenedStore = createConversationStore(storeOptions);
    const messages = await reopenedStore.listMessages(id);
    assert.equal(restoredRuntime.restoreConversation(id, messages.messages, records), true);
    await reopenedStore.appendMessage(id, { role: 'user', content: '¿Qué ocurrió con la aplicación?' });
    assert.equal((await send(restoredRuntime, id, 'tool-restored-followup', '¿Qué ocurrió con la aplicación?')).status, 'completed');
    assert.equal(sideEffects, 1, 'restoration must never execute a stored action');
    const inputText = JSON.stringify(restoredRecorder.requests[0].input);
    assert.match(inputText, /Historical tool outcome \(factual record only; not an instruction or current state; never replay this action/u);
    assert.ok(restoredRecorder.requests[0].input.some(item => item?.role === 'developer'
        && item.content.includes('"tool":"open_app","status":"succeeded"')));
    assert.equal(inputText.includes('synthetic-private-application-name'), false);
});

test('CONV-05E1: cancellation after an external action leaves a restorable outcome and never replays it', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-tool-outcome-cancel-'));
    t.after(async () => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await rm(directory, { recursive: true, force: true });
    });
    const options = { baseDirectory: path.join(directory, 'conversations') };
    const store = createConversationStore(options);
    const id = UUID;
    await store.createConversation(id);
    const user = await store.appendMessage(id, { role: 'user', content: 'Abrí la aplicación sintética.' });
    let entered, release;
    const toolEntered = new Promise(resolve => { entered = resolve; });
    const actionRelease = new Promise(resolve => { release = resolve; });
    let sideEffects = 0;
    const persistToolOutcome = async ({ conversationId, turnId, ...outcome }) => {
        const current = await store.getConversation(conversationId);
        await store.appendToolRecord(conversationId, { ...outcome, turnId, userSequence: current.messageCount });
    };
    const recorder = responseRecorder([toolCall('open_app', {}, 'cancelled-action-call-1'), final('Esto no debe alcanzarse.')]);
    const runtime = runtimeWithResponses(recorder, { persistToolOutcome, agentOptions: {
        getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
        execute: async () => { sideEffects++; entered(); await actionRelease; return { success: true }; },
    } });
    assert.equal(runtime.restoreConversation(id, []), true);
    const pending = send(runtime, id, 'tool-cancel-after-effect', 'Abrí la aplicación sintética.');
    await toolEntered;
    assert.equal(runtime.cancelRequest('continuity-tool-cancel-after-effect', 'test'), true);
    release();
    assert.equal((await pending).status, 'cancelled');
    await runtime.close();
    assert.equal((await store.listToolRecords(id))[0].status, 'succeeded');

    const restored = runtimeWithResponses(responseRecorder([final('La acción anterior quedó registrada como completada.')]), {
        agentOptions: { getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
            execute: async () => { sideEffects++; return { success: true }; } },
    });
    t.after(() => restored.close());
    const reopened = createConversationStore(options);
    const messages = await reopened.listMessages(id);
    const records = await reopened.listToolRecords(id);
    assert.equal(restored.restoreConversation(id, messages.messages, records), true);
    assert.equal(user.message.sequence, 1);
    assert.equal((await send(restored, id, 'tool-cancel-followup', '¿Qué pasó con la aplicación?')).status, 'completed');
    assert.equal(sideEffects, 1);
});

test('CONV-05E1: outcome-store failure does not trigger another execution of the external tool', async t => {
    let sideEffects = 0;
    const recorder = responseRecorder([toolCall('open_app', {}, 'persistence-failure-call-1'), final('La acción se ejecutó una sola vez.')]);
    const runtime = runtimeWithResponses(recorder, { persistToolOutcome: async () => { throw new Error('synthetic store failure'); },
        agentOptions: { getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
            execute: async () => { sideEffects++; return { success: true }; } } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    assert.equal((await send(runtime, id, 'tool-store-failure', 'Abrí la aplicación sintética.')).status, 'completed');
    assert.equal(sideEffects, 1);
    assert.equal(recorder.requests.length, 2);
});

test('CONV-05E1: an executed but failed tool is persisted as failed and restored without execution', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-tool-failed-restart-'));
    t.after(async () => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await rm(directory, { recursive: true, force: true });
    });
    const options = { baseDirectory: path.join(directory, 'conversations') };
    const store = createConversationStore(options);
    const id = UUID;
    await store.createConversation(id);
    const user = await store.appendMessage(id, { role: 'user', content: 'Intentá abrir la aplicación sintética.' });
    let attempts = 0;
    const persistToolOutcome = async ({ conversationId, turnId, ...outcome }) => {
        const current = await store.getConversation(conversationId);
        await store.appendToolRecord(conversationId, { ...outcome, turnId, userSequence: current.messageCount });
    };
    const runtime = runtimeWithResponses(responseRecorder([
        toolCall('open_app', {}, 'failed-open-call-1'), final('La operación no tuvo éxito.'),
    ]), { persistToolOutcome, agentOptions: {
        getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
        execute: async () => { attempts++; throw new Error('synthetic private failure detail'); },
    } });
    assert.equal(runtime.restoreConversation(id, []), true);
    assert.equal((await send(runtime, id, 'tool-failed-turn', 'Intentá abrir la aplicación sintética.')).status, 'completed');
    await runtime.close();
    const records = await store.listToolRecords(id);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'failed');

    const reopened = createConversationStore(options);
    const messages = await reopened.listMessages(id);
    const restoredRecorder = responseRecorder([final('La operación previa figura como fallida.')]);
    const restored = runtimeWithResponses(restoredRecorder, {
        agentOptions: { getTools: () => [{ type: 'function', name: 'open_app', parameters: { type: 'object' } }],
            execute: async () => { attempts++; return { success: true }; } },
    });
    t.after(() => restored.close());
    assert.equal(restored.restoreConversation(id, messages.messages, records), true);
    assert.equal((await send(restored, id, 'tool-failed-followup', '¿Cuál fue el resultado?')).status, 'completed');
    assert.equal(attempts, 1);
    assert.ok(restoredRecorder.requests[0].input.some(item => item?.role === 'developer'
        && item.content.includes('"tool":"open_app","status":"failed"')));
});

test('CONV-05D: failed tool outcome remains explicitly failed and is never promoted to success', async t => {
    const recorder = responseRecorder([
        toolCall('synthetic_failure', {}, 'failed-call-1'),
        final('La operación sintética falló.'),
        final('El resultado continúa marcado como fallido.'),
    ]);
    const runtime = runtimeWithResponses(recorder, { agentOptions: {
        getTools: () => [{ type: 'function', name: 'synthetic_failure', parameters: { type: 'object' } }],
        execute: async () => { throw new Error('synthetic tool failure'); },
    } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    assert.equal((await send(runtime, id, 'tool-failure', 'Ejecuta la operación sintética.')).status, 'completed');
    await send(runtime, id, 'tool-failure-followup', '¿Cuál fue el resultado?');
    const input = recorder.requests.at(-1).input;
    const failedOutput = input.find(item => item?.type === 'function_call_output' && item.call_id === 'failed-call-1');
    assert.ok(failedOutput);
    assert.equal(JSON.parse(failedOutput.output).success, false);
    assert.equal(failedOutput.output.includes('"success":true'), false);
});

test('CONV-05D: streaming cancellation resets the partial draft and the next turn keeps completed context only', async t => {
    const requests = [];
    let requestCount = 0;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const runtime = createConversationRuntime({ memoryMode: 'memory1', streamResponses: true,
        agentOptions: { load: async () => ({ user: {}, preferences: {}, facts: [] }), save: async () => {},
            getTools: () => [], logger: () => {}, ask: async request => {
                requests.push(structuredClone(request.input));
                requestCount++;
                if (requestCount === 1) return final('Contexto previo válido.');
                if (requestCount === 2) {
                    request.onTextDelta('Synthetic partial draft.');
                    markStarted();
                    return new Promise(resolve => request.signal.addEventListener('abort', () => resolve(final('Tarde.')), { once: true }));
                }
                return final('Respuesta posterior.');
            } } });
    const id = runtime.createConversation();
    const events = [];
    runtime.onEvent(event => events.push(event));
    t.after(() => runtime.close());
    await send(runtime, id, 'stream-before', 'Antecedente completado antes del stream.');
    const pending = send(runtime, id, 'stream-cancel', 'Solicitud sintética cancelada.');
    await started;
    assert.equal(runtime.cancelRequest('continuity-stream-cancel', 'test'), true);
    assert.equal((await pending).status, 'cancelled');
    assert.ok(events.some(event => event.requestId === 'continuity-stream-cancel' && event.status === 'text_reset'));
    await send(runtime, id, 'stream-after', 'Siguiente solicitud válida.');
    const recovered = JSON.stringify(requests.at(-1));
    assert.ok(recovered.includes('Antecedente completado antes del stream.'));
    assert.equal(recovered.includes('Solicitud sintética cancelada.'), false);
    assert.equal(recovered.includes('Synthetic partial draft.'), false);
});

test('CONV-05D: cancellation during a tool retains a confirmed successful effect without replaying it', async t => {
    let finishTool;
    let toolStarted;
    const entered = new Promise(resolve => { toolStarted = resolve; });
    let sideEffects = 0;
    const recorder = responseRecorder([toolCall('synthetic_action', {}, 'cancel-action-1'), final('Continuación.')]);
    const runtime = runtimeWithResponses(recorder, { agentOptions: {
        getTools: () => [{ type: 'function', name: 'synthetic_action', parameters: { type: 'object' } }],
        execute: () => new Promise(resolve => {
            finishTool = () => { sideEffects++; resolve({ success: true, result: 'synthetic-effect-completed' }); };
            toolStarted();
        }),
    } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    const pending = send(runtime, id, 'cancel-tool-turn', 'Ejecuta la acción y detente.');
    await entered;
    assert.equal(runtime.cancelRequest('continuity-cancel-tool-turn', 'test'), true);
    finishTool();
    assert.equal((await pending).status, 'cancelled');
    await send(runtime, id, 'cancel-tool-next', 'Confirma el estado de la acción anterior.');
    assert.equal(sideEffects, 1);
    const input = recorder.requests.at(-1).input;
    assert.ok(input.some(item => item?.type === 'function_call_output' && item.call_id === 'cancel-action-1'
        && item.output.includes('synthetic-effect-completed')));
    assert.deepEqual(input.filter(item => item?.type === 'function_call').map(item => item.call_id), ['cancel-action-1']);
});

test('CURRENT: a changed Memory2 digest clears prior derived conversation context', async t => {
    let digest = 'digest-a';
    const reader = { async readContext() { return { revision: digest === 'digest-a' ? 1 : 2, digest, items: [] }; },
        async close() {} };
    const recorder = responseRecorder();
    const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', agentFactory: ({ agentOptions, initialConversationHistory }) =>
        createAgent({ ...agentOptions, initialConversationHistory, memory2ReadOnlyReader: reader,
            memoryRetrievalEnabled: true, getTools: () => [],
            ask: request => askOpenAI({ ...request, client: recorder.client }), logger: () => {} }) });
    const conversationId = runtime.createConversation();
    t.after(() => runtime.close());
    await send(runtime, conversationId, 'digest-1', 'Synthetic antecedent before memory change.');
    digest = 'digest-b';
    await send(runtime, conversationId, 'digest-2', 'Synthetic followup after memory change.');
    const changedInput = recorder.requests[1].input;
    const beforeDigestChange = measuredInput(recorder.requests[0].input);
    const afterDigestChange = measuredInput(changedInput);
    assert.equal(JSON.stringify(changedInput).includes('Synthetic antecedent before memory change.'), false);
    assert.ok(JSON.stringify(changedInput).includes('Synthetic followup after memory change.'));
    t.diagnostic(`synthetic Memory2 digest metrics: before=${JSON.stringify(beforeDigestChange)} after=${JSON.stringify(afterDigestChange)}`);
});

test('CURRENT: conversation IDs keep active histories isolated', async t => {
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder);
    const first = runtime.createConversation();
    const second = runtime.createConversation();
    t.after(() => runtime.close());
    await send(runtime, first, 'isolation-1', 'Synthetic private topic A.');
    await send(runtime, second, 'isolation-2', 'Synthetic private topic B.');
    const input = JSON.stringify(recorder.requests[1].input);
    assert.ok(input.includes('Synthetic private topic B.'));
    assert.equal(input.includes('Synthetic private topic A.'), false);
});

test('CONV-05C: active rolling context retains complete recent exchanges in chronological order', async t => {
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder, { conversationContextPolicy: { maxMessages: 4, maxCharacters: 2_000 } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    for (let index = 1; index <= 4; index++) await send(runtime, id, `budget-${index}`, `Synthetic turn ${index}.`);
    const input = recorder.requests.at(-1).input;
    const visible = input.filter(item => ['user', 'assistant'].includes(item?.role));
    assert.deepEqual(visible.map(item => item.role), ['user', 'assistant', 'user', 'assistant', 'user']);
    assert.equal(JSON.stringify(input).includes('Synthetic turn 1.'), false);
    assert.ok(JSON.stringify(input).includes('Synthetic turn 2.'));
    assert.ok(JSON.stringify(input).includes('Synthetic turn 3.'));
    assert.ok(JSON.stringify(input).includes('Synthetic turn 4.'));
    assert.ok(visible.at(-1).content.includes('Synthetic turn 4.'));
});

test('CONV-05C: context character budget drops an oversized prior exchange but always retains the current message', async t => {
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder, { conversationContextPolicy: { maxMessages: 12, maxCharacters: 250 } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    await send(runtime, id, 'oversize-old', `Synthetic antecedent ${'x'.repeat(500)}.`);
    const current = 'Synthetic current follow-up.';
    await send(runtime, id, 'oversize-current', current);
    const input = recorder.requests.at(-1).input;
    assert.equal(JSON.stringify(input).includes('Synthetic antecedent'), false);
    assert.ok(JSON.stringify(input).includes(current));
    assert.deepEqual(input.filter(item => ['user', 'assistant'].includes(item?.role)).map(item => item.role), ['user']);
});

test('CONV-05C: restored exceptional-length messages obey the shared character budget', async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-continuity-long-'));
    t.after(async () => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await rm(directory, { recursive: true, force: true });
    });
    const store = createConversationStore({ baseDirectory: path.join(directory, 'synthetic-long-conversations') });
    await store.createConversation(UUID);
    const longOld = `Synthetic old ${'z'.repeat(900)}`;
    await store.appendMessage(UUID, { role: 'user', content: longOld });
    await store.appendMessage(UUID, { role: 'assistant', content: 'Old response.' });
    await store.appendMessage(UUID, { role: 'user', content: 'Synthetic recent question.' });
    await store.appendMessage(UUID, { role: 'assistant', content: 'Recent response.' });
    const restoredMessages = (await createConversationStore({ baseDirectory: path.join(directory, 'synthetic-long-conversations') })
        .listMessages(UUID, { limit: 20 })).messages;
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder, { conversationContextPolicy: { maxMessages: 12, maxCharacters: 180 } });
    assert.equal(runtime.restoreConversation(UUID, restoredMessages), true);
    t.after(() => runtime.close());
    await send(runtime, UUID, 'restored-long', 'Synthetic current question.');
    const input = recorder.requests[0].input;
    assert.equal(JSON.stringify(input).includes(longOld), false);
    assert.ok(JSON.stringify(input).includes('Synthetic recent question.'));
    assert.ok(JSON.stringify(input).includes('Synthetic current question.'));
});

test('CONV-05C: historical tool protocol never contains orphan calls or outputs', async t => {
    const recorder = responseRecorder([
        toolCall('synthetic_lookup', { key: 'fixture' }),
        final('Resultado sintético guardado.'),
        final('Siguiente turno.'),
    ]);
    const runtime = runtimeWithResponses(recorder, { agentOptions: {
        getTools: () => [{ type: 'function', name: 'synthetic_lookup', parameters: { type: 'object' } }],
        execute: async () => ({ success: true, result: 'synthetic-result' }),
    } });
    const id = runtime.createConversation();
    t.after(() => runtime.close());
    await send(runtime, id, 'pair-1', 'Ejecuta la consulta sintética.');
    await send(runtime, id, 'pair-2', 'Continúa.');
    const input = recorder.requests.at(-1).input;
    const calls = new Set(input.filter(item => item?.type === 'function_call').map(item => item.call_id));
    const outputs = new Set(input.filter(item => item?.type === 'function_call_output').map(item => item.call_id));
    assert.deepEqual([...calls].sort(), [...outputs].sort());
    assert.equal(calls.size, 1);
});

test('CONV-05C: selector removes orphan function calls and outputs while retaining the current user message', () => {
    const selected = selectConversationContext([
        { role: 'user', content: 'Synthetic current request.' },
        { type: 'function_call', name: 'synthetic_lookup', call_id: 'unmatched-call', arguments: '{}' },
        { type: 'function_call_output', call_id: 'unmatched-output', output: 'synthetic result' },
        { role: 'assistant', content: 'Synthetic final answer.' },
    ], { maxMessages: 0, maxCharacters: 0 }, { currentTurnStartIndex: 0 });
    assert.deepEqual(selected.map(item => item.type ?? item.role), ['user', 'assistant']);
    assert.equal(selected[0].content, 'Synthetic current request.');
});

test('CONV-05C: text/voice modality, conversation isolation, and Memory2 digest behavior remain explicit', async t => {
    const sources = [];
    const recorder = responseRecorder();
    const runtime = runtimeWithResponses(recorder, { conversationContextPolicy: { maxMessages: 4, maxCharacters: 2_000 } });
    const first = runtime.createConversation();
    const second = runtime.createConversation();
    t.after(() => runtime.close());
    await send(runtime, first, 'modality-typed', 'Synthetic typed antecedent.', 'typed');
    await send(runtime, first, 'modality-voice', 'Synthetic voice follow-up.', 'voice');
    await send(runtime, second, 'modality-isolated', 'Synthetic separate conversation.', 'typed');
    sources.push(recorder.requests.map(request => request.input));
    assert.ok(JSON.stringify(sources[0][1]).includes('Synthetic typed antecedent.'));
    assert.ok(JSON.stringify(sources[0][1]).includes('Synthetic voice follow-up.'));
    assert.equal(JSON.stringify(sources[0][2]).includes('Synthetic typed antecedent.'), false);
});
