import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createRuntimeAgent } from './runtime-agent.js';

const ID_MAX_LENGTH = 128;

function validIdentifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_LENGTH
        && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function resultError(conversationId, requestId, code, message) {
    return { conversationId, requestId, status: 'error', error: { code, message } };
}

/**
 * Create an in-process, non-persistent conversation API. Each conversation owns
 * an agent instance; requests are globally single-flight because tool adapters
 * can share mutable Windows/UI state.
 */
export function createConversationRuntime({
    agentFactory = createRuntimeAgent,
    agentOptions = {},
    memoryMode = config.cliMemoryMode,
    storePath = config.memory2ReadOnlyStorePath,
} = {}) {
    if (typeof agentFactory !== 'function') throw new TypeError('agent_factory_invalid');

    const conversations = new Map();
    const activeRequests = new Map();
    const seenRequestIds = new Set();
    const listeners = new Set();
    let closed = false;
    let closing;

    function emit(entry, status, extra = {}) {
        if (entry.terminal) return false;
        const terminal = status === 'completed' || status === 'cancelled' || status === 'error';
        if (terminal) entry.terminal = true;
        const event = Object.freeze({ conversationId: entry.conversationId,
            requestId: entry.requestId, status, ...extra });
        for (const listener of listeners) {
            try { listener(event); } catch { /* Subscribers cannot change Runtime state. */ }
        }
        return true;
    }

    function rejected(conversationId, requestId, code, message, withEvent = false) {
        const result = resultError(conversationId, requestId, code, message);
        if (withEvent) emit({ conversationId, requestId, terminal: false }, 'error', { error: result.error });
        return result;
    }

    async function getAgent(conversation) {
        if (conversation.agent) return conversation.agent;
        if (!conversation.agentPromise) {
            conversation.agentPromise = Promise.resolve().then(() => agentFactory({
                memoryMode, storePath, agentOptions,
            })).then(agent => {
                if (!agent || typeof agent.run !== 'function' || typeof agent.close !== 'function')
                    throw new TypeError('agent_factory_result_invalid');
                conversation.agent = agent;
                return agent;
            }).catch(error => {
                conversation.agentPromise = null;
                throw error;
            });
        }
        return conversation.agentPromise;
    }

    async function retireAgent(conversation, agent) {
        if (conversation.agent !== agent) return;
        conversation.agent = null;
        conversation.agentPromise = null;
        try { await agent.close(); } catch { /* A request error remains the public result. */ }
    }

    async function processRequest(entry, conversation, text, source) {
        let agent;
        try {
            agent = await getAgent(conversation);
            if (entry.controller.signal.aborted) {
                emit(entry, 'cancelled');
                return { conversationId: entry.conversationId, requestId: entry.requestId, status: 'cancelled' };
            }
            const response = await agent.run(text, source, { signal: entry.controller.signal });
            if (entry.controller.signal.aborted) {
                emit(entry, 'cancelled');
                return { conversationId: entry.conversationId, requestId: entry.requestId, status: 'cancelled' };
            }
            const result = { conversationId: entry.conversationId, requestId: entry.requestId,
                status: 'completed', text: typeof response === 'string' ? response : '' };
            emit(entry, 'completed', { text: result.text });
            return result;
        } catch {
            if (entry.controller.signal.aborted) {
                emit(entry, 'cancelled');
                return { conversationId: entry.conversationId, requestId: entry.requestId, status: 'cancelled' };
            }
            if (agent) await retireAgent(conversation, agent);
            const error = { code: 'agent_error', message: 'The conversation request failed.' };
            emit(entry, 'error', { error });
            return { conversationId: entry.conversationId, requestId: entry.requestId,
                status: 'error', error };
        }
    }

    function createConversation() {
        if (closed) throw new Error('conversation_runtime_closed');
        const conversationId = randomUUID();
        conversations.set(conversationId, { agent: null, agentPromise: null });
        return conversationId;
    }

    function sendMessage(input = {}) {
        const conversationId = typeof input?.conversationId === 'string' ? input.conversationId : null;
        const requestId = typeof input?.requestId === 'string' ? input.requestId : null;
        if (closed) return Promise.resolve(rejected(conversationId, requestId,
            'runtime_closed', 'Conversation runtime is closed.'));
        if (!validIdentifier(conversationId)) return Promise.resolve(rejected(conversationId, requestId,
            'conversation_id_invalid', 'A valid conversationId is required.'));
        if (!validIdentifier(requestId)) return Promise.resolve(rejected(conversationId, requestId,
            'request_id_invalid', 'A valid requestId is required.'));
        if (seenRequestIds.has(requestId)) return Promise.resolve(rejected(conversationId, requestId,
            'request_id_duplicate', 'requestId has already been used.'));
        seenRequestIds.add(requestId);
        if (typeof input.text !== 'string' || input.text.trim() === '') return Promise.resolve(rejected(conversationId, requestId,
            'text_invalid', 'text must contain non-whitespace characters.'));
        if (input.source !== 'typed' && input.source !== 'voice') return Promise.resolve(rejected(conversationId, requestId,
            'source_invalid', 'source must be typed or voice.'));
        const conversation = conversations.get(conversationId);
        if (!conversation) return Promise.resolve(rejected(conversationId, requestId,
            'conversation_not_found', 'Conversation does not exist.', true));
        if (activeRequests.size > 0) {
            const sameConversation = activeRequests.values().next().value?.conversationId === conversationId;
            return Promise.resolve(rejected(conversationId, requestId, 'busy', sameConversation
                ? 'Conversation already processing.' : 'Runtime is processing another conversation.', true));
        }

        const entry = { conversationId, requestId, controller: new AbortController(), terminal: false, promise: null };
        activeRequests.set(requestId, entry);
        entry.promise = processRequest(entry, conversation, input.text, input.source)
            .finally(() => activeRequests.delete(requestId));
        emit(entry, 'processing');
        return entry.promise;
    }

    function cancelRequest(requestId) {
        if (typeof requestId !== 'string') return false;
        const entry = activeRequests.get(requestId);
        if (!entry || entry.terminal || entry.controller.signal.aborted) return false;
        entry.controller.abort();
        return true;
    }

    function onEvent(callback) {
        if (typeof callback !== 'function') throw new TypeError('event_callback_invalid');
        if (closed) throw new Error('conversation_runtime_closed');
        listeners.add(callback);
        return () => listeners.delete(callback);
    }

    function close() {
        if (closing) return closing;
        if (closed) return Promise.resolve();
        closed = true;
        for (const entry of activeRequests.values()) entry.controller.abort();
        closing = (async () => {
            await Promise.allSettled([...activeRequests.values()].map(entry => entry.promise));
            const errors = [];
            for (const conversation of conversations.values()) {
                if (!conversation.agent) continue;
                try { await conversation.agent.close(); }
                catch { errors.push(true); }
                conversation.agent = null;
            }
            conversations.clear();
            listeners.clear();
            if (errors.length) throw new Error('conversation_runtime_close_failed');
        })();
        return closing;
    }

    return Object.freeze({ createConversation, sendMessage, cancelRequest, onEvent, close });
}
