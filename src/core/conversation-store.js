import * as nativeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isConversationToolOutcome, isConversationToolRecord } from './conversation-tool-records.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MANIFEST_NAME = 'manifest.json';
const MESSAGES_NAME = 'messages.jsonl';
const TOOL_RECORDS_NAME = 'tool-outcomes.jsonl';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const PAGE_SIZE_MAX = 100;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_TOOL_RECORDS = 512;
const MAX_TOOL_RECORDS_BYTES = 256 * 1024;

const ERROR_MESSAGES = Object.freeze({
    conversation_store_invalid: 'Conversation store configuration is invalid.',
    conversation_id_invalid: 'Conversation identifier is invalid.',
    conversation_message_invalid: 'Conversation message is invalid.',
    conversation_page_invalid: 'Conversation page request is invalid.',
    conversation_not_found: 'Conversation does not exist.',
    conversation_store_corrupt: 'Conversation data is corrupt and was not changed.',
    conversation_store_unavailable: 'Conversation data is unavailable.',
    conversation_persist_failed: 'Conversation data could not be saved.',
    conversation_commit_uncertain: 'The conversation write could not be confirmed.',
    conversation_id_collision: 'A unique conversation could not be created.',
    conversation_title_invalid: 'Conversation title is invalid.',
    conversation_tool_record_invalid: 'Conversation tool record is invalid.',
});
const MESSAGE_VALIDATION_REASONS = new Set(['invalid_shape', 'invalid_role', 'content_not_string',
    'content_too_large', 'disallowed_control_character', 'empty_content', 'invalid_status']);

export class ConversationStoreError extends Error {
    constructor(code, { cause, validationReason } = {}) {
        super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.conversation_store_unavailable,
            cause === undefined ? undefined : { cause });
        this.name = 'ConversationStoreError';
        this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'conversation_store_unavailable';
        if (MESSAGE_VALIDATION_REASONS.has(validationReason)) this.validationReason = validationReason;
    }
}

function validDate(value) {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
}

function exactRecord(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function messageValidationReason(input) {
    if (!exactRecord(input, Object.hasOwn(input ?? {}, 'status') ? ['role', 'content', 'status'] : ['role', 'content']))
        return 'invalid_shape';
    if (!['user', 'assistant'].includes(input.role)) return 'invalid_role';
    if (typeof input.content !== 'string') return 'content_not_string';
    if (Buffer.byteLength(input.content, 'utf8') > MAX_MESSAGE_BYTES) return 'content_too_large';
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(input.content))
        return 'disallowed_control_character';
    if (input.content.trim().length === 0 && !(input.role === 'assistant' && input.status === 'interrupted'))
        return 'empty_content';
    if (input.status !== undefined && !['complete', 'interrupted'].includes(input.status)) return 'invalid_status';
    return null;
}

function safeTitle(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 120
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validTitleSource(value) { return value === 'provisional' || value === 'automatic' || value === 'manual'; }

function validManifest(value, conversationId) {
    const legacy = exactRecord(value, ['version', 'conversationId', 'createdAt', 'updatedAt', 'title', 'messageCount']);
    const current = exactRecord(value, ['version', 'conversationId', 'createdAt', 'updatedAt', 'title', 'messageCount', 'titleSource']);
    return (legacy || (current && validTitleSource(value.titleSource)))
        && value.version === 1 && value.conversationId === conversationId
        && validDate(value.createdAt) && validDate(value.updatedAt)
        && safeTitle(value.title) && Number.isSafeInteger(value.messageCount) && value.messageCount >= 0;
}

function validMessage(value, conversationId) {
    return exactRecord(value, ['version', 'id', 'conversationId', 'sequence', 'role', 'content', 'createdAt', 'status'])
        && value.version === 1 && typeof value.id === 'string' && UUID.test(value.id)
        && value.conversationId === conversationId && Number.isSafeInteger(value.sequence) && value.sequence > 0
        && (value.role === 'user' || value.role === 'assistant')
        && typeof value.content === 'string' && Buffer.byteLength(value.content, 'utf8') <= MAX_MESSAGE_BYTES
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value.content)
        && (value.content.trim().length > 0 || (value.role === 'assistant' && value.status === 'interrupted'))
        && validDate(value.createdAt) && (value.status === 'complete' || value.status === 'interrupted');
}

function comparePath(left, right) {
    const a = path.resolve(left), b = path.resolve(right);
    return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b;
}

