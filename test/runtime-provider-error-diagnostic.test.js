import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';

function errorWith(fields = {}) {
    const error = new Error('sensitive prompt body must not be logged');
    Object.assign(error, fields, {
        headers: { authorization: 'Bearer synthetic-secret-token' },
        request: { body: 'synthetic private prompt' },
        body: { message: 'provider body must not be logged' },
    });
    return error;
}

async function runFailure(caughtError, { rejectAgent = false } = {}) {
    const events = [];
    const runtime = createConversationRuntime({ diagnostic: event => events.push(event),
        agentFactory: async () => {
            if (rejectAgent) throw caughtError;
            return { run: async () => { throw caughtError; }, async close() {} };
        },
    });
    try {
        const conversationId = runtime.createConversation();
        const result = await runtime.sendMessage({ conversationId, requestId: 'provider-diagnostic-test',
            text: 'synthetic question', source: 'typed' });
        assert.equal(result.error.code, 'agent_error');
        assert.equal(result.error.message, 'The conversation request failed.');
        assert.deepEqual(result.error, { code: 'agent_error', message: 'The conversation request failed.' });
        return events.find(event => event.event === 'request_failed');
    } finally {
        await runtime.close();
    }
}

test('Runtime emits allowlisted, sanitized categories for provider and internal failures', async () => {
    const cases = [
        { error: errorWith({ name: 'AuthenticationError', status: 401, code: 'invalid_api_key' }),
            expected: { outcome: 'authentication', stage: 'agent_run', providerStatus: 401, errorCode: 'invalid_api_key' } },
        { error: errorWith({ name: 'NotFoundError', status: 404, code: 'model_not_found' }),
            expected: { outcome: 'model_unavailable', stage: 'agent_run', providerStatus: 404, errorCode: 'model_not_found' } },
        { error: errorWith({ name: 'RateLimitError', status: 429, code: 'insufficient_quota' }),
            expected: { outcome: 'quota', stage: 'agent_run', providerStatus: 429, errorCode: 'insufficient_quota' } },
        { error: errorWith({ name: 'RateLimitError', status: 429, code: 'rate_limit_exceeded' }),
            expected: { outcome: 'rate_limited', stage: 'agent_run', providerStatus: 429, errorCode: 'rate_limit_exceeded' } },
        { error: errorWith({ name: 'APIConnectionTimeoutError', code: 'ETIMEDOUT' }),
            expected: { outcome: 'transport', stage: 'agent_run', providerStatus: null, errorCode: null } },
        { error: errorWith({ name: 'BadRequestError', status: 400, code: 'unsupported_parameter' }),
            expected: { outcome: 'request_rejected', stage: 'agent_run', providerStatus: 400, errorCode: 'unsupported_parameter' } },
        { error: errorWith({ name: 'UnexpectedPrivateError', code: 'private_prompt_value' }),
            expected: { outcome: 'internal', stage: 'agent_run', providerStatus: null, errorCode: null } },
    ];

    for (const item of cases) {
        const event = await runFailure(item.error);
        assert.ok(event);
        for (const [key, value] of Object.entries(item.expected)) assert.equal(event[key], value);
        assert.equal(event.errorName === 'UnexpectedPrivateError', false);
        const serialized = JSON.stringify(event);
        assert.doesNotMatch(serialized, /sensitive prompt body|synthetic-secret-token|synthetic private prompt|provider body|private_prompt_value|authorization/iu);
        assert.deepEqual(Object.keys(event).sort(), ['area', 'conversationId', 'durationMs', 'errorCode',
            'errorName', 'event', 'outcome', 'providerStatus', 'requestId', 'stage'].sort());
    }
});

test('Runtime labels failures before provider execution as initialization and keeps diagnostics sanitized', async () => {
    const error = errorWith({ name: 'UnexpectedPrivateError', code: 'credential_fragment' });
    const event = await runFailure(error, { rejectAgent: true });
    assert.equal(event.stage, 'agent_initialization');
    assert.equal(event.outcome, 'internal');
    assert.equal(event.errorCode, null);
    assert.doesNotMatch(JSON.stringify(event), /credential_fragment|synthetic-secret-token|private prompt/iu);
});

