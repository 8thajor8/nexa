import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { initializeEmptyMemoryStore } from '../src/memory/backend.js';
import { hasExplicitMemoryWriteIntent, hasMemoryTransitionIntent, parseMemoryCommand } from '../src/memory/commands.js';
import { validateMemoryStore } from '../src/memory/schema.js';

const initial = 'Mi editor de prueba favorito es Neovim.';
const update = 'Nexa, cambié de editor. Ahora prefiero VS Code';
const query = '¿Qué editor de prueba prefiero?';

function final(text = 'Respuesta sintética.') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

function options(ask = async () => final()) {
    return { getTools: () => [], ask, logger: () => {},
        load: async () => { throw new Error('Memory1 must not be opened in confirmed-write mode'); },
        save: async () => { throw new Error('Memory1 must not be saved in confirmed-write mode'); } };
}

function runtime(storePath, ask) {
    return createConversationRuntime({ memoryMode: 'memory2-confirmed-write', storePath,
        agentOptions: { ...options(ask), allowConfirmedMemoryWrites: true } });
}

async function send(instance, conversationId, text, requestId) {
    const result = await instance.sendMessage({ conversationId, requestId, text, source: 'typed' });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return result.text;
}

async function withStore(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-memory-confirmed-update-'));
    const storePath = path.join(directory, 'schema-v5.json');
    await initializeEmptyMemoryStore({ storePath });
    try { await callback({ directory, storePath }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

async function seedEditor(instance, conversationId, value, suffix) {
    await send(instance, conversationId, `Nexa, recordá que ${value}`, `${suffix}-preview`);
    assert.match(await send(instance, conversationId, 'sí', `${suffix}-confirm`), /lo guardé|me acuerdo/u);
}

function retrievedAssertions(request) {
    const raw = request.input.find(item => item?.type === 'function_call_output'
        && item.call_id?.startsWith('memory_context_'))?.output;
    return raw ? JSON.parse(raw).assertions : [];
}

function answerFromContext(request) {
    const values = retrievedAssertions(request).map(item => item.object.value);
    return final(values.join(' ') || 'No tengo información suficiente en los recuerdos disponibles.');
}

test('explicit editor corrections bind the current memory, confirm once, preserve history, and survive Runtime restart', async () => {
    await withStore(async ({ storePath }) => {
        const requests = [];
        const ask = async request => { requests.push(request); return answerFromContext(request); };
        let instance = runtime(storePath, ask);
        const conversationId = instance.createConversation();
        await seedEditor(instance, conversationId, initial, 'update-seed');
        let contents = JSON.parse(await readFile(storePath, 'utf8'));
        const old = contents.assertions.find(item => item.status === 'active');
        assert.equal(old.object.value, initial);
        const beforeProposal = await readFile(storePath);

        const proposal = await send(instance, conversationId, update, 'update-proposal');
        assert.match(proposal, /VS Code/u);
        assert.match(proposal, /¿La actualizo/u);
        assert.doesNotMatch(proposal, /Tengo registrado «Mi editor de prueba favorito/u);
        assert.deepEqual(await readFile(storePath), beforeProposal, 'proposal must not write before confirmation');

        assert.equal(await send(instance, conversationId, 'sí', 'update-confirm'), 'Listo, actualicé tu preferencia.');
        contents = JSON.parse(await readFile(storePath, 'utf8'));
        validateMemoryStore(contents);
        const current = contents.assertions.filter(item => item.status === 'active');
        const previous = contents.assertions.find(item => item.id === old.id);
        assert.equal(current.length, 1);
        assert.equal(current[0].object.value, 'Mi editor de prueba favorito es VS Code.');
        assert.equal(current[0].supersedes.length, 1);
        assert.equal(current[0].supersedes[0], old.id);
        assert.equal(previous.status, 'superseded');
        assert.equal(contents.sources.length, 2);
        assert.equal(contents.evidence.length, 2);
        assert.equal(contents.revision, 2);

        const sameConversationAnswer = await send(instance, conversationId, query, 'update-query-current');
        assert.match(sameConversationAnswer, /VS Code/u);
        assert.doesNotMatch(sameConversationAnswer, /Neovim/u);
        assert.deepEqual(retrievedAssertions(requests.at(-1)).map(item => item.object.value), [current[0].object.value]);
        await instance.close();

        instance = runtime(storePath, ask);
        const restartedConversation = instance.createConversation();
        const afterRestart = await send(instance, restartedConversation, query, 'update-query-restarted');
        assert.match(afterRestart, /VS Code/u);
        assert.doesNotMatch(afterRestart, /Neovim/u);
        assert.deepEqual(retrievedAssertions(requests.at(-1)).map(item => item.object.value), [current[0].object.value]);
        await instance.close();
    });
});

test('only explicit editor-update language is parsed; an affirmation alone does not update', async () => {
    assert.deepEqual(parseMemoryCommand(update), { operation: 'update_editor_preference', newValue: 'VS Code', oldValue: null });
    assert.deepEqual(parseMemoryCommand('Nexa, ya no prefiero Neovim; ahora uso VS Code'),
        { operation: 'update_editor_preference', newValue: 'VS Code', oldValue: 'Neovim' });
    assert.equal(parseMemoryCommand('Prefiero VS Code'), null);
    assert.equal(parseMemoryCommand('sí'), null);
    assert.equal(hasMemoryTransitionIntent('Me pasé de Chrome a Firefox'), true);
    assert.equal(hasMemoryTransitionIntent('Últimamente prefiero TypeScript en lugar de JavaScript'), true);
    assert.equal(hasMemoryTransitionIntent('¿Cuál es mi editor habitual?'), false);
    assert.equal(hasExplicitMemoryWriteIntent('¿Qué recordás exactamente sobre mis editores de código?'), false,
        'the conjugated question “recordás” is not the imperative “recordá”');
    assert.equal(hasExplicitMemoryWriteIntent('¿Qué tenés guardado sobre mis preferencias?'), false);
    assert.equal(hasExplicitMemoryWriteIntent('Acordate que mi editor habitual es Zed.'), true);
    await withStore(async ({ storePath }) => {
        const instance = runtime(storePath);
        const conversationId = instance.createConversation();
        await send(instance, conversationId, 'sí', 'update-no-proposal-yes');
        const contents = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(contents.revision, 0);
        assert.deepEqual(contents.assertions, []);
        await instance.close();
    });
});

test('cancel, expired, duplicate, and wrong-conversation confirmations do not update the target', async () => {
    await withStore(async ({ storePath }) => {
        const instance = runtime(storePath);
        const ownerConversation = instance.createConversation();
        const otherConversation = instance.createConversation();
        await seedEditor(instance, ownerConversation, initial, 'update-negative-seed');
        const seeded = JSON.parse(await readFile(storePath, 'utf8'));

        await send(instance, ownerConversation, update, 'update-cancel-proposal');
        assert.match(await send(instance, ownerConversation, 'no', 'update-cancel'), /no actualic[eé] la preferencia/iu);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, seeded.revision);

        await send(instance, ownerConversation, update, 'update-expired-proposal');
        const originalNow = Date.now;
        try {
            Date.now = () => originalNow() + 121_000;
            assert.match(await send(instance, ownerConversation, 'sí', 'update-expired-confirm'), /venci[oó]/iu);
        } finally { Date.now = originalNow; }
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, seeded.revision);

        await send(instance, ownerConversation, update, 'update-cross-proposal');
        const wrongConversation = await instance.sendMessage({ conversationId: otherConversation,
            requestId: 'update-wrong-conversation-confirm', text: 'sí', source: 'typed' });
        assert.equal(wrongConversation.status, 'error');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, seeded.revision);
        assert.equal(await send(instance, ownerConversation, 'sí', 'update-cross-owner-confirm'), 'Listo, actualicé tu preferencia.');
        const revision = JSON.parse(await readFile(storePath, 'utf8')).revision;
        await send(instance, ownerConversation, 'sí', 'update-duplicate-confirm');
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, revision);
        await instance.close();
    });
});

