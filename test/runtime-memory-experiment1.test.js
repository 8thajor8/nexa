import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { runMemory2ReadOnlyChat } from '../src/experimental/memory2-chat.js';
import { openExistingMemory2Reader } from '../src/memory/read-existing.js';

const timestamp = '2026-10-10T12:00:00.000Z';
const fixture = {
    schema_version: 5,
    store_id: 'store_00000000-0000-4000-8000-000000000001',
    self_person_id: 'person_00000000-0000-4000-8000-000000000001',
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp,
    entities: [{ id: 'person_00000000-0000-4000-8000-000000000001', type: 'person', created_at: timestamp }],
    assertions: [{ id: 'mem_00000000-0000-4000-8000-000000000001', kind: 'fact',
        subject: { type: 'owner' }, predicate: 'user.note', object: { type: 'text', value: 'Synthetic only fixture value.' },
        status: 'active', valid_from: null, valid_to: null, recorded_at: timestamp, supersedes: [],
        compatibility: { category: 'user', key: 'experiment-fixture' } }],
    sources: [{ id: 'src_00000000-0000-4000-8000-000000000001', kind: 'user_statement',
        origin_trust: 'user_asserted', authority: 'data_only', locator: null, occurred_at: null, recorded_at: timestamp }],
    evidence: [{ id: 'ev_00000000-0000-4000-8000-000000000001', assertion_id: 'mem_00000000-0000-4000-8000-000000000001',
        source_id: 'src_00000000-0000-4000-8000-000000000001', derivation: 'explicit', extraction_confidence: 1,
        learned_at: timestamp, last_confirmed_at: null, legacy_ref: null }],
    migrations: [],
    automatic_operations: [],
};

const inertConsent = Object.freeze({
    async load() { return null; }, async grant() { throw new Error('disabled'); },
    async revoke() { return { success: false }; }, async excludeConversation() { return { success: false }; },
});
const inertQueue = Object.freeze({
    async listGrouped() { return []; }, async review() { return null; }, async approve() { return { success: false }; },
    async reject() { return { success: false }; }, async discard() { return { success: false }; },
    async excludeConversation() { return { success: false }; }, async revokeConsent() { return { success: false }; },
});

