import { randomUUID } from 'node:crypto';
import { config, resolveCliMemoryMode } from '../config.js';
import { createRuntimeAgent } from './runtime-agent.js';
import { openMemoryBackend } from '../memory/backend.js';
import { classifySystemDiagnosticRequest, createOperationalDiagnostics, createTechnicalDiagnosticReport,
    formatMemoryDiagnostics, formatSystemStatus, formatToolCatalog, formatVoiceStatus } from './system-diagnostics.js';
import { getToolsForModel, hostedToolRegistry, localToolRegistry } from '../tools/index.js';

const ID_MAX_LENGTH = 128;

const safeProviderCodes = new Set([
    'invalid_api_key', 'model_not_found', 'model_not_available', 'unsupported_model',
    'insufficient_quota', 'billing_hard_limit_reached', 'rate_limit_exceeded',
    'invalid_request_error', 'unsupported_parameter',
]);
const quotaCodes = new Set(['insufficient_quota', 'billing_hard_limit_reached']);
const transportCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const safeErrorNames = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'APIError',
    'AuthenticationError', 'PermissionDeniedError', 'BadRequestError', 'NotFoundError', 'RateLimitError',
    'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'Memory2ReadOnlyError',
    'MemoryBackendStartupError', 'Memory2ExistingReaderError', 'MemoryRepositoryError', 'MemorySchemaError']);
const safeMemoryInitializationCodes = new Set([
    'memory_backend_invalid', 'memory_repository_invalid', 'memory_store_unreadable',
    'memory_store_initialization_failed', 'memory_store_missing', 'memory_store_invalid', 'memory_uninitialized',
    'memory_store_corrupt', 'memory_store_locked', 'memory_lock_lost', 'memory_revision_conflict',
    'memory_schema_unsupported', 'memory_store_changed', 'memory_reader_closed', 'memory_reader_close_failed',
    'memory_repository_closed', 'memory_persist_failed', 'memory_commit_uncertain', 'memory_invalid_changes',
    'memory_lock_failed', 'memory_lock_held', 'memory_lock_ownership_lost',
]);

function classifyFailure(error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status : null;
    const candidateCode = typeof error?.code === 'string' ? error.code
        : typeof error?.error?.code === 'string' ? error.error.code : null;
    const providerCode = safeProviderCodes.has(candidateCode) ? candidateCode : null;
    const errorName = typeof error?.name === 'string' && safeErrorNames.has(error.name) ? error.name : 'Error';
    let category = 'internal';

    if (status === 401 || providerCode === 'invalid_api_key') category = 'authentication';
    else if (providerCode && ['model_not_found', 'model_not_available', 'unsupported_model'].includes(providerCode))
        category = 'model_unavailable';
    else if (status === 403) category = 'permission';
    else if (status === 429 && quotaCodes.has(providerCode)) category = 'quota';
    else if (status === 429 || providerCode === 'rate_limit_exceeded') category = 'rate_limited';
    else if (status === 400 || status === 422 || (providerCode && ['invalid_request_error', 'unsupported_parameter'].includes(providerCode)))
        category = 'request_rejected';
    else if (status === 404) category = 'provider_resource_not_found';
    else if (status !== null && status >= 500) category = 'provider_unavailable';
    else if (transportCodes.has(candidateCode) || ['APIConnectionError', 'APIConnectionTimeoutError'].includes(errorName))
        category = 'transport';

    return { category, status, providerCode, errorName };
}