test('missing or ambiguous editor memories are not selected or changed', async () => {
    await withStore(async ({ storePath }) => {
        let instance = runtime(storePath);
        let conversationId = instance.createConversation();
        assert.match(await send(instance, conversationId, update, 'update-missing-target'), /No encontré/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, 0);
        await instance.close();

        instance = runtime(storePath);
        conversationId = instance.createConversation();
        await seedEditor(instance, conversationId, 'Mi editor favorito es Neovim', 'update-ambiguous-seed-a');
        const exactTargetRevision = JSON.parse(await readFile(storePath, 'utf8')).revision;
        assert.match(await send(instance, conversationId, 'Nexa, ya no prefiero Sublime Text; ahora prefiero VS Code',
            'update-wrong-previous-value'), /no encontré un recuerdo vigente/iu);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, exactTargetRevision);
        await seedEditor(instance, conversationId, 'Mi editor de prueba favorito es Sublime Text', 'update-ambiguous-seed-b');
        const revision = JSON.parse(await readFile(storePath, 'utf8')).revision;
        assert.match(await send(instance, conversationId, update, 'update-ambiguous'), /varios recuerdos vigentes/u);
        assert.equal(JSON.parse(await readFile(storePath, 'utf8')).revision, revision);
        await instance.close();
    });
});

