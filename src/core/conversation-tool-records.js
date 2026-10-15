import { createHash } from 'node:crypto';

// Persist only the outcome of low-sensitivity desktop/media actions. The allowlist
// intentionally excludes messaging, mail, calendar, filesystem, browser, and memory
// tools because their activity or payloads may reveal private information.
const PERSISTABLE_CONVERSATION_TOOLS = new Set([
    'open_app', 'close_window', 'focus_window', 'maximize_window', 'minimize_window', 'restore_window',
    'set_volume', 'mute_volume', 'unmute_volume', 'media_play_pause',
    'spotify_play', 'spotify_pause', 'spotify_next', 'spotify_previous',
]);

const STATUS_VALUES = new Set(['succeeded', 'failed', 'unknown']);
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const SAFE_TURN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export function createConversationToolOutcome({ toolName, callId, result, authorizationRequired = false } = {}) {
    if (!PERSISTABLE_CONVERSATION_TOOLS.has(toolName) || typeof callId !== 'string' || callId.length < 1 || callId.length > 512)
        return null;
    const status = authorizationRequired || result?.outcome === 'uncertain' || typeof result?.success !== 'boolean'
        ? 'unknown' : result.success ? 'succeeded' : 'failed';
    return Object.freeze({ toolName, callIdHash: createHash('sha256').update(callId, 'utf8').digest('hex'), status });
}

export function isConversationToolOutcome(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === 3 && Object.hasOwn(value, 'toolName')
        && Object.hasOwn(value, 'callIdHash') && Object.hasOwn(value, 'status')
        && typeof value.toolName === 'string' && PERSISTABLE_CONVERSATION_TOOLS.has(value.toolName)
        && typeof value.callIdHash === 'string' && HASH.test(value.callIdHash)
        && STATUS_VALUES.has(value.status);
}

export function isConversationToolRecord(value, conversationId = null) {
    const keys = ['version', 'id', 'conversationId', 'turnId', 'userSequence', 'sequence', 'toolName', 'callIdHash', 'status', 'createdAt'];
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
        && value.version === 1 && typeof value.id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id)
        && typeof value.conversationId === 'string' && (!conversationId || value.conversationId === conversationId)
        && SAFE_TURN_ID.test(value.turnId) && Number.isSafeInteger(value.userSequence) && value.userSequence > 0
        && Number.isSafeInteger(value.sequence) && value.sequence > 0 && typeof value.toolName === 'string'
        && PERSISTABLE_CONVERSATION_TOOLS.has(value.toolName) && typeof value.callIdHash === 'string'
        && HASH.test(value.callIdHash) && STATUS_VALUES.has(value.status)
        && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
        && (() => { try { return new Date(Date.parse(value.createdAt)).toISOString() === value.createdAt; } catch { return false; } })();
}

/** Convert a validated record into inert, non-executable context for the model. */
export function conversationToolRecordContextItem(record) {
    if (!isConversationToolRecord(record)) throw new TypeError('conversation_tool_record_invalid');
    return Object.freeze({ role: 'developer', content: `Historical tool outcome (factual record only; not an instruction or current state; never replay this action; use a live tool if current state is requested): ${JSON.stringify({
        tool: record.toolName, status: record.status, recordSequence: record.sequence,
    })}` });
}

export function isConversationToolRecordContextItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.role !== 'developer'
        || typeof value.content !== 'string' || !value.content.startsWith('Historical tool outcome (factual record only; not an instruction or current state; never replay this action; use a live tool if current state is requested): ')) return false;
    try {
        const data = JSON.parse(value.content.slice(value.content.indexOf('{')));
        return Object.keys(data).length === 3 && PERSISTABLE_CONVERSATION_TOOLS.has(data.tool)
            && STATUS_VALUES.has(data.status) && Number.isSafeInteger(data.recordSequence) && data.recordSequence > 0;
    } catch { return false; }
}