function safeInitializationMessage(error) {
    if (safeMemoryInitializationCodes.has(error?.code)
        || ['MemoryBackendStartupError', 'Memory2ExistingReaderError', 'MemoryRepositoryError', 'MemorySchemaError']
            .includes(error?.name)) return null;
    if (typeof error?.message !== 'string' || error.message.length === 0 || error.message.length > 500) return null;
    let message = error.message
        .replace(/\bBearer\s+[^\s,;]+/giu, '[redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, '[redacted]')
        .replace(/\b(?:[A-Z0-9_]*(?:API[_ -]?)?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|COOKIE)\s*[:=]\s*[^\s,;]+/giu, '[redacted]')
        .replace(/\b[A-Z]:\\[^\r\n,;)]*/gu, '[path]')
        .replace(/\/(?:Users|home|tmp|private|var)\/[^\r\n,;)]*/gu, '[path]')
        .replace(/(["'])[^"'\r\n]{1,200}\1/gu, '$1[redacted]$1');
    if (/(?:api[_ -]?key|token|secret|password|authorization|cookie|prompt|memory|conversation|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/iu.test(message)) return null;
    if (!/^[A-Za-z0-9 _.,:;()[\]{}'"/+\-=\\]{1,240}$/u.test(message)) return null;
    return message;
}

function safeInitializationErrorCode(error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    if (safeMemoryInitializationCodes.has(code)) return code;
    if (!code || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(code)
        || /(?:key|token|secret|password|authorization|credential|prompt|memory|conversation)/iu.test(code)) return null;
    return code;
}

function safeInitializationErrorName(error) {
    return typeof error?.name === 'string' && safeErrorNames.has(error.name) ? error.name : 'Error';
}

function validIdentifier(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_LENGTH
        && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

const CONVERSATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function restoredHistory(messages, maxMessages, maxCharacters) {
    if (!Array.isArray(messages) || messages.length > 100)
        throw new TypeError('conversation_history_invalid');
    const normalized = messages.map(message => {
        if (!message || typeof message !== 'object' || Array.isArray(message)
            || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'
            || message.content.trim() === '' || message.content.length > 1_000_000
            || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(message.content))
            throw new TypeError('conversation_history_invalid');
        return Object.freeze({ role: message.role, content: message.content });
    });
    let selected = maxMessages === 0 ? [] : normalized.slice(-maxMessages);
    let characters = selected.reduce((total, message) => total + message.content.length, 0);
    while (selected.length && characters > maxCharacters)
        characters -= selected.shift().content.length;
    return Object.freeze(selected);
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
    diagnostic = () => {},
    memoryMode = config.cliMemoryMode,
    storePath = config.memory2ReadOnlyStorePath,
    maxRestoredHistoryMessages = 12,
    maxRestoredHistoryCharacters = 12_000,
    operationalDiagnostics = createOperationalDiagnostics({ memoryMode }),
} = {}) {
    if (typeof agentFactory !== 'function') throw new TypeError('agent_factory_invalid');
    if (!Number.isSafeInteger(maxRestoredHistoryMessages) || maxRestoredHistoryMessages < 0 || maxRestoredHistoryMessages > 100
        || !Number.isSafeInteger(maxRestoredHistoryCharacters) || maxRestoredHistoryCharacters < 0
        || maxRestoredHistoryCharacters > 100_000) throw new TypeError('conversation_history_budget_invalid');

    const conversations = new Map();
    const activeRequests = new Map();
    const seenRequestIds = new Set();
    const listeners = new Set();
    let closed = false;
    let closing;
    let sharedWritableMemoryBackendPromise = null;
    let sharedWritableMemoryBackend = null;

    function getSharedWritableMemoryBackend() {
        if (!sharedWritableMemoryBackendPromise) {
            sharedWritableMemoryBackendPromise = openMemoryBackend({
                backend: 'memory2',
                storePath,
                organicMemoryAuthorizationFactory: agentOptions.organicMemoryAuthorizationFactory ?? null,
            }).then(backend => {
                sharedWritableMemoryBackend = backend;
                return backend;
            }).catch(error => {
                sharedWritableMemoryBackendPromise = null;
                throw error;
            });
        }
        return sharedWritableMemoryBackendPromise;
    }

    function trace(event, details = {}) {
        try { diagnostic(Object.freeze({ area: 'conversation_runtime', event, ...details })); }
        catch { /* Diagnostics must not affect request behavior. */ }
    }

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

    function getSystemDiagnosticsSnapshot(conversation) {
        if (typeof conversation.agent?.getSystemDiagnostics === 'function') return conversation.agent.getSystemDiagnostics();
        const snapshot = operationalDiagnostics.snapshot();
        let definitions = null;
        try {
            const getTools = typeof agentOptions.getTools === 'function' ? agentOptions.getTools : getToolsForModel;
            definitions = getTools(agentOptions.permissionPolicy);
        } catch { /* Tool availability remains unknown if the registry cannot be read. */ }
        const internalMemoryTools = new Set([
            'remember', 'forget', 'recall', 'memory_context_snapshot', 'create_person', 'create_relation',
            'correct_relation', 'forget_relation', 'relations_for_entity',
        ]);
        if (Array.isArray(definitions) && memoryMode !== 'memory1')
            definitions = definitions.filter(tool => !internalMemoryTools.has(tool.name));
        const registered = [...localToolRegistry.keys(), ...hostedToolRegistry
            .map(item => item.definition?.name ?? item.definition?.type).filter(Boolean)];
        return Object.freeze({ ...snapshot, tools: Object.freeze({ registered: Object.freeze(registered),
            available: Array.isArray(definitions) ? Object.freeze(definitions.map(tool => tool.name ?? tool.type)
                .filter(name => typeof name === 'string')) : null,
            definitions: Array.isArray(definitions) ? Object.freeze(definitions.map(tool => Object.freeze({
                id: tool.name ?? tool.type, description: typeof tool.description === 'string' ? tool.description : '',
            }))) : Object.freeze([]) }) });
    }

    async function getAgent(conversation) {
        if (conversation.agent) return conversation.agent;
        if (!conversation.agentPromise) {
            conversation.agentPromise = Promise.resolve().then(async () => {
                const options = { ...agentOptions, operationalDiagnostics, operationalMemoryMode: memoryMode };
                // A writable Memory2 repository owns an exclusive process lock. Keep
                // one repository for this Runtime while retaining a separate agent
                // and conversational history for every conversation.
                if (agentFactory === createRuntimeAgent
                    && (memoryMode === 'memory2' || memoryMode === 'memory2-confirmed-write')) {
                    const backend = await getSharedWritableMemoryBackend();
                    options.memory2Repository = backend.repository;
                }
                return agentFactory({ memoryMode, storePath,
                    initialConversationHistory: conversation.initialConversationHistory,
                    agentOptions: options });
            }).then(agent => {
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
        const systemDiagnosticKind = classifySystemDiagnosticRequest(text);
        let agent;
        let failureStage = 'agent_initialization';
        const startedAt = Date.now();
        try {
            if (systemDiagnosticKind) {
                const snapshot = getSystemDiagnosticsSnapshot(conversation);
                // Spoken diagnostics must remain a concise natural-language summary; the
                // structured technical detail remains attached for the existing copy action.
                const technical = systemDiagnosticKind.startsWith('technical_') && source !== 'voice';
                if (systemDiagnosticKind.startsWith('tool_catalog')) {
                    const catalog = formatToolCatalog(snapshot, { category: systemDiagnosticKind === 'tool_catalog_spotify' ? 'Música y Spotify' : null });
                    const result = { conversationId: entry.conversationId, requestId: entry.requestId,
                        status: 'completed', text: catalog.text,
                        ...(catalog.technicalDetail ? { presentation: { kind: 'tool_catalog', technicalDetail: catalog.technicalDetail } } : {}) };
                    emit(entry, 'completed', { text: result.text, ...(result.presentation ? { presentation: result.presentation } : {}) });
                    trace('tool_catalog_completed', { conversationId: entry.conversationId, requestId: entry.requestId,
                        category: systemDiagnosticKind === 'tool_catalog_spotify' ? 'spotify' : 'all' });
                    return result;
                }
                const responseText = systemDiagnosticKind.endsWith('memory')
                    ? formatMemoryDiagnostics(snapshot, { technical })
                    : systemDiagnosticKind === 'technical_voice' ? formatVoiceStatus(snapshot)
                    : formatSystemStatus(snapshot, { technical });
                const presentation = { kind: 'diagnostic', technicalDetail: createTechnicalDiagnosticReport(snapshot,
                    systemDiagnosticKind.endsWith('memory') ? 'memory' : systemDiagnosticKind === 'technical_voice' ? 'voice' : 'system') };
                const result = { conversationId: entry.conversationId, requestId: entry.requestId,
                    status: 'completed', text: responseText, ...(presentation ? { presentation } : {}) };
                emit(entry, 'completed', { text: responseText, ...(presentation ? { presentation } : {}) });
                trace('system_diagnostic_completed', { conversationId: entry.conversationId,
                    requestId: entry.requestId, diagnostic: systemDiagnosticKind });
                return result;
            }
            trace('agent_initialization_started', { conversationId: entry.conversationId, requestId: entry.requestId });
            agent = await getAgent(conversation);
            trace('agent_started', { conversationId: entry.conversationId, requestId: entry.requestId });
            if (entry.controller.signal.aborted) {
                emit(entry, 'cancelled');
                trace('request_cancelled', { conversationId: entry.conversationId, requestId: entry.requestId,
                    durationMs: Date.now() - startedAt, origin: entry.cancelOrigin ?? 'unknown' });
                return { conversationId: entry.conversationId, requestId: entry.requestId, status: 'cancelled' };
            }
            failureStage = 'agent_run';
            // Runtime requests are admitted from the trusted Desktop Main IPC boundary.
            // Keep typed/voice as the modality, and separately mark the turn as direct user input
            // so action confirmations can be bound to the actual user message.
            const response = await agent.run(text, source, {
                signal: entry.controller.signal,
                requestId: entry.requestId,
                userMessageSource: 'direct_user',
                onAuthorizationRequired: requirement => {
                    if (!entry.terminal && requirement && typeof requirement === 'object') {
                        emit(entry, 'authorization_required', { requirement });
                    }
                },
                onSpotifyNowPlaying: card => {
                    if (!entry.terminal && card && typeof card === 'object') emit(entry, 'spotify_now_playing', { card });
                },
            });
            if (entry.controller.signal.aborted) {
                emit(entry, 'cancelled');
                trace('request_cancelled', { conversationId: entry.conversationId, requestId: entry.requestId,
                    durationMs: Date.now() - startedAt, origin: entry.cancelOrigin ?? 'unknown' });
                return { conversationId: entry.conversationId, requestId: entry.requestId, status: 'cancelled' };
            }
            const result = { conversationId: entry.conversationId, requestId: entry.requestId,
                status: 'completed', text: typeof response === 'string' ? response : '' };
            emit(entry, 'completed', { text: result.text });
            trace('request_completed', { conversationId: entry.conversationId, requestId: entry.requestId,
                durationMs: Date.now() - startedAt });
            return result;
        } catch (caughtError) {
            if (entry.controller.signal.aborted) {
                emit(entry, 'cancelled');
                trace('request_cancelled', { conversationId: entry.conversationId, requestId: entry.requestId,
                    durationMs: Date.now() - startedAt, origin: entry.cancelOrigin ?? 'unknown' });
                return { conversationId: entry.conversationId, requestId: entry.requestId, status: 'cancelled' };
            }
            if (failureStage === 'agent_initialization') {
                operationalDiagnostics.recordInitializationFailure(caughtError);
                trace('agent_initialization_error', {
                    stage: failureStage,
                    errorName: safeInitializationErrorName(caughtError),
                    errorCode: safeInitializationErrorCode(caughtError),
                    initializationMessage: safeInitializationMessage(caughtError),
                });
            }
            if (agent) await retireAgent(conversation, agent);
            const error = { code: 'agent_error', message: 'The conversation request failed.' };
            emit(entry, 'error', { error });
            const failure = classifyFailure(caughtError);
            trace('request_failed', { conversationId: entry.conversationId, requestId: entry.requestId,
                durationMs: Date.now() - startedAt, stage: failureStage, outcome: failure.category,
                providerStatus: failure.status, errorName: failure.errorName, errorCode: failure.providerCode });
            return { conversationId: entry.conversationId, requestId: entry.requestId,
                status: 'error', error };
        }
    }

    function createConversation() {
        if (closed) throw new Error('conversation_runtime_closed');
        const conversationId = randomUUID();
        conversations.set(conversationId, { agent: null, agentPromise: null, initialConversationHistory: Object.freeze([]) });
        return conversationId;
    }

    function restoreConversation(conversationId, messages = []) {
        if (closed) throw new Error('conversation_runtime_closed');
        if (typeof conversationId !== 'string' || !CONVERSATION_UUID.test(conversationId))
            throw new TypeError('conversation_id_invalid');
        if (conversations.has(conversationId)) return false;
        if (activeRequests.size > 0) throw new Error('conversation_runtime_busy');
        conversations.set(conversationId, { agent: null, agentPromise: null,
            initialConversationHistory: restoredHistory(messages, maxRestoredHistoryMessages, maxRestoredHistoryCharacters) });
        return true;
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
        trace('request_accepted', { conversationId, requestId, source: input.source });
        entry.promise = processRequest(entry, conversation, input.text, input.source)
            .finally(() => activeRequests.delete(requestId));
        emit(entry, 'processing');
        return entry.promise;
    }

    function cancelRequest(requestId, origin = 'unspecified') {
        if (typeof requestId !== 'string') return false;
        const entry = activeRequests.get(requestId);
        if (!entry || entry.terminal || entry.controller.signal.aborted) return false;
        entry.cancelOrigin = typeof origin === 'string' ? origin : 'unspecified';
        entry.controller.abort();
        trace('cancel_requested', { conversationId: entry.conversationId, requestId, origin: entry.cancelOrigin });
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
        for (const entry of activeRequests.values()) {
            if (!entry.controller.signal.aborted) {
                entry.cancelOrigin = 'runtime_close';
                trace('cancel_requested', { conversationId: entry.conversationId, requestId: entry.requestId,
                    origin: entry.cancelOrigin });
                entry.controller.abort();
            }
        }
        closing = (async () => {
            await Promise.allSettled([...activeRequests.values()].map(entry => entry.promise));
            const errors = [];
            for (const conversation of conversations.values()) {
                if (!conversation.agent) continue;
                try { await conversation.agent.close(); }
                catch { errors.push(true); }
                conversation.agent = null;
            }
            if (sharedWritableMemoryBackend) {
                try { await sharedWritableMemoryBackend.close(); }
                catch { errors.push(true); }
                sharedWritableMemoryBackend = null;
                sharedWritableMemoryBackendPromise = null;
            }
            conversations.clear();
            listeners.clear();
            if (errors.length) throw new Error('conversation_runtime_close_failed');
        })();
        return closing;
    }

    return Object.freeze({ createConversation, restoreConversation, sendMessage, cancelRequest, onEvent,
        getMemoryMode: () => memoryMode === 'memory2-confirmed-write' ? memoryMode : resolveCliMemoryMode(memoryMode), close });
}
