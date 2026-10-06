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
    ask = askOpenAI,
    load = loadMemory,
    save = saveMemory,
    getTools = getToolsForModel,
    execute = executeTool,
    maxToolIterations = config.maxToolIterations,
    logger = writeAgentDiagnostic,
} = {}) {
    const memory = await load();
    const sessionId = randomUUID();

    function diagnostic(event, details = {}) {
        try { logger(event, details); } catch { /* diagnostics never change agent behavior */ }
    }

    function getInstructions() {
        return `
${NEXA_INSTRUCTIONS}

MEMORIA ACTUAL DEL USUARIO:
${memoryToPrompt(memory)}
`;
    }

    const conversation = [];

    async function getModelResponse(tools, iteration, finalOnly = false) {
        const response = await ask({
            instructions: getInstructions(),
            input: conversation,
            tools,
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

    async function run(userMessage) {
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
                    result = await execute(toolCall.name, args, { memory, saveMemory: save, permissionPolicy, sessionId, userMessage, userMessageSource: 'direct_user' });
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

    return {
        run,
        memory,
    };
}