async function readExactly(handle, length, position) {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(bytes, offset, length - offset, position + offset);
        if (bytesRead === 0) throw new ConversationStoreError('conversation_store_corrupt');
        offset += bytesRead;
    }
    return bytes;
}

async function previousNewline(handle, endExclusive) {
    let cursor = endExclusive;
    while (cursor > 0) {
        const start = Math.max(0, cursor - READ_CHUNK_BYTES);
        const bytes = await readExactly(handle, cursor - start, start);
        const index = bytes.lastIndexOf(0x0a);
        if (index >= 0) return start + index;
        cursor = start;
    }
    return -1;
}

async function readLastRecord(handle, size, conversationId) {
    if (size === 0) return { sequence: 0, recoveredTail: false };
    const lastByte = (await readExactly(handle, 1, size - 1))[0];
    const terminated = lastByte === 0x0a;
    const lineEnd = terminated ? size - 1 : size;
    if (lineEnd === 0) return { sequence: 0, recoveredTail: false };
    const start = (await previousNewline(handle, lineEnd)) + 1;
    const tail = await readExactly(handle, lineEnd - start, start);
    let record;
    try { record = JSON.parse(tail.toString('utf8')); }
    catch (cause) {
        if (terminated) throw new ConversationStoreError('conversation_store_corrupt', { cause });
        return { sequence: null, recoveredTail: true, tailStart: start, tail };
    }
    if (!validMessage(record, conversationId)) throw new ConversationStoreError('conversation_store_corrupt');
    return { sequence: record.sequence, message: record, recoveredTail: false, terminated, start, size };
}

/**
 * Local conversation persistence. Visible messages remain separate from a
 * tightly bounded, allowlisted tool-outcome log; raw tool payloads, audio,
 * credentials and Memory2 are outside this store's contract. Construction
 * performs no filesystem I/O.
 */