test('agent initialization emits only sanitized local diagnostic fields and keeps the public error generic', async () => {
    const traces = [];
    const error = Object.assign(new Error("Cannot find package 'nexa-runtime' imported from C:\\Users\\morsi\\private folder\\entry.js"), {
        code: 'ERR_MODULE_NOT_FOUND',
        headers: { authorization: 'Bearer synthetic-secret-token' },
        request: { body: 'private conversation text' },
    });
    const runtime = createConversationRuntime({ diagnostic: event => traces.push(event),
        agentFactory: async () => { throw error; },
    });
    try {
        const conversationId = runtime.createConversation();
        const result = await runtime.sendMessage({ conversationId, requestId: 'init-sanitized-test',
            text: 'synthetic question', source: 'typed' });
        assert.deepEqual(result.error, { code: 'agent_error', message: 'The conversation request failed.' });
        const diagnostic = traces.find(event => event.event === 'agent_initialization_error');
        assert.deepEqual(diagnostic, {
            area: 'conversation_runtime', event: 'agent_initialization_error', stage: 'agent_initialization',
            errorName: 'Error', errorCode: 'ERR_MODULE_NOT_FOUND',
            initializationMessage: "Cannot find package '[redacted]' imported from [path]",
        });
        assert.doesNotMatch(JSON.stringify(diagnostic), /morsi|nexa-runtime|synthetic-secret-token|private conversation|authorization/iu);
    } finally {
        await runtime.close();
    }
});

test('agent initialization exposes only allowlisted Memory2 error class and code, never its message', async () => {
    for (const [name, code] of [
        ['MemoryBackendStartupError', 'memory_store_unreadable'],
        ['MemoryBackendStartupError', 'memory_store_locked'],
        ['MemoryBackendStartupError', 'memory_uninitialized'],
        ['MemoryBackendStartupError', 'memory_store_corrupt'],
        ['MemoryBackendStartupError', 'memory_lock_lost'],
        ['Memory2ExistingReaderError', 'memory_schema_unsupported'],
    ]) {
        const traces = [];
        const error = Object.assign(new Error(`Private store path C:\\Users\\morsi\\private\\memory-v2.json ${code}`),
            { name, code, path: 'C:\\Users\\morsi\\private\\memory-v2.json' });
        const runtime = createConversationRuntime({ diagnostic: event => traces.push(event),
            agentFactory: async () => { throw error; },
        });
        try {
            const conversationId = runtime.createConversation();
            const result = await runtime.sendMessage({ conversationId, requestId: `memory-init-${code}`,
                text: 'synthetic question', source: 'typed' });
            assert.deepEqual(result.error, { code: 'agent_error', message: 'The conversation request failed.' });
            const diagnostic = traces.find(event => event.event === 'agent_initialization_error');
            assert.equal(diagnostic?.errorName, name);
            assert.equal(diagnostic?.errorCode, code);
            assert.equal(diagnostic?.initializationMessage, null);
            assert.doesNotMatch(JSON.stringify(diagnostic), /morsi|private|memory-v2\.json|Private store path/iu);
        } finally {
            await runtime.close();
        }
    }
});

test('provider errors pass through the shared read-only agent and remain sanitized at both diagnostic boundaries', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-provider-error-diagnostic-'));
    const storePath = path.join(directory, 'synthetic-schema-v5.json');
    const timestamp = '2026-10-12T00:00:00.000Z';
    const owner = 'person_00000000-0000-4000-8000-000000000001';
    const originalStore = Buffer.from(JSON.stringify({ schema_version: 5,
        store_id: 'store_00000000-0000-4000-8000-000000000001', self_person_id: owner,
        revision: 1, created_at: timestamp, updated_at: timestamp,
        entities: [{ id: owner, type: 'person', created_at: timestamp }], assertions: [],
        sources: [], evidence: [], migrations: [], automatic_operations: [],
    }));
    await writeFile(storePath, originalStore);
    const runtimeEvents = [];
    const agentEvents = [];
    const providerError = errorWith({ name: 'AuthenticationError', status: 401, code: 'invalid_api_key' });
    const runtime = createConversationRuntime({ memoryMode: 'memory2-readonly', storePath,
        diagnostic: event => runtimeEvents.push(event),
        agentOptions: {
            load: async () => { throw new Error('memory1_must_not_open'); },
            getTools: () => [],
            logger: (event, details) => agentEvents.push({ event, ...details }),
            ask: async () => { throw providerError; },
        },
    });
    try {
        const conversationId = runtime.createConversation();
        const result = await runtime.sendMessage({ conversationId, requestId: 'provider-diagnostic-agent-test',
            text: 'synthetic question', source: 'typed' });
        assert.equal(result.status, 'error');
        const failure = runtimeEvents.find(event => event.event === 'request_failed');
        assert.equal(failure?.outcome, 'authentication');
        assert.equal(failure?.stage, 'agent_run');
        assert.ok(agentEvents.some(event => event.event === 'model_request_started'));
        const agentFailure = agentEvents.find(event => event.event === 'agent_run_failed');
        assert.deepEqual(agentFailure, { event: 'agent_run_failed', stage: 'agent_run', requestId: 'provider-diagnostic-agent-test' });
        const serialized = JSON.stringify({ runtimeEvents, agentEvents });
        assert.doesNotMatch(serialized, /sensitive prompt body|synthetic-secret-token|synthetic private prompt|provider body|authorization/iu);
        assert.deepEqual(await readFile(storePath), originalStore);
    } finally {
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
    }
});
