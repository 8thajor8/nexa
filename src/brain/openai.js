import OpenAI from 'openai';
import { config } from '../config.js';
import { AUTOMATIC_MEMORY_OUTPUT_SCHEMA } from '../memory/automatic/schema.js';

let client;
const liveAutomaticMemoryDetectors = new WeakSet();

/** Internal classification used only to keep the legacy synthetic hook offline. */
export function registerAutomaticMemoryLiveDetector(detector) {
    if (!detector || typeof detector !== 'object') throw new TypeError('automatic_memory_detector_invalid');
    liveAutomaticMemoryDetectors.add(detector);
}

export function isAutomaticMemoryLiveDetector(detector) {
    return Boolean(detector && typeof detector === 'object' && liveAutomaticMemoryDetectors.has(detector));
}

export function getOpenAIClient() {
    if (!client) {
        client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }
    return client;
}

export async function askOpenAI({ instructions, input, tools = [], signal }) {
    return getOpenAIClient().responses.create({
        model: config.model,
        instructions,
        input,
        tools,
    }, signal ? { signal } : undefined);
}

export class AutomaticMemoryResponseError extends Error {
    constructor(code) {
        super('Automatic Memory extraction response was unavailable.');
        this.name = 'AutomaticMemoryResponseError';
        this.code = code;
    }
}

/** Dedicated no-tools structured extraction call. It does not change askOpenAI or agent behavior. */
export async function extractAutomaticMemoryProposal({ text, instructions, client = getOpenAIClient(), maxOutputTokens = 2400, onUsage, signal } = {}) {
    if (typeof text !== 'string' || typeof instructions !== 'string' || !client?.responses
        || typeof client.responses.create !== 'function' || !Number.isSafeInteger(maxOutputTokens)
        || maxOutputTokens < 1 || maxOutputTokens > 2400
        || (onUsage !== undefined && typeof onUsage !== 'function')
        || (signal !== undefined && !(signal instanceof AbortSignal))) throw new TypeError('automatic_memory_request_invalid');
    if (signal?.aborted) throw new AutomaticMemoryResponseError('automatic_memory_response_cancelled');
    const response = await client.responses.create({
        model: config.model,
        instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
        tools: [],
        store: false,
        max_output_tokens: maxOutputTokens,
        text: { format: { type: 'json_schema', name: 'automatic_memory_candidate_proposal',
            strict: true, schema: AUTOMATIC_MEMORY_OUTPUT_SCHEMA } },
    }, signal ? { signal } : undefined);
    if (signal?.aborted) throw new AutomaticMemoryResponseError('automatic_memory_response_cancelled');
    const usage = response?.usage;
    if (onUsage && Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0
        && Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0) {
        try { onUsage(Object.freeze({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
            totalTokens: Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : usage.input_tokens + usage.output_tokens })); }
        catch { /* Monitoring must never change extraction behavior. */ }
    }
    if (response?.status === 'incomplete') throw new AutomaticMemoryResponseError('automatic_memory_response_incomplete');
    if (response?.status && response.status !== 'completed') throw new AutomaticMemoryResponseError('automatic_memory_response_invalid');
    const refused = Array.isArray(response?.output) && response.output.some(item => item?.type === 'message'
        && Array.isArray(item.content) && item.content.some(part => part?.type === 'refusal'));
    if (refused) throw new AutomaticMemoryResponseError('automatic_memory_response_refused');
    if (typeof response?.output_text !== 'string' || response.output_text.trim() === '')
        throw new AutomaticMemoryResponseError('automatic_memory_response_invalid');
    return response.output_text;
}
