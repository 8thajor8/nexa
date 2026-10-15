import assert from 'node:assert/strict';
import test from 'node:test';
import { askOpenAI } from '../src/brain/openai.js';

function syntheticResponse(text) {
    return { id: 'resp_synthetic', status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

test('askOpenAI streams only output_text deltas and returns the confirmed completed response', async () => {
    const response = syntheticResponse('Hola Nexa.');
    let requestBody;
    const client = { responses: { create: async body => {
        requestBody = body;
        return (async function* () {
            yield { type: 'response.output_text.delta', delta: 'Hola ' };
            yield { type: 'response.function_call_arguments.delta', delta: '{"private":true}' };
            yield { type: 'response.output_text.delta', delta: 'Nexa.' };
            yield { type: 'response.completed', response };
        })();
    } } };
    const deltas = [];
    const result = await askOpenAI({ instructions: 'test', input: [], client, onTextDelta: delta => deltas.push(delta) });
    assert.equal(requestBody.stream, true);
    assert.deepEqual(deltas, ['Hola ', 'Nexa.']);
    assert.equal(result, response);
});

test('askOpenAI preserves the original non-streaming Responses API path without a delta callback', async () => {
    const response = syntheticResponse('Respuesta completa.');
    let requestBody;
    const client = { responses: { create: async body => { requestBody = body; return response; } } };
    const result = await askOpenAI({ instructions: 'test', input: [], client });
    assert.equal(requestBody.stream, undefined);
    assert.equal(result, response);
});

test('askOpenAI rejects incomplete streams and honors cancellation between events', async () => {
    const incompleteClient = { responses: { create: async () => (async function* () {
        yield { type: 'response.output_text.delta', delta: 'parcial' };
    })() } };
    await assert.rejects(askOpenAI({ instructions: 'test', input: [], client: incompleteClient,
        onTextDelta: () => {} }), error => error.code === 'openai_stream_incomplete');

    const controller = new AbortController();
    const client = { responses: { create: async () => (async function* () {
        yield { type: 'response.output_text.delta', delta: 'parcial' };
        yield { type: 'response.output_text.delta', delta: 'tardío' };
    })() } };
    await assert.rejects(askOpenAI({ instructions: 'test', input: [], client, signal: controller.signal,
        onTextDelta: () => controller.abort() }), error => error.name === 'AbortError');
});
