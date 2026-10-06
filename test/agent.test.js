import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';

function functionCall(name, args, callId = `${name}-call`) {
    return { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId };
}

function toolResponse(call) {
    return { output: [call], output_text: '' };
}

function finalResponse(text) {
    return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text };
}

async function makeAgent({ responses, maxToolIterations = 5, execute, logger = () => {} }) {
    const requests = [];
    const agent = await createAgent({
        ask: async request => {
            requests.push(request);
            const response = responses.shift();
            assert.ok(response, 'unexpected model request');
            return response;
        },
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        save: async () => {},
        getTools: () => [{ type: 'function', name: 'test_tool' }],
        execute,
        maxToolIterations,
        logger,
    });
    return { agent, requests };
}

test('agent completes open, find, set, then returns the model final answer', async () => {
    const calls = [];
    const { agent, requests } = await makeAgent({
        responses: [
            toolResponse(functionCall('open_app', { app: 'Notepad' })),
            toolResponse(functionCall('find_ui_element', { app: 'Notepad', name: 'Editor' })),
            toolResponse(functionCall('set_ui_value', { ref: 'ui_1', value: 'Hola Jor, soy Nexa.' })),
            finalResponse('Listo, escribí el texto en Notepad.'),
        ],
        execute: async (name, args) => {
            calls.push([name, args]);
            return { success: true, ...(name === 'set_ui_value' ? { action: 'set_value' } : {}) };
        },
    });
    assert.equal(await agent.run('Abrí Notepad y escribí: Hola Jor, soy Nexa.'), 'Listo, escribí el texto en Notepad.');
    assert.deepEqual(calls.map(([name]) => name), ['open_app', 'find_ui_element', 'set_ui_value']);
    assert.equal(requests.length, 4);
    const setOutput = requests[3].input.find(item => item.type === 'function_call_output' && item.call_id === 'set_ui_value-call');
    assert.equal(JSON.parse(setOutput.output).completed, true);
});

test('agent completes find then invoke without an unnecessary focus or verification call', async () => {
    const calls = [];
    const { agent, requests } = await makeAgent({
        responses: [
            toolResponse(functionCall('find_ui_element', { app: 'Calculator', name: '7', controlType: 'Button' })),
            toolResponse(functionCall('invoke_ui_element', { ref: 'ui_7' })),
            finalResponse('Apreté el botón 7.'),
        ],
        execute: async (name, args) => {
            calls.push(name);
            return { success: true, action: name === 'invoke_ui_element' ? 'invoke' : undefined };
        },
    });
    assert.equal(await agent.run('Buscá el botón 7 y apretalo.'), 'Apreté el botón 7.');
    assert.deepEqual(calls, ['find_ui_element', 'invoke_ui_element']);
    assert.equal(requests.length, 3);
    const invokeOutput = requests[2].input.find(item => item.type === 'function_call_output' && item.call_id === 'invoke_ui_element-call');
    assert.equal(JSON.parse(invokeOutput.output).completed, true);
});

test('agent blocks an identical call after it already succeeded and forces a response-only turn', async () => {
    let executions = 0;
    const logs = [];
    const call = functionCall('set_ui_value', { ref: 'ui_1', value: 'private text' }, 'set-once');
    const { agent, requests } = await makeAgent({
        responses: [toolResponse(call), toolResponse({ ...call, call_id: 'set-repeat' }), finalResponse('Ya estaba escrito.')],
        execute: async () => { executions++; return { success: true }; },
        logger: (event, details) => logs.push({ event, details }),
    });
    assert.equal(await agent.run('Escribí ese texto.'), 'Ya estaba escrito.');
    assert.equal(executions, 1);
    assert.deepEqual(requests[2].tools, []);
    const repeatedOutput = requests[2].input.find(item => item.type === 'function_call_output' && item.call_id === 'set-repeat');
    assert.equal(JSON.parse(repeatedOutput.output).error.code, 'repeated_successful_tool_call');
    assert.ok(logs.some(log => log.event === 'tool_loop_prevented'));
    assert.equal(JSON.stringify(logs).includes('private text'), false);
});

test('agent allows an explicitly requested repetition up to the requested count', async () => {
    let executions = 0;
    const { agent } = await makeAgent({
        responses: [
            toolResponse(functionCall('invoke_ui_element', { ref: 'ui_7' }, 'invoke-first')),
            toolResponse(functionCall('invoke_ui_element', { ref: 'ui_7' }, 'invoke-second')),
            finalResponse('Apreté el 7 dos veces.'),
        ],
        execute: async () => { executions++; return { success: true }; },
    });
    assert.equal(await agent.run('Apretá el botón 7 dos veces.'), 'Apreté el 7 dos veces.');
    assert.equal(executions, 2);
});

test('last allowed tool round still gets one final model turn with tools disabled', async () => {
    const { agent, requests } = await makeAgent({
        maxToolIterations: 1,
        responses: [toolResponse(functionCall('invoke_ui_element', { ref: 'ui_7' })), finalResponse('Acción completada.')],
        execute: async () => ({ success: true }),
    });
    assert.equal(await agent.run('Apretá el botón.'), 'Acción completada.');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].tools, []);
});

test('agent debug summary reports tool rounds and safe argument metadata', async () => {
    const logs = [];
    const { agent } = await makeAgent({
        responses: [toolResponse(functionCall('set_ui_value', { ref: 'ui_1', value: 'secret phrase' })), finalResponse('Listo.')],
        execute: async () => ({ success: true }),
        logger: (event, details) => logs.push({ event, details }),
    });
    await agent.run('Escribí algo.');
    const serialized = JSON.stringify(logs);
    assert.match(serialized, /tool_call/);
    assert.match(serialized, /tool_result/);
    assert.match(serialized, /model_response/);
    assert.match(serialized, /"length":13/);
    assert.equal(serialized.includes('secret phrase'), false);
});

test('agent passes the exact current user message and a stable private session id to tools', async () => {
    const contexts = [];
    const { agent } = await makeAgent({
        responses: [toolResponse(functionCall('confirm_pending_action', { actionId: 'action_0123456789abcdef0123456789abcdef' })), finalResponse('No se ejecutó.')],
        execute: async (_name, _args, context) => { contexts.push(context); return { success: false }; },
    });
    await agent.run('confirmar envío action_0123456789abcdef0123456789abcdef');
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].userMessage, 'confirmar envío action_0123456789abcdef0123456789abcdef');
    assert.match(contexts[0].sessionId, /^[0-9a-f-]{36}$/u);
});
