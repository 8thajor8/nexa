import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommunicationsService } from '../src/communications/service.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { createAgent } from '../src/core/agent.js';

function functionCall(name, args, callId = name) {
    return { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId };
}
function toolResponse(call) {
    return { status: 'completed', output: [call], output_text: '' };
}
function finalResponse(text) {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], output_text: text };
}

test('Desktop conversation prepares then confirms one pending email across two direct-user turns', async () => {
    const sends = [];
    const seenContexts = [];
    const provider = {
        async getConnectionStatus() { return { success: true, connected: true }; },
        async getMailboxes() { return { success: true, mailboxes: [{ id: 'me', address: 'me@example.test', displayName: 'Me', type: 'personal' }] }; },
        async sendEmail(payload) { sends.push(payload); return { success: true, sent: true }; },
    };
    const communications = createCommunicationsService({ emailProvider: provider });
    const modelResponses = [
        toolResponse(functionCall('prepare_email', { mailbox: null, to: ['recipient@example.test'], cc: [], subject: 'Desktop test', body: 'Synthetic message.' }, 'prepare')),
        finalResponse('Vista previa preparada. ¿Lo envío?'),
        toolResponse(functionCall('resolve_pending_action', { intent: 'approve', selection: null }, 'approve')),
        finalResponse('Microsoft aceptó el envío.'),
    ];
    const tools = [{ type: 'function', name: 'prepare_email' }, { type: 'function', name: 'resolve_pending_action' }];
    const runtime = createConversationRuntime({
        memoryMode: 'memory1',
        agentOptions: {
            memoryBackend: 'memory1',
            load: async () => ({ user: {}, preferences: {}, facts: [] }),
            save: async () => {},
            getTools: () => tools,
            ask: async () => {
                const response = modelResponses.shift();
                assert.ok(response, 'unexpected model request');
                return response;
            },
            execute: async (name, args, context) => {
                seenContexts.push({ name, sessionId: context.sessionId, userMessage: context.userMessage,
                    userMessageSource: context.userMessageSource, inputSource: context.inputSource });
                if (name === 'prepare_email') return communications.prepareEmail(args, context);
                if (name === 'resolve_pending_action') return communications.resolvePendingAction(args, context);
                throw new Error('unexpected_test_tool');
            },
            automaticMemoryConsentStore: { async load() { return null; }, async grant() {}, async revoke() {} },
            automaticMemoryProposalQueue: {
                async listGrouped() { return []; }, async review() { return null; }, async approve() {}, async reject() {},
                async discard() {}, async excludeConversation() {}, async revokeConsent() {},
            },
            logger: () => {},
        },
    });
    try {
        const conversationId = runtime.createConversation();
        const firstTurn = await runtime.sendMessage({ conversationId, requestId: '10000000-0000-4000-8000-000000000001',
            text: 'Prepará un correo de prueba para recipient@example.test.', source: 'typed' });
        assert.equal(firstTurn.status, 'completed');
        assert.match(firstTurn.text, /Vista previa preparada/u);
        assert.equal(sends.length, 0);

        const secondTurn = await runtime.sendMessage({ conversationId, requestId: '10000000-0000-4000-8000-000000000002',
            text: 'sí', source: 'typed' });
        assert.equal(secondTurn.status, 'completed');
        assert.match(secondTurn.text, /aceptó el envío/u);
        assert.equal(sends.length, 1);
        assert.equal(sends[0].subject, 'Desktop test');
        assert.equal(seenContexts.length, 2);
        assert.equal(seenContexts[0].sessionId, seenContexts[1].sessionId);
        assert.deepEqual(seenContexts.map(item => item.userMessageSource), ['direct_user', 'direct_user']);
        assert.deepEqual(seenContexts.map(item => item.inputSource), ['typed', 'typed']);
        assert.equal(seenContexts[1].userMessage, 'sí');
        assert.equal(modelResponses.length, 0);
    } finally {
        await runtime.close();
    }
});
