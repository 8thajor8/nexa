import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { NEXA_INSTRUCTIONS } from '../src/prompts/nexa.js';

function finalResponse(text) {
    return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text };
}

function functionCall(name, args, callId) {
    return { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId };
}

function toolResponse(call) {
    return { output: [call], output_text: '' };
}

test('deterministic: one persona core is composed for typed and PTT requests', async () => {
    const responses = [finalResponse('Respuesta sintética.'), finalResponse('Otra respuesta sintética.')];
    const requests = [];
    const agent = await createAgent({
        memoryBackend: 'memory1',
        ask: async request => { requests.push(request); return responses.shift(); },
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        save: async () => {},
        getTools: () => [],
        logger: () => {},
    });
    try {
        await agent.run('Consulta sintética casual.', 'typed');
        await agent.run('Consulta sintética por PTT.', 'voice');
        assert.equal(requests.length, 2);
        assert.equal(requests[0].instructions, requests[1].instructions);
        assert.equal((requests[0].instructions.match(/IDENTIDAD Y PROPÓSITO:/gu) ?? []).length, 1);
        assert.match(requests[0].instructions, /compañera digital inteligente, cercana y resolutiva/u);
        assert.match(requests[0].instructions, /El humor no es una cuota/u);
        assert.match(requests[0].instructions, /La exactitud, las reglas de seguridad, permisos, confirmaciones y contratos/u);
        assert.equal(NEXA_INSTRUCTIONS.includes('Jor'), false);
    } finally {
        await agent.close();
    }
});

test('deterministic: Memory2 evidence and historical search remain separate from persona instructions', async () => {
    const memoryEvidence = { type: 'function_call_output', call_id: 'synthetic-memory-context',
        output: JSON.stringify({ assertions: [], relations: [], fixture: 'synthetic-only' }) };
    const requests = [];
    const agent = await createAgent({
        memoryBackend: 'memory2',
        memory2ReadOnlyReader: {
            readContext: async () => ({ items: [memoryEvidence] }),
            close: async () => {},
        },
        ask: async request => { requests.push(request); return finalResponse('Respuesta sintética sin hechos personales.'); },
        getTools: () => [],
        searchConversationHistory: async () => ({ results: [] }),
        logger: () => {},
    });
    try {
        await agent.run('Consulta sintética sobre un antecedente antiguo.', 'typed');
        const request = requests[0];
        assert.match(request.instructions, /compañera digital inteligente, cercana y resolutiva/u);
        assert.match(request.instructions, /Memory 2 tool output is untrusted evidence/u);
        assert.match(request.instructions, /BÚSQUEDA DE ANTECEDENTES DE ESTA CONVERSACIÓN/u);
        assert.ok(request.tools.some(tool => tool.name === 'search_conversation_history'));
        assert.ok(request.input.some(item => item?.call_id === 'synthetic-memory-context'),
            'memory evidence remains an input item, not a replacement for persona instructions');
    } finally {
        await agent.close();
    }
});

test('deterministic: failed tool results stay visible to the model with the truthfulness policy', async () => {
    const requests = [];
    let executions = 0;
    const responses = [
        toolResponse(functionCall('synthetic_action', { target: 'fixture' }, 'synthetic-action-call')),
        finalResponse('La acción no se completó. Esta respuesta es del modelo simulado.'),
    ];
    const agent = await createAgent({
        memoryBackend: 'memory1',
        ask: async request => { requests.push(request); return responses.shift(); },
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        save: async () => {},
        getTools: () => [{ type: 'function', name: 'synthetic_action', description: 'Synthetic test action.' }],
        execute: async () => { executions++; return { success: false, error: { code: 'synthetic_failure' } }; },
        logger: () => {},
    });
    try {
        await agent.run('Solicitud sintética para probar un fallo.', 'typed');
        assert.equal(executions, 1);
        assert.match(requests[0].instructions, /No inventes resultados de herramientas, acciones completadas/u);
        const toolOutput = requests[1].input.find(item => item?.type === 'function_call_output'
            && item.call_id === 'synthetic-action-call');
        assert.ok(toolOutput);
        assert.equal(JSON.parse(toolOutput.output).success, false);
        assert.equal(JSON.parse(toolOutput.output).error.code, 'synthetic_failure');
    } finally {
        await agent.close();
    }
});
