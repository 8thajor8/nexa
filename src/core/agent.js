import { readDirectUserTurn, releaseDirectUserTurn } from './direct-user-input.js';
import { createMemoryService } from '../memory/service.js';
import { authorizeMemoryRemember, authorizeMemoryForget, authorizePersonCreation, authorizeRelationCreation,
    authorizeRelationCorrection, authorizeRelationForget } from '../memory/authorization.js';
import { createMemoryContextProvider, MEMORY_CONTEXT_POLICY } from '../memory/context-provider.js';
import { openMemoryBackend } from '../memory/backend.js';
import { randomUUID } from 'node:crypto';
import { askOpenAI } from '../brain/openai.js';
import { config } from '../config.js';
import { NEXA_INSTRUCTIONS } from '../prompts/nexa.js';
import { loadMemory, memoryToPrompt, saveMemory } from '../memory/memory.js';
import { getToolsForModel, executeTool } from '../tools/index.js';
import { formatSpotifyToolResult, isSpotifyTool, spotifyModelSafeOutput } from '../tools/spotify.js';

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    }
    return value;
}

function safeArgumentSummary(args) {
    return Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) => {
        if (typeof value === 'string') return [key, { type: 'string', length: value.length }];
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key, value];
        if (Array.isArray(value)) return [key, { type: 'array', length: value.length }];
        if (typeof value === 'object') return [key, { type: 'object', keys: Object.keys(value).slice(0, 20) }];
        return [key, { type: typeof value }];
    }));
}

function requestedRepeatCount(message) {
    const text = String(message ?? '').toLocaleLowerCase('es');
    const numeric = text.match(/\b(\d{1,2})\s*(?:veces|times)\b/u);
    if (numeric) return Math.max(1, Math.min(10, Number(numeric[1])));
    const words = new Map([
        ['dos', 2], ['two', 2], ['tres', 3], ['three', 3], ['cuatro', 4], ['four', 4],
        ['cinco', 5], ['five', 5], ['seis', 6], ['six', 6], ['siete', 7], ['seven', 7],
        ['ocho', 8], ['eight', 8], ['nueve', 9], ['nine', 9], ['diez', 10], ['ten', 10],
    ]);
    const word = text.match(/\b(dos|two|tres|three|cuatro|four|cinco|five|seis|six|siete|seven|ocho|eight|nueve|nine|diez|ten)\s+(?:veces|times)\b/u);
    return word ? words.get(word[1]) : 1;
}

function writeAgentDiagnostic(event, details) {
    if (process.env.NEXA_AGENT_DEBUG !== 'true') return;
    console.debug(`[agent] ${JSON.stringify({ event, ...details })}`);
}