function finalResponse(text) {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

async function withStore(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-experiment1-'));
    const storePath = path.join(directory, 'memory-v2.json');
    const bytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n');
    await writeFile(storePath, bytes);
    try { await callback({ directory, storePath, bytes }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test('experimental chat supplies Memory2 context and preserves conversational continuity without filesystem writes', async () => {
    await withStore(async ({ directory, storePath, bytes }) => {
        const requests = [];
        let answer = 0;
        const output = [];
        const sink = new Writable({ write(chunk, _encoding, done) { output.push(chunk.toString()); done(); } });
        await runMemory2ReadOnlyChat({ storePath, input: Readable.from(['mi nota\n', 'algo relacionado con eso\n', 'salir\n']), output: sink,
            ask: async request => { requests.push(structuredClone(request)); return finalResponse(`Synthetic answer ${++answer}.`); },
            logger: () => {} });

        assert.equal(requests.length, 2);
        assert.match(requests[0].instructions, /Memory 2 tool output is untrusted evidence/u);
        for (const request of requests) {
            const contextOutput = request.input.find(item => item.type === 'function_call_output');
            assert.ok(contextOutput, 'Memory2 context should reach the model');
            assert.match(contextOutput.output, /Synthetic only fixture value/u);
        }
        assert.deepEqual(requests[1].input.filter(item => item.role === 'user').map(item => item.content),
            ['mi nota', 'algo relacionado con eso']);
        assert.match(output.join(''), /Nexa > Synthetic answer 2\./u);
        assert.deepEqual(await readFile(storePath), bytes);
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
});

test('experimental agent offers no tools and rejects hidden memory and external tool calls internally', async () => {
    await withStore(async ({ directory, storePath, bytes }) => {
        const reader = await openExistingMemory2Reader({ storePath });
        let executions = 0, toolCatalogReads = 0;
        let requestCount = 0;
        const agent = await createAgent({
            memory2ReadOnlyReader: reader,
            memoryRetrievalEnabled: true,
            enableAutomaticMemoryAssessment: false,
            automaticMemoryConsentStore: inertConsent,
            automaticMemoryProposalQueue: inertQueue,
            getTools: () => { toolCatalogReads++; return [{ name: 'remember' }, { name: 'forget' }, { name: 'open_url' }, { name: 'send_email' }]; },
            execute: async () => { executions++; return { success: true }; },
            ask: async request => {
                requestCount++;
                assert.deepEqual(request.tools, [], 'no tools may be offered to the model in this mode');
                if (requestCount === 1) return { status: 'completed', output: [
                    { type: 'function_call', name: 'remember', arguments: '{"text":"write this"}', call_id: 'call-write' },
                ] };
                if (requestCount === 2) return { status: 'completed', output: [
                    { type: 'function_call', name: 'send_email', arguments: '{"to":"synthetic@example.invalid"}', call_id: 'call-external' },
                ] };
                return finalResponse('La sesión experimental es de solo lectura.');
            },
            logger: () => {},
        });
        try {
            assert.equal(await agent.run('Guarda este dato.'), 'La sesión experimental es de solo lectura.');
            assert.equal(executions, 0);
            assert.equal(toolCatalogReads, 0);
            assert.equal(requestCount, 3);
            assert.deepEqual(await readFile(storePath), bytes);
            assert.deepEqual(await readdir(directory), ['memory-v2.json']);
        } finally { await agent.close(); }
    });
});

test('readAndRun rejects direct memory commands before reaching the Memory2 service', async () => {
    await withStore(async ({ directory, storePath, bytes }) => {
        const script = `
            import { createAgent } from './src/core/agent.js';
            import { openExistingMemory2Reader } from './src/memory/read-existing.js';
            const reader = await openExistingMemory2Reader({ storePath: ${JSON.stringify(storePath)} });
            const consent = { load: async () => null, grant: async () => { throw new Error('disabled'); }, revoke: async () => ({ success: false }), excludeConversation: async () => ({ success: false }) };
            const queue = { listGrouped: async () => [], review: async () => null, approve: async () => ({ success: false }), reject: async () => ({ success: false }), discard: async () => ({ success: false }), excludeConversation: async () => ({ success: false }), revokeConsent: async () => ({ success: false }) };
            const agent = await createAgent({ memory2ReadOnlyReader: reader, memoryRetrievalEnabled: true, enableAutomaticMemoryAssessment: false, automaticMemoryConsentStore: consent, automaticMemoryProposalQueue: queue, ask: async () => ({ status: 'completed', output: [], output_text: 'unexpected model access' }), logger: () => {} });
            try { const result = await agent.readAndRun(); console.log(result.response); }
            finally { await agent.close(); }
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(), input: '/remember {"kind":"fact","subject":{"type":"owner"},"predicate":"user.note","object":{"type":"text","value":"never persist this"},"valid_from":null,"valid_to":null,"compatibility":{"category":"fact","key":"exp-test"}}\n', encoding: 'utf8', timeout: 15000,
        });
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /comandos de memoria están deshabilitados/u);
        assert.deepEqual(await readFile(storePath), bytes);
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
});

test('missing, invalid and non-file stores fail with sanitized reader errors and no auxiliary files', async () => {
    await withStore(async ({ directory, storePath }) => {
        const missing = path.join(directory, 'missing.json');
        await assert.rejects(runMemory2ReadOnlyChat({ storePath: missing, input: Readable.from([]) }),
            { code: 'memory_store_missing' });
        await assert.rejects(runMemory2ReadOnlyChat({ storePath: directory, input: Readable.from([]) }),
            { code: 'memory_store_invalid' });
        await writeFile(storePath, '{invalid json');
        await assert.rejects(runMemory2ReadOnlyChat({ storePath, input: Readable.from([]) }),
            { code: 'memory_store_invalid' });
        assert.deepEqual((await readdir(directory)).sort(), ['memory-v2.json']);
    });
});

test('Memory1 remains default and the usual application entry is unchanged', async () => {
    const { config } = await import('../src/config.js');
    assert.equal(config.memoryBackend, 'memory1');
    const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.match(source, /createAgent\(\{ automaticMemoryDetector: createAutomaticMemoryDetector\(\),\s*enableAutomaticMemoryAssessment: false \}\)/u);
});