export function createConversationStore({ baseDirectory, fileSystem = {}, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
    if (typeof baseDirectory !== 'string' || !path.isAbsolute(baseDirectory))
        throw new ConversationStoreError('conversation_store_invalid');
    if (typeof now !== 'function' || typeof idFactory !== 'function') throw new ConversationStoreError('conversation_store_invalid');

    const fs = { ...nativeFs, ...fileSystem };
    const root = path.resolve(baseDirectory);
    const conversationsDirectory = path.join(root, 'conversations');
    const queues = new Map();
    let initialization;

    function serialize(conversationId, operation) {
        const previous = queues.get(conversationId) ?? Promise.resolve();
        const result = previous.catch(() => {}).then(operation);
        let queued;
        queued = result.finally(() => { if (queues.get(conversationId) === queued) queues.delete(conversationId); }).catch(() => {});
        queues.set(conversationId, queued);
        return result;
    }

    function conversationDirectory(conversationId) {
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        const target = path.resolve(conversationsDirectory, conversationId);
        if (path.dirname(target) !== path.resolve(conversationsDirectory))
            throw new ConversationStoreError('conversation_id_invalid');
        return target;
    }

    async function assertSafeDirectory(directory) {
        try {
            const info = await fs.lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink() || !comparePath(await fs.realpath(directory), directory))
                throw new ConversationStoreError('conversation_store_unavailable');
        } catch (cause) {
            if (cause instanceof ConversationStoreError) throw cause;
            throw new ConversationStoreError('conversation_store_unavailable', { cause });
        }
    }

    async function initialize() {
        if (!initialization) initialization = (async () => {
            await fs.mkdir(root, { recursive: true, mode: 0o700 });
            await assertSafeDirectory(root);
            await fs.mkdir(conversationsDirectory, { recursive: true, mode: 0o700 });
            await assertSafeDirectory(conversationsDirectory);
        })().catch(error => { initialization = undefined; throw error; });
        return initialization;
    }

    function pathsFor(conversationId) {
        const directory = conversationDirectory(conversationId);
        return { directory, manifest: path.join(directory, MANIFEST_NAME), messages: path.join(directory, MESSAGES_NAME),
            toolRecords: path.join(directory, TOOL_RECORDS_NAME) };
    }

    async function readManifest(conversationId) {
        const { directory, manifest } = pathsFor(conversationId);
        try {
            try { await fs.lstat(directory); }
            catch (cause) {
                if (cause?.code === 'ENOENT') return null;
                throw cause;
            }
            await assertSafeDirectory(directory);
            const info = await fs.lstat(manifest);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES)
                throw new ConversationStoreError('conversation_store_corrupt');
            const value = JSON.parse(await fs.readFile(manifest, 'utf8'));
            if (!validManifest(value, conversationId)) throw new ConversationStoreError('conversation_store_corrupt');
            // Older manifests predate title ownership. Preserve their titles by
            // treating any non-placeholder title as user-owned.
            return value.titleSource ? value : { ...value,
                titleSource: value.title === 'Nueva conversación' ? 'provisional' : 'manual' };
        } catch (cause) {
            if (cause instanceof ConversationStoreError) throw cause;
            if (cause?.code === 'ENOENT') return null;
            throw new ConversationStoreError(cause instanceof SyntaxError ? 'conversation_store_corrupt' : 'conversation_store_unavailable', { cause });
        }
    }

    async function writeManifest(manifest) {
        const { directory, manifest: manifestPath } = pathsFor(manifest.conversationId);
        const tempPath = path.join(directory, `.manifest-${idFactory()}.tmp`);
        let ownsTemp = false;
        let handle;
        try {
            handle = await fs.open(tempPath, 'wx', 0o600);
            ownsTemp = true;
            await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            await fs.rename(tempPath, manifestPath);
            ownsTemp = false;
        } catch (cause) {
            if (handle) await handle.close().catch(() => {});
            if (ownsTemp) await fs.unlink(tempPath).catch(() => {});
            throw new ConversationStoreError('conversation_persist_failed', { cause });
        }
    }

    async function readMessagePage(conversationId, { limit = 50, cursor = null } = {}) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX
            || !(cursor === null || (exactRecord(cursor, ['offset', 'beforeSequence'])
                && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0
                && Number.isSafeInteger(cursor.beforeSequence) && cursor.beforeSequence > 0)))
            throw new ConversationStoreError('conversation_page_invalid');
        const { messages: messagesPath } = pathsFor(conversationId);
        let handle;
        try {
            const info = await fs.lstat(messagesPath);
            if (!info.isFile() || info.isSymbolicLink()) throw new ConversationStoreError('conversation_store_corrupt');
            handle = await fs.open(messagesPath, 'r');
            const size = (await handle.stat()).size;
            let end = cursor ? cursor.offset : size;
            if (end > size) throw new ConversationStoreError('conversation_page_invalid');
            const selected = [];
            let hasMore = false;
            let incompleteTail = false;
            let first = true;
            const endsWithNewline = end > 0 && (await readExactly(handle, 1, end - 1))[0] === 0x0a;
            if (endsWithNewline) end--;
            while (end > 0 && selected.length < limit + 1) {
                const newline = await previousNewline(handle, end);
                const start = newline + 1;
                const bytes = await readExactly(handle, end - start, start);
                end = newline < 0 ? 0 : newline;
                if (bytes.length === 0) { first = false; continue; }
                let message;
                try { message = JSON.parse(bytes.toString('utf8')); }
                catch (cause) {
                    if (first && !cursor && !endsWithNewline) { incompleteTail = true; first = false; continue; }
                    throw new ConversationStoreError('conversation_store_corrupt', { cause });
                }
                if (!validMessage(message, conversationId)) throw new ConversationStoreError('conversation_store_corrupt');
                if (cursor && message.sequence >= cursor.beforeSequence)
                    throw new ConversationStoreError('conversation_page_invalid');
                selected.push({ message, offset: start });
                first = false;
            }
            hasMore = selected.length > limit;
            const page = selected.slice(0, limit);
            const nextCursor = hasMore ? { offset: page.at(-1).offset, beforeSequence: page.at(-1).message.sequence } : null;
            return { messages: page.map(item => item.message).reverse(), nextCursor, incompleteTail };
        } catch (cause) {
            if (cause instanceof ConversationStoreError) throw cause;
            if (cause?.code === 'ENOENT') throw new ConversationStoreError('conversation_not_found');
            throw new ConversationStoreError('conversation_store_unavailable', { cause });
        } finally { await handle?.close().catch(() => {}); }
    }

    async function createConversation(requestedConversationId) {
        await initialize();
        if (requestedConversationId !== undefined
            && (typeof requestedConversationId !== 'string' || !UUID.test(requestedConversationId)))
            throw new ConversationStoreError('conversation_id_invalid');
        for (let attempt = 0; attempt < 3; attempt++) {
            const conversationId = requestedConversationId ?? idFactory();
            if (typeof conversationId !== 'string' || !UUID.test(conversationId))
                throw new ConversationStoreError('conversation_id_invalid');
            const { directory, messages } = pathsFor(conversationId);
            let created = false;
            try {
                await fs.mkdir(directory, { mode: 0o700 });
                created = true;
                await assertSafeDirectory(directory);
                const timestamp = now();
                if (!validDate(timestamp)) throw new ConversationStoreError('conversation_store_invalid');
                const manifest = { version: 1, conversationId, createdAt: timestamp, updatedAt: timestamp,
                    title: 'Nueva conversación', messageCount: 0, titleSource: 'provisional' };
                const handle = await fs.open(messages, 'wx', 0o600);
                await handle.sync();
                await handle.close();
                await writeManifest(manifest);
                return Object.freeze({ ...manifest });
            } catch (cause) {
                if (cause?.code === 'EEXIST') continue;
                if (cause instanceof ConversationStoreError) {
                    if (created) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
                    throw cause;
                }
                if (created) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
                throw new ConversationStoreError('conversation_persist_failed', { cause });
            }
        }
        throw new ConversationStoreError('conversation_id_collision');
    }

    async function listConversations({ limit = 50, cursor = null } = {}) {
        await initialize();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX
            || !(cursor === null || (exactRecord(cursor, ['updatedAt', 'conversationId'])
                && validDate(cursor.updatedAt) && typeof cursor.conversationId === 'string' && UUID.test(cursor.conversationId))))
            throw new ConversationStoreError('conversation_page_invalid');
        let entries;
        try { entries = await fs.readdir(conversationsDirectory, { withFileTypes: true }); }
        catch (cause) { throw new ConversationStoreError('conversation_store_unavailable', { cause }); }
        const conversations = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
            const manifest = await readManifest(entry.name);
            if (!manifest) throw new ConversationStoreError('conversation_store_corrupt');
            conversations.push(manifest);
        }
        conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.conversationId.localeCompare(a.conversationId));
        const filtered = cursor ? conversations.filter(item => item.updatedAt < cursor.updatedAt
            || (item.updatedAt === cursor.updatedAt && item.conversationId < cursor.conversationId)) : conversations;
        const selected = filtered.slice(0, limit + 1);
        const hasMore = selected.length > limit;
        const items = selected.slice(0, limit).map(item => Object.freeze({ ...item }));
        const last = items.at(-1);
        return { conversations: items, nextCursor: hasMore && last
            ? { updatedAt: last.updatedAt, conversationId: last.conversationId } : null };
    }

    async function getConversation(conversationId) {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        return serialize(conversationId, async () => {
            const manifest = await readManifest(conversationId);
            return manifest ? Object.freeze({ ...manifest }) : null;
        });
    }

    async function updateTitle(conversationId, title, source = 'manual') {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        const normalizedTitle = source === 'manual' && typeof title === 'string'
            ? title.replace(/\s+/gu, ' ').trim() : title;
        const maxLength = source === 'automatic' ? 60 : 120;
        if (!validTitleSource(source) || source === 'provisional' || typeof normalizedTitle !== 'string'
            || normalizedTitle.length < 1 || normalizedTitle.length > maxLength || !safeTitle(normalizedTitle))
            throw new ConversationStoreError('conversation_title_invalid');
        return serialize(conversationId, async () => {
            const manifest = await readManifest(conversationId);
            if (!manifest) throw new ConversationStoreError('conversation_not_found');
            if (source === 'automatic' && manifest.titleSource !== 'provisional') return false;
            await writeManifest({ ...manifest, title: normalizedTitle, titleSource: source });
            return true;
        });
    }

    async function appendMessage(conversationId, input = {}) {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        const validationReason = messageValidationReason(input);
        if (validationReason) throw new ConversationStoreError('conversation_message_invalid', { validationReason });
        return serialize(conversationId, async () => {
            let manifest = await readManifest(conversationId);
            if (!manifest) throw new ConversationStoreError('conversation_not_found');
            const { messages: messagesPath } = pathsFor(conversationId);
            let handle;
            let recoveredTail = false;
            try {
                handle = await fs.open(messagesPath, 'r+');
                let size = (await handle.stat()).size;
                let tail = await readLastRecord(handle, size, conversationId);
                if (tail.recoveredTail) {
                    const recoveryPath = `${messagesPath}.recovery-${idFactory()}.bin`;
                    const recovery = await fs.open(recoveryPath, 'wx', 0o600);
                    try {
                        await recovery.writeFile(tail.tail);
                        await recovery.sync();
                    } finally { await recovery.close(); }
                    const preserved = await fs.readFile(recoveryPath);
                    if (!preserved.equals(tail.tail)) throw new ConversationStoreError('conversation_persist_failed');
                    await handle.truncate(tail.tailStart);
                    await handle.sync();
                    size = tail.tailStart;
                    tail = await readLastRecord(handle, size, conversationId);
                    recoveredTail = true;
                } else if (!tail.terminated && size > 0) {
                    await handle.write(Buffer.from('\n'), 0, 1, size);
                    await handle.sync();
                    size++;
                }
                const previousSequence = tail.sequence;
                if (previousSequence < manifest.messageCount || previousSequence > manifest.messageCount + 1)
                    throw new ConversationStoreError('conversation_store_corrupt');
                const timestampCandidate = now();
                if (!validDate(timestampCandidate)) throw new ConversationStoreError('conversation_store_invalid');
                const timestamp = new Date(Math.max(Date.parse(timestampCandidate), Date.parse(manifest.updatedAt) + 1)).toISOString();
                const message = { version: 1, id: idFactory(), conversationId, sequence: previousSequence + 1,
                    role: input.role, content: input.content, createdAt: timestamp, status: input.status ?? 'complete' };
                if (!UUID.test(message.id)) throw new ConversationStoreError('conversation_id_invalid');
                const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
                if (bytes.length > MAX_MESSAGE_BYTES + 2048) throw new ConversationStoreError('conversation_message_invalid');
                await handle.write(bytes, 0, bytes.length, size);
                await handle.sync();
                const updated = { ...manifest, updatedAt: timestamp, messageCount: message.sequence };
                try { await writeManifest(updated); }
                catch (cause) { throw new ConversationStoreError('conversation_commit_uncertain', { cause }); }
                return { message: Object.freeze(message), recoveredIncompleteTail: recoveredTail };
            } catch (cause) {
                if (cause instanceof ConversationStoreError) throw cause;
                throw new ConversationStoreError('conversation_persist_failed', { cause });
            } finally { await handle?.close().catch(() => {}); }
        });
    }

    async function readToolRecordsUnlocked(conversationId, limit = MAX_TOOL_RECORDS) {
        const { directory, toolRecords: toolRecordsPath } = pathsFor(conversationId);
        try {
            await assertSafeDirectory(directory);
            const info = await fs.lstat(toolRecordsPath);
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TOOL_RECORDS_BYTES)
                throw new ConversationStoreError('conversation_store_corrupt');
            const text = await fs.readFile(toolRecordsPath, 'utf8');
            if (text && !text.endsWith('\n')) throw new ConversationStoreError('conversation_store_corrupt');
            const lines = text ? text.slice(0, -1).split('\n') : [];
            if (lines.length > MAX_TOOL_RECORDS) throw new ConversationStoreError('conversation_store_corrupt');
            let previousSequence = 0;
            const records = lines.map(line => {
                let record;
                try { record = JSON.parse(line); } catch (cause) { throw new ConversationStoreError('conversation_store_corrupt', { cause }); }
                if (!isConversationToolRecord(record, conversationId) || record.sequence <= previousSequence)
                    throw new ConversationStoreError('conversation_store_corrupt');
                previousSequence = record.sequence;
                return Object.freeze(record);
            });
            return records.slice(-limit);
        } catch (cause) {
            if (cause instanceof ConversationStoreError) throw cause;
            if (cause?.code === 'ENOENT') return [];
            throw new ConversationStoreError('conversation_store_unavailable', { cause });
        }
    }

    async function appendToolRecord(conversationId, input = {}) {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        const keys = ['turnId', 'userSequence', 'toolName', 'callIdHash', 'status'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
            || Object.keys(input).length !== keys.length
            || keys.some(key => !Object.hasOwn(input, key)) || !isConversationToolOutcome({
                toolName: input.toolName, callIdHash: input.callIdHash, status: input.status,
            }) || typeof input.turnId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.turnId)
            || !Number.isSafeInteger(input.userSequence) || input.userSequence < 1)
            throw new ConversationStoreError('conversation_tool_record_invalid');
        return serialize(conversationId, async () => {
            const manifest = await readManifest(conversationId);
            if (!manifest) throw new ConversationStoreError('conversation_not_found');
            if (manifest.messageCount !== input.userSequence)
                throw new ConversationStoreError('conversation_tool_record_invalid');
            const { messages: messagesPath, toolRecords: toolRecordsPath, directory } = pathsFor(conversationId);
            await assertSafeDirectory(directory);
            let messageHandle;
            try {
                messageHandle = await fs.open(messagesPath, 'r');
                const size = (await messageHandle.stat()).size;
                const tail = await readLastRecord(messageHandle, size, conversationId);
                if (tail.message?.role !== 'user' || tail.sequence !== input.userSequence)
                    throw new ConversationStoreError('conversation_tool_record_invalid');
            } catch (cause) {
                if (cause instanceof ConversationStoreError) throw cause;
                throw new ConversationStoreError('conversation_store_unavailable', { cause });
            } finally { await messageHandle?.close().catch(() => {}); }

            const existing = await readToolRecordsUnlocked(conversationId);
            if (existing.some(record => record.turnId === input.turnId && record.callIdHash === input.callIdHash))
                return existing.find(record => record.turnId === input.turnId && record.callIdHash === input.callIdHash);
            const timestamp = now();
            if (!validDate(timestamp)) throw new ConversationStoreError('conversation_store_invalid');
            const record = Object.freeze({ version: 1, id: idFactory(), conversationId, turnId: input.turnId,
                userSequence: input.userSequence, sequence: (existing.at(-1)?.sequence ?? 0) + 1, toolName: input.toolName,
                callIdHash: input.callIdHash, status: input.status, createdAt: timestamp });
            if (!UUID.test(record.id) || !isConversationToolRecord(record, conversationId))
                throw new ConversationStoreError('conversation_store_invalid');
            const retained = [...existing, record];
            while (retained.length > MAX_TOOL_RECORDS
                || Buffer.byteLength(`${retained.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8') > MAX_TOOL_RECORDS_BYTES) {
                if (retained.length <= 1) throw new ConversationStoreError('conversation_persist_failed');
                retained.shift();
            }
            const bytes = Buffer.from(`${retained.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');
            try {
                const info = await fs.lstat(toolRecordsPath).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
                if (info && (!info.isFile() || info.isSymbolicLink())) throw new ConversationStoreError('conversation_store_corrupt');
                const temporaryPath = path.join(directory, `.tool-outcomes-${idFactory()}.tmp`);
                let handle;
                let ownsTemporary = false;
                try {
                    handle = await fs.open(temporaryPath, 'wx', 0o600);
                    ownsTemporary = true;
                    await handle.writeFile(bytes);
                    await handle.sync();
                    await handle.close();
                    handle = undefined;
                    await fs.rename(temporaryPath, toolRecordsPath);
                    ownsTemporary = false;
                } finally {
                    if (handle) await handle.close().catch(() => {});
                    if (ownsTemporary) await fs.unlink(temporaryPath).catch(() => {});
                }
                return record;
            } catch (cause) {
                if (cause instanceof ConversationStoreError) throw cause;
                throw new ConversationStoreError('conversation_persist_failed', { cause });
            }
        });
    }

    async function listToolRecords(conversationId, { limit = MAX_TOOL_RECORDS } = {}) {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TOOL_RECORDS)
            throw new ConversationStoreError('conversation_page_invalid');
        return serialize(conversationId, async () => {
            if (!await readManifest(conversationId)) throw new ConversationStoreError('conversation_not_found');
            return Object.freeze(await readToolRecordsUnlocked(conversationId, limit));
        });
    }

    async function listMessages(conversationId, options = {}) {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        return serialize(conversationId, async () => {
            if (!await readManifest(conversationId)) throw new ConversationStoreError('conversation_not_found');
            return readMessagePage(conversationId, options);
        });
    }

    async function deleteConversation(conversationId) {
        await initialize();
        if (typeof conversationId !== 'string' || !UUID.test(conversationId))
            throw new ConversationStoreError('conversation_id_invalid');
        return serialize(conversationId, async () => {
            const manifest = await readManifest(conversationId);
            if (!manifest) return false;
            const { directory } = pathsFor(conversationId);
            await assertSafeDirectory(directory);
            try { await fs.rm(directory, { recursive: true, force: false }); }
            catch (cause) { throw new ConversationStoreError('conversation_persist_failed', { cause }); }
            return true;
        });
    }

    return Object.freeze({ initialize, createConversation, listConversations, getConversation,
        appendMessage, appendToolRecord, listToolRecords, listMessages, updateTitle, deleteConversation });
}