export async function createAgent({
    permissionPolicy,
    memoryBackend = config.memoryBackend,
    memory2StorePath = config.memory2StorePath,
    memory2Repository = null, // Explicit host composition only; the personal CLI never sets this.
    ask = askOpenAI,
    load = loadMemory,
    save = saveMemory,
    getTools = getToolsForModel,
    execute = executeTool,
    maxToolIterations = config.maxToolIterations,
    logger = writeAgentDiagnostic,
} = {}) {
    let selectedBackend;
    if (memory2Repository) {
        if (memoryBackend !== 'memory2') throw new Error('Injected Memory 2 repository requires memoryBackend=memory2.');
        selectedBackend = { backend: 'memory2', repository: memory2Repository,
            memory: { user: {}, preferences: {}, facts: [] },
            service: createMemoryService({ repository: memory2Repository }),
            contextProvider: createMemoryContextProvider({ repository: memory2Repository }), close: async () => {} };
    } else {
        selectedBackend = await openMemoryBackend({ backend: memoryBackend, storePath: memory2StorePath, loadLegacy: load });
    }
    const memory = selectedBackend.memory;
    const memory2 = selectedBackend.service ?? null;
    const contextProvider = selectedBackend.contextProvider ?? null;
    let queue = Promise.resolve();
    let currentMessage = '', currentSource = 'untrusted', contextDigest = null;
    const memoryToolNames = new Set(['remember', 'forget', 'recall', 'memory_context_snapshot', 'create_person',
        'create_relation', 'correct_relation', 'forget_relation', 'relations_for_entity']);
    function enqueue(operation) {
        const next = queue.then(operation);
        queue = next.catch(() => {});
        return next;
    }
    const sessionId = randomUUID();

    function diagnostic(event, details = {}) {
        try { logger(event, details); } catch { /* diagnostics never change agent behavior */ }
    }

    function getInstructions() {
        if (memory2) return NEXA_INSTRUCTIONS + MEMORY_CONTEXT_POLICY;
        return `
${NEXA_INSTRUCTIONS}

MEMORIA ACTUAL DEL USUARIO:
${memoryToPrompt(memory)}
`;
    }

    const conversation = [];

    async function getModelResponse(tools, iteration, finalOnly = false) {
        const memoryContext = contextProvider ? await contextProvider.read() : null;
        if (memoryContext && contextDigest !== null && contextDigest !== memoryContext.digest) {
            // Discard all derived history, including possible assistant echoes of deleted facts.
            conversation.length = 0;
            conversation.push({ role: 'user', content: currentMessage });
        }
        if (memoryContext) contextDigest = memoryContext.digest;
        const response = await ask({
            instructions: getInstructions(),
            input: memoryContext ? [...memoryContext.items, ...structuredClone(conversation)] : conversation,
            tools: memory2 ? tools.filter(tool => !memoryToolNames.has(tool.name)) : tools,
        });
        conversation.push(...(response.output ?? []));
        const toolCalls = (response.output ?? []).filter(item => item.type === 'function_call');
        diagnostic('model_response', {
            iteration,
            finalOnly,
            type: toolCalls.length ? 'tool_calls' : 'final',
            toolCallCount: toolCalls.length,
        });
        return { response, toolCalls };
    }

    async function finalAnswer(spotifyMessages, iteration, reason) {
        diagnostic('final_turn', { iteration, reason, toolsDisabled: true });
        const { response, toolCalls } = await getModelResponse([], iteration, true);
        if (toolCalls.length > 0) {
            diagnostic('tool_loop_prevented', { iteration, reason: 'tools_returned_when_disabled', count: toolCalls.length });
            return [...spotifyMessages, 'El ciclo de herramientas terminó, pero no pude generar una respuesta final segura.'].filter(Boolean).join('\n\n');
        }
        return [response.output_text, ...spotifyMessages].filter(Boolean).join('\n\n')
            || [...spotifyMessages, 'El ciclo de herramientas terminó, pero no pude generar una respuesta final.'].filter(Boolean).join('\n\n');
    }

    async function run(userMessage, source = 'untrusted') {
        if (typeof userMessage !== 'string') throw new TypeError('user_message_must_be_text');
        currentMessage = userMessage; currentSource = source;
        const spotifyMessages = [];
        const successfulCalls = new Map();
        const repeatLimit = requestedRepeatCount(userMessage);
        conversation.push({ role: 'user', content: userMessage });

        for (let iteration = 1; iteration <= maxToolIterations; iteration++) {
            const { response, toolCalls } = await getModelResponse(getTools(permissionPolicy), iteration);
            if (toolCalls.length === 0) {
                return [response.output_text, ...spotifyMessages].filter(Boolean).join('\n\n');
            }

            let repeatedSuccessfulCall = false;
            for (const toolCall of toolCalls) {
                let args;
                try {
                    args = JSON.parse(toolCall.arguments);
                } catch {
                    args = {};
                    const result = { success: false, error: { code: 'invalid_tool_arguments', message: 'Los argumentos de la herramienta no eran JSON válido.' } };
                    diagnostic('tool_call', { iteration, tool: toolCall.name, arguments: {}, result: 'error', code: 'invalid_tool_arguments' });
                    conversation.push({ type: 'function_call_output', call_id: toolCall.call_id, output: JSON.stringify(result) });
                    continue;
                }

                const callKey = JSON.stringify([toolCall.name, stableValue(args)]);
                const successfulCount = successfulCalls.get(callKey) ?? 0;
                if (successfulCount >= repeatLimit) {
                    const result = {
                        success: false,
                        error: {
                            code: 'repeated_successful_tool_call',
                            message: 'Esta misma llamada ya se completó correctamente en esta conversación. No la repitas; responde al usuario con el resultado anterior.',
                        },
                    };
                    diagnostic('tool_loop_prevented', { iteration, tool: toolCall.name, reason: 'repeated_successful_tool_call' });
                    conversation.push({ type: 'function_call_output', call_id: toolCall.call_id, output: JSON.stringify(result) });
                    repeatedSuccessfulCall = true;
                    continue;
                }

                diagnostic('tool_call', { iteration, tool: toolCall.name, arguments: safeArgumentSummary(args) });
                let result;
                try {
                    if (memory2 && memoryToolNames.has(toolCall.name)) {
                        result = { success: false, error: { code: 'memory_write_not_authorized', message: 'Memory commands require direct terminal input.' } };
                    } else {
                        result = await execute(toolCall.name, args, { memory, saveMemory: memory2 ? undefined : save,
                            permissionPolicy, sessionId, userMessage,
                            userMessageSource: currentSource });
                    }
                } catch (error) {
                    result = { success: false, error: { code: 'tool_execution_failed', message: error.message } };
                }
                const succeeded = result?.success === true;
                if (succeeded && ['set_ui_value', 'invoke_ui_element'].includes(toolCall.name)) {
                    result = { ...result, completed: true };
                }
                diagnostic('tool_result', { iteration, tool: toolCall.name, success: succeeded, code: result?.error?.code ?? null });
                if (succeeded) successfulCalls.set(callKey, successfulCount + 1);

                const isSpotify = isSpotifyTool(toolCall.name);
                const output = isSpotify ? spotifyModelSafeOutput(toolCall.name, result) : result;
                if (isSpotify) spotifyMessages.push(formatSpotifyToolResult(toolCall.name, result));
                conversation.push({
                    type: 'function_call_output',
                    call_id: toolCall.call_id,
                    output: JSON.stringify(output),
                });
            }

            if (repeatedSuccessfulCall) {
                return finalAnswer(spotifyMessages, iteration, 'repeated_successful_tool_call');
            }
        }

        // Tool rounds are capped; give the model one response-only turn to summarize their outcomes.
        return finalAnswer(spotifyMessages, maxToolIterations, 'max_tool_iterations');
    }

    // No method accepting a caller string can assert trusted Memory 2 provenance.
    async function readAndRun() {
        return enqueue(async () => {
            const turn = await readDirectUserTurn(memory2 ?? agent);
            if (!turn) return { done: true };
            try {
                const { message, command, capability } = turn;
                if (message.trim().toLowerCase() === 'salir') return { done: true };
                if (!message.trim()) return { done: false, response: '' };
                if (memory2 && command) {
                    const input = { capability, recipient: memory2 };
                    let result;
                    if (command.operation === 'create_person') result = await memory2.createPerson(command.request,
                        authorizePersonCreation({ ...input, request: command.request }));
                    else if (command.operation === 'remember') result = await memory2.remember({ proposal: command.request },
                        authorizeMemoryRemember({ ...input, proposal: command.request }));
                    else if (command.operation === 'create_relation') result = await memory2.createRelation(command.request,
                        authorizeRelationCreation({ ...input, request: command.request }));
                    else if (command.operation === 'correct_relation') result = await memory2.correctRelation(command.request,
                        authorizeRelationCorrection({ ...input, request: command.request }));
                    else if (command.operation === 'forget_relation') result = await memory2.forgetRelation(command.request,
                        authorizeRelationForget({ ...input, request: command.request }));
                    else result = await memory2.forget(command.request,
                        authorizeMemoryForget({ ...input, target: command.request }));
                    if (result.success && result.invalidateContext === true) {
                        contextProvider.invalidate();
                        conversation.length = 0;
                        contextDigest = null;
                    }
                    // No memory payload or proof is passed to the model or to tools.
                    return { done: false, response: result.success ? 'Memoria actualizada.' : result.error.message, memoryResult: result };
                }
                return { done: false, response: await run(message, 'direct_user') };
            } finally { releaseDirectUserTurn(turn.capability); }
        });
    }
    const agent = { run: message => enqueue(() => run(message)), readAndRun, memory,
        memoryBackend: selectedBackend.backend, close: () => selectedBackend.close() };
    return agent;
}