test('failed persistence never claims a successful update', async () => {
    await withStore(async ({ storePath }) => {
        const instance = runtime(storePath);
        const conversationId = instance.createConversation();
        await seedEditor(instance, conversationId, initial, 'update-failure-seed');
        await send(instance, conversationId, update, 'update-failure-proposal');
        await writeFile(storePath, '{invalid synthetic fixture}', 'utf8');
        const response = await send(instance, conversationId, 'sí', 'update-failure-confirm');
        assert.match(response, /No pude actualizar la preferencia/u);
        assert.doesNotMatch(response, /actualic[eé]/iu);
        await instance.close();
    });
});

test('a target changed after the preview is rejected without overwriting the newer store state', async () => {
    await withStore(async ({ storePath }) => {
        const instance = runtime(storePath);
        const conversationId = instance.createConversation();
        await seedEditor(instance, conversationId, initial, 'update-stale-seed');
        await send(instance, conversationId, update, 'update-stale-proposal');
        const external = JSON.parse(await readFile(storePath, 'utf8'));
        const current = external.assertions.find(item => item.status === 'active');
        current.object.value = 'Mi editor de prueba favorito es otro editor.';
        await writeFile(storePath, JSON.stringify(external, null, 2) + '\n', 'utf8');

        const response = await send(instance, conversationId, 'sí', 'update-stale-confirm');
        assert.match(response, /No pude actualizar la preferencia/u);
        assert.doesNotMatch(response, /Listo, actualic[eé]/iu);
        const after = JSON.parse(await readFile(storePath, 'utf8'));
        assert.equal(after.revision, 1);
        assert.equal(after.assertions.length, 1);
        assert.equal(after.assertions[0].status, 'active');
        assert.equal(after.assertions[0].object.value, 'Mi editor de prueba favorito es otro editor.');
        await instance.close();
    });
});

test('read-only Memory2 rejects explicit updates without changing the fixture', async () => {
    await withStore(async ({ storePath }) => {
        const setup = runtime(storePath);
        const setupConversation = setup.createConversation();
        await seedEditor(setup, setupConversation, initial, 'update-readonly-seed');
        await setup.close();
        const before = await readFile(storePath);
        const instance = createConversationRuntime({ memoryMode: 'memory2-readonly', storePath,
            agentOptions: { ...options(), getTools: () => [] } });
        const conversationId = instance.createConversation();
        await send(instance, conversationId, update, 'update-readonly-attempt');
        await send(instance, conversationId, 'sí', 'update-readonly-confirm');
        await instance.close();
        assert.deepEqual(await readFile(storePath), before);
    });
});
