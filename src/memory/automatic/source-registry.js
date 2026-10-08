const SOURCE_POLICIES = Object.freeze({
    'user:direct': Object.freeze({ source: 'user:direct', dataType: 'user_assertion',
        memoryPolicy: 'candidate_only', freshness: 'turn_scoped' }),
    'api:lifeguard': Object.freeze({ source: 'api:lifeguard', dataType: 'financial_live',
        memoryPolicy: 'never_store', freshness: 'always_fetch' }),
    email: Object.freeze({ source: 'email', dataType: 'communication_content',
        memoryPolicy: 'never_store', freshness: 'always_fetch' }),
    calendar: Object.freeze({ source: 'calendar', dataType: 'schedule_live',
        memoryPolicy: 'never_store', freshness: 'always_fetch' }),
    memory: Object.freeze({ source: 'memory', dataType: 'retrieved_memory',
        memoryPolicy: 'never_store', freshness: 'repository_state' }),
    web: Object.freeze({ source: 'web', dataType: 'external_web_content',
        memoryPolicy: 'never_store', freshness: 'always_fetch' }),
    'tool:unclassified': Object.freeze({ source: 'tool:unclassified', dataType: 'unknown_external',
        memoryPolicy: 'never_store', freshness: 'unknown' }),
});

// These mappings describe the current read surfaces. They are selected from
// the trusted tool name by the runtime, never from payload-supplied metadata.
const TOOL_SOURCES = Object.freeze({
    get_email_connection_status: 'email', list_email_mailboxes: 'email',
    list_recent_emails: 'email', search_emails: 'email', get_email: 'email',
    list_calendar_events: 'calendar', get_calendar_event: 'calendar',
    search_web: 'web', web_search: 'web',
});

export function getAutomaticMemorySourcePolicy(sourceId) {
    if (typeof sourceId !== 'string') return SOURCE_POLICIES['tool:unclassified'];
    return SOURCE_POLICIES[sourceId] ?? SOURCE_POLICIES['tool:unclassified'];
}

export function getAutomaticMemoryToolSource(toolName) {
    if (typeof toolName !== 'string') return SOURCE_POLICIES['tool:unclassified'];
    const sourceId = TOOL_SOURCES[toolName];
    return SOURCE_POLICIES[sourceId] ?? SOURCE_POLICIES['tool:unclassified'];
}

export function listAutomaticMemorySourcePolicies() {
    return Object.freeze(Object.values(SOURCE_POLICIES));
}
