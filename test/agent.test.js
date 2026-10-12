import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { executeTool } from '../src/tools/index.js';

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

test('agent reports a Spotify skip from the Runtime result without asking the model to invent a second status', async () => {
    const { agent, requests } = await makeAgent({
        responses: [toolResponse(functionCall('spotify_next', {}, 'spotify-next-once')), finalResponse('Spotify aceptó la orden.')],
        execute: async () => ({ success: true, action: 'next', accepted: true, outcome: 'accepted', confirmed: true }),
    });
    assert.equal(await agent.run('adelanta cancion'), 'Spotify aceptó la orden de avanzar. Estoy actualizando el estado de reproducción.');
    assert.equal(await agent.run('¿Qué pasó?'), 'Spotify aceptó la orden.');
    assert.equal(requests.length, 2);
    assert.ok(requests[1].input.some((item) => item.role === 'assistant'
        && item.content === 'Spotify aceptó la orden de avanzar. Estoy actualizando el estado de reproducción.'));
});

test('Spotify dispatcher result and user-facing response preserve accepted and rejected outcomes with safe correlation', async () => {
    for (const scenario of [
        { status: 204, expectedOutcome: 'provider_accepted', expectedText: 'Spotify aceptó la orden de volver a la pista anterior. Estoy actualizando el estado de reproducción.' },
        { status: 400, expectedOutcome: 'rejected', expectedText: 'Spotify no pudo completar la solicitud.' },
    ]) {
        const traces = [];
        const client = { request: async (_endpoint, options = {}) => {
            if (scenario.status !== 204) {
                options.onResponse?.(scenario.status);
                throw Object.assign(new Error('provider response'), { code: 'spotify_api_error', status: scenario.status });
            }
            options.onResponse?.(scenario.status);
            return null;
        } };
        const { agent } = await makeAgent({
            responses: [toolResponse(functionCall('spotify_previous', {}, `call-${scenario.status}`)), finalResponse('ignored model answer')],
            execute: (name, args, context) => executeTool(name, args, { ...context, client }),
            logger: (event, details) => traces.push({ event, details }),
        });
        assert.equal(await agent.run('Volvé a la canción anterior.', 'direct_user', { requestId: `desktop-${scenario.status}` }), scenario.expectedText);
        assert.ok(traces.some(({ event, details }) => event === 'spotify_provider_response'
            && details.requestId === `desktop-${scenario.status}` && details.httpStatus === scenario.status));
        assert.ok(traces.some(({ event, details }) => event === 'spotify_runtime_outcome'
            && details.requestId === `desktop-${scenario.status}` && details.outcome === scenario.expectedOutcome
            && details.httpStatus === (scenario.status === 204 ? null : scenario.status)));
        assert.ok(traces.some(({ event, details }) => event === 'spotify_response_presented'
            && details.requestId === `desktop-${scenario.status}` && details.outcome === scenario.expectedOutcome));
        assert.equal(JSON.stringify(traces).includes('provider response'), false);
    }
});

test('agent returns the single truthful Spotify warning after an uncertain track skip', async () => {
    const warning = 'Spotify no permitió verificar si cambió la pista. No se repetirá la orden para evitar saltar otra canción.';
    const { agent, requests } = await makeAgent({
        responses: [toolResponse(functionCall('spotify_next', {}, 'spotify-next-uncertain'))],
        execute: async () => ({ success: false, error: { code: 'spotify_action_outcome_uncertain', message: warning } }),
    });
    assert.equal(await agent.run('adelanta cancion'), warning);
    assert.equal(requests.length, 1);
});

test('agent prevents a duplicate Spotify skip in the same tool batch after an uncertain result', async () => {
    let executions = 0;
    const { agent } = await makeAgent({
        responses: [{ output: [
            functionCall('spotify_next', {}, 'spotify-next-first'),
            functionCall('spotify_next', {}, 'spotify-next-duplicate'),
        ], output_text: '' }],
        execute: async () => { executions++; return { success: false, outcome: 'uncertain', error: { code: 'spotify_action_outcome_uncertain', message: 'No se repetirá la orden para evitar saltar otra canción.' } }; },
    });
    const answer = await agent.run('adelanta cancion');
    assert.equal(executions, 1);
    assert.match(answer, /No se repetirá la orden/u);
});

