const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_CHARACTERS = 12_000;

export function normalizeConversationContextPolicy(policy = {}) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
        throw new TypeError('conversation_history_budget_invalid');
    const maxMessages = policy.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const maxCharacters = policy.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0 || maxMessages > 100
        || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 100_000) {
        throw new TypeError('conversation_history_budget_invalid');
    }
    return Object.freeze({ maxMessages, maxCharacters });
}

function completeToolProtocols(items) {
    const callIds = new Set(items.filter(item => item?.type === 'function_call'
        && typeof item.call_id === 'string').map(item => item.call_id));
    const outputIds = new Set(items.filter(item => item?.type === 'function_call_output'
        && typeof item.call_id === 'string').map(item => item.call_id));
    return items.filter(item => {
        if (item?.type === 'function_call') return outputIds.has(item.call_id);
        if (item?.type === 'function_call_output') return callIds.has(item.call_id);
        return true;
    });
}

function conversationTurns(items) {
    const turns = [];
    let turn = null;
    for (const item of items) {
        if (item?.role === 'user') {
            if (turn) turns.push(completeToolProtocols(turn));
            turn = [item];
        } else if (turn) turn.push(item);
    }
    if (turn) turns.push(completeToolProtocols(turn));
    return turns.filter(group => group.length > 0);
}

function cost(turns) {
    const items = turns.flat();
    return {
        messages: items.filter(item => item?.role === 'user' || item?.role === 'assistant').length,
        characters: JSON.stringify(items).length,
    };
}

function hasRecoverableOutcome(turn) {
    if (turn.some(item => item?.role === 'assistant')) return true;
    const calls = new Set(turn.filter(item => item?.type === 'function_call')
        .map(item => item.call_id).filter(id => typeof id === 'string'));
    return turn.some(item => item?.type === 'function_call_output' && calls.has(item.call_id));
}

/**
 * Select recent complete conversation turns under a shared message/serialized-character
 * budget. The current in-flight turn is retained whole and is outside the historical
 * budget so its user message and any completed tool round cannot be truncated.
 */
export function selectConversationContext(items, policy = {}, { currentTurnStartIndex = null } = {}) {
    if (!Array.isArray(items)) throw new TypeError('conversation_history_invalid');
    const normalizedPolicy = normalizeConversationContextPolicy(policy);
    const turns = conversationTurns(items);
    let currentTurnIndex = -1;
    if (Number.isSafeInteger(currentTurnStartIndex) && currentTurnStartIndex >= 0) {
        currentTurnIndex = turns.findIndex(turn => turn[0] === items[currentTurnStartIndex]);
    }
    const historicalTurns = (currentTurnIndex >= 0 ? turns.slice(0, currentTurnIndex) : turns)
        .filter(hasRecoverableOutcome);
    const currentTurn = currentTurnIndex >= 0 ? turns.slice(currentTurnIndex) : [];
    const selected = [];
    let messageCount = 0;
    let characterCount = 0;
    for (let index = historicalTurns.length - 1; index >= 0; index--) {
        const candidate = historicalTurns[index];
        const candidateCost = cost([candidate]);
        if (messageCount + candidateCost.messages > normalizedPolicy.maxMessages
            || characterCount + candidateCost.characters > normalizedPolicy.maxCharacters) break;
        selected.unshift(candidate);
        messageCount += candidateCost.messages;
        characterCount += candidateCost.characters;
    }
    return Object.freeze([...selected, ...currentTurn].flat().map(item => Object.freeze(structuredClone(item))));
}

export const DEFAULT_CONVERSATION_CONTEXT_POLICY = Object.freeze({
    maxMessages: DEFAULT_MAX_MESSAGES,
    maxCharacters: DEFAULT_MAX_CHARACTERS,
});
