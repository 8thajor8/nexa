import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCliAgent } from '../src/core/cli-agent.js';
import { resolveCliMemoryMode } from '../src/config.js';

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

function completed(text) {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

async function withStore(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-cli-read1-'));
    const storePath = path.join(directory, 'memory-v2.json');
    const bytes = Buffer.from(JSON.stringify(fixture, null, 2) + '\n');
    await writeFile(storePath, bytes);
    try { await callback({ directory, storePath, bytes }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test('CLI mode defaults to Memory1 and accepts explicit modes while rejecting unknown values', () => {
    assert.equal(resolveCliMemoryMode(undefined), 'memory1');
    assert.equal(resolveCliMemoryMode('memory1'), 'memory1');
    assert.equal(resolveCliMemoryMode('memory2-readonly'), 'memory2-readonly');
    assert.equal(resolveCliMemoryMode('memory2'), 'memory2');
    assert.throws(() => resolveCliMemoryMode('memory2-read-write'), /NEXA_MEMORY_BACKEND/u);
});

test('invalid CLI mode fails at composition instead of falling back to Memory1', async () => {
    await assert.rejects(createCliAgent({ memoryMode: 'memory2-typo' }), /NEXA_MEMORY_BACKEND/u);
});

test('Memory1 CLI composition remains the default and does not open a Memory2 store', async () => {
    const agent = await createCliAgent({ agentOptions: {
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        ask: async () => completed('Memory1 default.'), logger: () => {},
    } });
    try {
        assert.equal(agent.memoryBackend, 'memory1');
        assert.equal(await agent.run('Hola.'), 'Memory1 default.');
    } finally { await agent.close(); }
});

test('read-only CLI retrieves Memory2, keeps non-memory tools, blocks memory tool calls, and preserves store bytes', async () => {
    await withStore(async ({ directory, storePath, bytes }) => {
        const requests = [];
        const executions = [];
        let count = 0;
        const agent = await createCliAgent({ memoryMode: 'memory2-readonly', storePath, agentOptions: {
            ask: async request => {
                requests.push(structuredClone(request));
                count++;
                if (count === 1) return { status: 'completed', output: [
                    { type: 'function_call', name: 'remember', arguments: '{"text":"do not persist"}', call_id: 'memory-write' },
                ] };
                if (count === 2) return { status: 'completed', output: [
                    { type: 'function_call', name: 'open_url', arguments: '{"url":"https://example.invalid"}', call_id: 'external-tool' },
                ] };
                return completed('Solo usé contexto sintético.');
            },
            getTools: () => [
                { type: 'function', name: 'remember' }, { type: 'function', name: 'forget' },
                { type: 'function', name: 'recall' }, { type: 'function', name: 'open_url' },
            ],
            execute: async name => { executions.push(name); return { success: true }; },
            logger: () => {},
        } });
        try {
            assert.equal(agent.memoryBackend, 'memory2');
            assert.equal(await agent.run('¿Qué dice mi nota?'), 'Solo usé contexto sintético.');
            assert.equal(requests.length, 3);
            for (const request of requests) {
                assert.deepEqual(request.tools.map(tool => tool.name), ['open_url']);
                assert.ok(request.input.some(item => item.type === 'function_call_output'
                    && item.output.includes('Synthetic only fixture value.')));
            }
            const blocked = requests[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'memory-write');
            assert.equal(JSON.parse(blocked.output).error.code, 'memory_write_not_authorized');
            assert.deepEqual(executions, ['open_url']);
            assert.deepEqual(await readFile(storePath), bytes);
            assert.deepEqual(await readdir(directory), ['memory-v2.json']);
        } finally { await agent.close(); }
        assert.deepEqual(await readFile(storePath), bytes);
    });
});

test('environment selection opens only the explicitly configured store through the read-only reader', async () => {
    await withStore(async ({ directory, storePath, bytes }) => {
        const script = `
            import { createCliAgent } from './src/core/cli-agent.js';
            const agent = await createCliAgent({ agentOptions: { ask: async request => {
                console.log(JSON.stringify({ tools: request.tools, hasFixture: request.input.some(item => item.type === 'function_call_output' && item.output.includes('Synthetic only fixture value.')) }));
                return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic CLI response.' }] }], output_text: 'Synthetic CLI response.' };
            }, logger: () => {} } });
            try { console.log(agent.memoryBackend, await agent.run('¿Qué dice mi nota?')); }
            finally { await agent.close(); }
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
            env: { ...process.env, NEXA_MEMORY_BACKEND: 'memory2-readonly', NEXA_MEMORY2_STORE_PATH: storePath },
        });
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /"hasFixture":true/u);
        assert.match(child.stdout, /memory2 Synthetic CLI response\./u);
        assert.deepEqual(await readFile(storePath), bytes);
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
});

test('read-only CLI blocks direct memory and automatic-memory commands before model access', async () => {
    await withStore(async ({ directory, storePath, bytes }) => {
        const script = `
            import { createCliAgent } from './src/core/cli-agent.js';
            const agent = await createCliAgent({ memoryMode: 'memory2-readonly', storePath: ${JSON.stringify(storePath)}, agentOptions: { ask: async () => { throw new Error('model must not be called'); }, logger: () => {} } });
            try {
                console.log((await agent.readAndRun()).response);
                console.log((await agent.readAndRun()).response);
            } finally { await agent.close(); }
        `;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: process.cwd(),
            input: '/remember {"kind":"fact","subject":{"type":"owner"},"predicate":"user.note","object":{"type":"text","value":"never persist this"},"valid_from":null,"valid_to":null,"compatibility":{"category":"fact","key":"cli-test"}}\n/automatic-memory consent\n',
            encoding: 'utf8', timeout: 15000,
        });
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /comandos de memoria están deshabilitados/u);
        assert.equal(child.stdout.match(/comandos de memoria están deshabilitados/gu)?.length, 2);
        assert.deepEqual(await readFile(storePath), bytes);
        assert.deepEqual(await readdir(directory), ['memory-v2.json']);
    });
});

test('read-only CLI rejects relative, missing and invalid stores without creating files', async () => {
    await withStore(async ({ directory, storePath }) => {
        await assert.rejects(createCliAgent({ memoryMode: 'memory2-readonly', storePath: 'relative.json' }),
            /NEXA_MEMORY2_STORE_PATH must be an absolute path/u);
        await assert.rejects(createCliAgent({ memoryMode: 'memory2-readonly', storePath: path.join(directory, 'missing.json') }),
            { code: 'memory_store_missing' });
        await writeFile(storePath, '{not json');
        await assert.rejects(createCliAgent({ memoryMode: 'memory2-readonly', storePath }),
            { code: 'memory_store_invalid' });
        assert.deepEqual((await readdir(directory)).sort(), ['memory-v2.json']);
    });
});
