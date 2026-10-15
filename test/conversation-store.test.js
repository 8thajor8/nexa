import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore, ConversationStoreError } from '../src/core/conversation-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const code = expected => error => error instanceof ConversationStoreError && error.code === expected;

async function fixture(t, { fileSystem = {} } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-conversation-store-'));
    let tick = 0;
    const options = { baseDirectory: path.join(directory, 'user-data', 'conversations-data'), fileSystem,
        now: () => new Date(Date.UTC(2035, 0, 1, 0, 0, tick++)).toISOString() };
    const store = createConversationStore(options);
    t.after(async () => {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { directory, options, store };
}

test('creates UUID conversation metadata and recovers it after store reinstantiation', async t => {
    const f = await fixture(t);
    const created = await f.store.createConversation();
    assert.match(created.conversationId, UUID);
    assert.equal(created.title, 'Nueva conversación');
    assert.equal(created.version, 1);
    assert.equal(created.messageCount, 0);
    assert.equal(await f.store.getConversation(created.conversationId).then(value => value.createdAt), created.createdAt);
    const reopened = createConversationStore(f.options);
    assert.deepEqual(await reopened.getConversation(created.conversationId), created);
});

test('appends visible user and assistant messages with stable chronological sequence', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    const user = await f.store.appendMessage(conversation.conversationId, { role: 'user', content: 'Hola Nexa' });
    const assistant = await f.store.appendMessage(conversation.conversationId, { role: 'assistant', content: 'Hola.' });
    assert.equal(user.message.sequence, 1);
    assert.equal(assistant.message.sequence, 2);
    assert.ok(assistant.message.createdAt > user.message.createdAt);
    assert.equal(assistant.message.status, 'complete');
    const page = await f.store.listMessages(conversation.conversationId);
    assert.deepEqual(page.messages.map(item => item.id), [user.message.id, assistant.message.id]);
    assert.equal(page.nextCursor, null);
});

test('lists conversations by most recent activity with stable tie ordering', async t => {
    const f = await fixture(t);
    const first = await f.store.createConversation();
    const second = await f.store.createConversation();
    await f.store.appendMessage(first.conversationId, { role: 'user', content: 'Última actividad' });
    const page = await f.store.listConversations();
    assert.deepEqual(page.conversations.map(item => item.conversationId), [first.conversationId, second.conversationId]);
    assert.ok(page.conversations[0].updatedAt > page.conversations[1].updatedAt);
});

test('message pagination returns chronological pages without duplicate records', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    for (let index = 1; index <= 5; index++) {
        await f.store.appendMessage(conversation.conversationId, { role: index % 2 ? 'user' : 'assistant', content: `Mensaje ${index}` });
    }
    const newest = await f.store.listMessages(conversation.conversationId, { limit: 2 });
    const older = await f.store.listMessages(conversation.conversationId, { limit: 2, cursor: newest.nextCursor });
    const oldest = await f.store.listMessages(conversation.conversationId, { limit: 2, cursor: older.nextCursor });
    const sequences = [...oldest.messages, ...older.messages, ...newest.messages].map(item => item.sequence);
    assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
    assert.equal(new Set(sequences).size, 5);
    assert.equal(oldest.nextCursor, null);
});

test('serializes concurrent writes to one conversation', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    const writes = await Promise.all(Array.from({ length: 20 }, (_, index) => f.store.appendMessage(conversation.conversationId,
        { role: 'user', content: `Concurrent ${index}` })));
    assert.deepEqual(writes.map(item => item.message.sequence).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    const all = await f.store.listMessages(conversation.conversationId, { limit: 100 });
    assert.equal(all.messages.length, 20);
    assert.deepEqual(all.messages.map(item => item.sequence), Array.from({ length: 20 }, (_, i) => i + 1));
});

test('rejects invalid identifiers and never accepts a path as an identifier', async t => {
    const f = await fixture(t);
    await assert.rejects(f.store.getConversation('../../memory-v2.json'), code('conversation_id_invalid'));
    await assert.rejects(f.store.appendMessage('not-a-uuid', { role: 'user', content: 'x' }), code('conversation_id_invalid'));
    assert.deepEqual(await fs.readdir(path.join(f.directory, 'user-data')), ['conversations-data']);
});

test('rejects unknown roles, internal payload fields, empty text and oversized messages', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    await assert.rejects(f.store.appendMessage(conversation.conversationId, { role: 'tool', content: 'result' }), code('conversation_message_invalid'));
    await assert.rejects(f.store.appendMessage(conversation.conversationId, { role: 'assistant', content: 'ok', toolPayload: { secret: true } }), code('conversation_message_invalid'));
    await assert.rejects(f.store.appendMessage(conversation.conversationId, { role: 'user', content: '  ' }), code('conversation_message_invalid'));
    await assert.rejects(f.store.appendMessage(conversation.conversationId, { role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }), code('conversation_message_invalid'));
});