test('Desktop authorization errors do not send CLI instructions to the model', async () => {
    let authorization;
    const { agent, requests } = await makeAgent({
        responses: [
            toolResponse(functionCall('search_emails', { query: 'reunión' })),
            finalResponse('Conectá Microsoft desde Nexa Desktop.'),
        ],
        execute: async () => ({ success: false, error: {
            code: 'email_not_connected', message: 'Ejecutá npm run connect:microsoft para conectar la cuenta.',
        } }),
    });
    await agent.run('Buscá el último correo.', 'untrusted', {
        requestId: '00000000-0000-4000-8000-000000000001',
        onAuthorizationRequired: requirement => { authorization = requirement; },
    });
    const toolOutput = requests[1].input.find(item => item.type === 'function_call_output');
    const serialized = toolOutput.output;
    assert.deepEqual(authorization, {
        provider: 'microsoft', state: 'not_connected', reason: 'email_not_connected', canConnect: true, retrySafe: true,
    });
    assert.doesNotMatch(serialized, /npm run|terminal|connect:microsoft/iu);
    assert.match(serialized, /necesita conectarse desde la acción disponible en Nexa Desktop/u);
});

test('Desktop chat reports a Spotify HTTP 403 as provider rejection, not proven missing authorization', async () => {
    let authorization;
    const message = 'Spotify rechazó la acción (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor.';
    const { agent } = await makeAgent({
        responses: [toolResponse(functionCall('spotify_play', { query: '', type: 'track' }))],
        execute: async () => ({ success: false, status: 403, outcome: 'rejected',
            error: { code: 'spotify_forbidden', message } }),
    });
    const answer = await agent.run('poné play', 'typed', { onAuthorizationRequired: value => { authorization = value; } });
    assert.equal(answer, message);
    assert.equal(authorization, undefined);
    assert.doesNotMatch(answer, /no concedió los permisos necesarios/u);
});

test('Desktop chat truthfully reports observed playback after first Play with unknown previous state', async () => {
    let authorization;
    const message = 'Spotify está reproduciendo';
    const { agent } = await makeAgent({
        responses: [toolResponse(functionCall('spotify_play', { query: '', type: 'track' }))],
        execute: async () => ({ success: false, outcome: 'uncertain', verification: 'target_state_observed',
            verificationEvidence: { before: null, after: { playing: true } },
            error: { code: 'spotify_action_outcome_uncertain', message } }),
    });
    const answer = await agent.run('poné play', 'typed', { onAuthorizationRequired: value => { authorization = value; } });
    assert.equal(answer, message);
    assert.equal(authorization, undefined);
});

test('CLI authorization errors retain their existing provider instructions', async () => {
    const { agent, requests } = await makeAgent({
        responses: [
            toolResponse(functionCall('search_emails', { query: 'reunión' })),
            finalResponse('Conectá Microsoft para continuar.'),
        ],
        execute: async () => ({ success: false, error: {
            code: 'email_not_connected', message: 'Ejecutá npm run connect:microsoft para conectar la cuenta.',
        } }),
    });
    await agent.run('Buscá el último correo.');
    const toolOutput = requests[1].input.find(item => item.type === 'function_call_output');
    assert.match(toolOutput.output, /npm run connect:microsoft/u);
});

test('Desktop Now Playing card keeps Spotify metadata out of the model and replaces contradictory final prose', async () => {
    const cardEvents = [];
    const { agent, requests } = await makeAgent({
        responses: [
            toolResponse(functionCall('spotify_get_current_track', {})),
            finalResponse('Spotify dice que está sonando algo, pero no me pasó el nombre de la canción.'),
            finalResponse('Ahora puedo continuar.'),
        ],
        execute: async () => ({ success: true, playing: true, track: {
            name: 'Alohomora', artists: ['Pogo'], imageUrl: 'https://i.scdn.co/image/album',
            spotifyUrl: 'https://open.spotify.com/track/abc123',
        } }),
    });

    const response = await agent.run('¿Qué está sonando en Spotify?', 'untrusted', {
        onSpotifyNowPlaying: card => cardEvents.push(card),
    });

    assert.deepEqual(cardEvents, [{ name: 'Alohomora', artists: ['Pogo'], imageUrl: 'https://i.scdn.co/image/album',
        spotifyUrl: 'https://open.spotify.com/track/abc123', playing: true }]);
    assert.equal(response, 'Spotify está mostrando la reproducción actual en la tarjeta.');
    const toolOutput = requests[1].input.find(item => item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(toolOutput.output), { success: true, playing: true, trackAvailable: true });
    assert.equal(response.includes('Alohomora'), false);
    await agent.run('¿Y ahora?');
    assert.equal(JSON.stringify(requests[2].input).includes('no me pasó el nombre de la canción'), false);
});