test('preserves and reports an incomplete final JSONL tail before continuing safely', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    const first = await f.store.appendMessage(conversation.conversationId, { role: 'user', content: 'Mensaje completo' });
    const messagesPath = path.join(f.options.baseDirectory, 'conversations', conversation.conversationId, 'messages.jsonl');
    const partial = Buffer.from('{"version":1,"content":"fragmento recuperable"', 'utf8');
    await fs.appendFile(messagesPath, partial);
    const read = await f.store.listMessages(conversation.conversationId);
    assert.equal(read.incompleteTail, true);
    assert.deepEqual(read.messages.map(item => item.id), [first.message.id]);
    const appended = await f.store.appendMessage(conversation.conversationId, { role: 'assistant', content: 'Continuación' });
    assert.equal(appended.recoveredIncompleteTail, true);
    const recoveryFiles = (await fs.readdir(path.dirname(messagesPath))).filter(name => name.startsWith('messages.jsonl.recovery-'));
    assert.equal(recoveryFiles.length, 1);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(messagesPath), recoveryFiles[0])), partial);
    const all = await f.store.listMessages(conversation.conversationId);
    assert.deepEqual(all.messages.map(item => item.content), ['Mensaje completo', 'Continuación']);
});

test('surfaces internal JSONL corruption without rewriting or dropping it', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    await f.store.appendMessage(conversation.conversationId, { role: 'user', content: 'Íntegro' });
    const messagesPath = path.join(f.options.baseDirectory, 'conversations', conversation.conversationId, 'messages.jsonl');
    const original = Buffer.concat([await fs.readFile(messagesPath), Buffer.from('{invalid}\n')]);
    await fs.writeFile(messagesPath, original);
    await assert.rejects(f.store.listMessages(conversation.conversationId), code('conversation_store_corrupt'));
    assert.deepEqual(await fs.readFile(messagesPath), original);
});

test('deletes only the selected conversation and returns false for a missing one', async t => {
    const f = await fixture(t);
    const first = await f.store.createConversation();
    const second = await f.store.createConversation();
    await f.store.appendMessage(first.conversationId, { role: 'user', content: 'Uno' });
    await f.store.appendMessage(second.conversationId, { role: 'user', content: 'Dos' });
    assert.equal(await f.store.deleteConversation(first.conversationId), true);
    assert.equal(await f.store.getConversation(first.conversationId), null);
    assert.equal(await f.store.getConversation(second.conversationId) !== null, true);
    assert.equal(await f.store.deleteConversation(first.conversationId), false);
});

test('missing conversation operations return stable not-found behavior', async t => {
    const f = await fixture(t);
    const absent = '11111111-1111-4111-8111-111111111111';
    assert.equal(await f.store.getConversation(absent), null);
    assert.equal(await f.store.deleteConversation(absent), false);
    await assert.rejects(f.store.appendMessage(absent, { role: 'user', content: 'Hola' }), code('conversation_not_found'));
    await assert.rejects(f.store.listMessages(absent), code('conversation_not_found'));
});

test('a failed log open reports persistence failure and a later write can recover', async t => {
    let failLogOpen = false;
    const injectedFs = { open: async (filePath, flags, mode) => {
        if (failLogOpen && String(filePath).endsWith('messages.jsonl') && flags === 'r+')
            throw Object.assign(new Error('injected write failure'), { code: 'EIO' });
        return fs.open(filePath, flags, mode);
    } };
    const f = await fixture(t, { fileSystem: injectedFs });
    const conversation = await f.store.createConversation();
    failLogOpen = true;
    await assert.rejects(f.store.appendMessage(conversation.conversationId, { role: 'user', content: 'Reintentar' }), code('conversation_persist_failed'));
    failLogOpen = false;
    const result = await f.store.appendMessage(conversation.conversationId, { role: 'user', content: 'Reintentar' });
    assert.equal(result.message.sequence, 1);
    assert.equal((await f.store.listMessages(conversation.conversationId)).messages.length, 1);
});

test('creates interrupted assistant markers without accepting empty completed messages', async t => {
    const f = await fixture(t);
    const conversation = await f.store.createConversation();
    await assert.rejects(f.store.appendMessage(conversation.conversationId, { role: 'assistant', content: '' }), code('conversation_message_invalid'));
    const marker = await f.store.appendMessage(conversation.conversationId, { role: 'assistant', content: '', status: 'interrupted' });
    assert.equal(marker.message.status, 'interrupted');
    assert.equal((await f.store.listMessages(conversation.conversationId)).messages[0].status, 'interrupted');
});
