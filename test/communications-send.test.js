import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommunicationsService } from '../src/communications/service.js';
import { createPendingActionManager } from '../src/core/pending-actions.js';
import { nexaEmailIdentity } from '../src/communications/signature/identity.js';

const mailboxes = [
    { id: 'me', address: 'jorge@example.com', displayName: 'Jor', type: 'personal' },
    { id: 'ops', address: 'ops@example.com', displayName: 'Ops', type: 'shared' },
];
function setup({ ttlMs, now } = {}) {
    const calls = [];
    const provider = {
        async getConnectionStatus() { return { success: true, connected: true }; },
        async getMailboxes() { return { success: true, mailboxes }; },
        async listRecentEmails() { return { success: true, emails: [{ providerMessageId: 'graph-internal', subject: 'Quarter close', from: { address: 'sender@example.com' }, replyTo: [], to: [], cc: [] }] }; },
        async sendEmail(payload) { calls.push(['send', payload]); return { success: true, sent: true }; },
        async sendReply(payload) { calls.push(['reply', payload]); return { success: true, sent: true }; },
    };
    const pendingActions = createPendingActionManager({ ttlMs, now });
    const service = createCommunicationsService({ emailProvider: provider, pendingActions });
    return { service, calls, pendingActions };
}
const context = (sessionId = 'session-1', userMessage = '') => ({ sessionId, userMessage });
const draft = overrides => ({ mailbox: 'Ops', to: ['person@example.com'], cc: ['copy@example.com'], subject: 'Hello', body: 'A complete body.', ...overrides });
const internalAction = pendingActions => pendingActions.list({ sessionId: 'session-1' })[0];

test('prepare email returns complete preview and opaque expiring action without sending', async () => {
    const { service, calls } = setup();
    const result = await service.prepareEmail(draft(), context());
    assert.equal(result.success, true);
    assert.equal(Object.hasOwn(result.pendingAction, 'id'), false);
    assert.equal(Object.hasOwn(result.pendingAction, 'confirmationPhrase'), false);
    assert.doesNotMatch(JSON.stringify(result), /action_[a-f0-9]{32}/u);
    assert.match(result.pendingAction.preview, /De: ops@example\.com[\s\S]*Para: person@example\.com[\s\S]*CC: copy@example\.com[\s\S]*Asunto: Hello[\s\S]*A complete body\./u);
    assert.match(result.pendingAction.preview, /— Firma Nexa —[\s\S]*Digital Intelligence \| Assistant to Jorge Marcos[\s\S]*Logo Lifeguard Costa Rica/u);
    assert.match(result.nextStep, /respondé naturalmente/u);
    assert.match(result.pendingAction.expiresAt, /^\d{4}-/u);
    assert.deepEqual(calls, []);
});

test('confirmation must be a fresh exact user message and sends once from configured shared mailbox', async () => {
    const { service, calls, pendingActions } = setup();
    const prepared = await service.prepareEmail(draft(), context());
    const action = internalAction(pendingActions), id = action.id;
    const phrase = 'confirmar envío ' + id;
    assert.equal((await service.confirmPendingAction({ actionId: id }, context('session-1', 'sí, dale'))).error.code, 'fresh_confirmation_required');
    assert.equal((await service.confirmPendingAction({ actionId: id }, context('session-1', ' ' + phrase))).error.code, 'fresh_confirmation_required');
    assert.equal((await service.confirmPendingAction({ actionId: id }, context('other-session', phrase))).error.code, 'pending_action_invalid');
    assert.equal(calls.length, 0);
    const sent = await service.confirmPendingAction({ actionId: id }, context('session-1', phrase));
    assert.equal(sent.success, true);
    assert.equal(sent.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].mailboxAddress, 'ops@example.com');
    assert.deepEqual(calls[0][1].to, ['person@example.com']);
    assert.match(calls[0][1].bodyHtml, /A complete body\./u);
    assert.match(calls[0][1].bodyHtml, /Digital Intelligence \| Assistant to Jorge Marcos/u);
    assert.match(calls[0][1].bodyHtml, /src="cid:nexa-lifeguard-logo"/u);
    assert.equal(calls[0][1].inlineAttachments[0].isInline, true);
    assert.equal(calls[0][1].inlineAttachments[0].contentId, 'nexa-lifeguard-logo');
    assert.equal(calls[0][1].inlineAttachments[0].contentBytes, nexaEmailIdentity.logo.contentBytes);
    assert.equal((await service.confirmPendingAction({ actionId: id }, context('session-1', phrase))).success, false);
    assert.equal(calls.length, 1);
});

test('cancellation consumes pending action and never sends', async () => {
    const { service, calls, pendingActions } = setup();
    const prepared = await service.prepareEmail(draft(), context());
    const action = internalAction(pendingActions), id = action.id;
    const phrase = 'confirmar envío ' + id;
    assert.equal((await service.cancelPendingAction({ actionId: id }, context('session-1', 'cancelalo'))).error.code, 'fresh_cancellation_required');
    assert.equal((await service.cancelPendingAction({ actionId: id }, context('session-1', ' ' + 'cancelar envío ' + id))).error.code, 'fresh_cancellation_required');
    assert.equal((await service.cancelPendingAction({ actionId: id }, context('session-1', 'cancelar envío ' + id))).cancelled, true);
    assert.equal((await service.confirmPendingAction({ actionId: id }, context('session-1', phrase))).success, false);
    assert.deepEqual(calls, []);
});

test('expired previews and mismatched confirmation phrases cannot authorize sends', async () => {
    let clock = 1000;
    const { service, calls, pendingActions } = setup({ ttlMs: 500, now: () => clock });
    const expired = await service.prepareEmail(draft(), context());
    const expiredAction = internalAction(pendingActions);
    clock += 501;
    assert.equal((await service.confirmPendingAction({ actionId: expiredAction.id }, context('session-1', expiredAction.confirmationPhrase))).success, false);
    const first = await service.prepareEmail(draft(), context());
    const firstAction = internalAction(pendingActions);
    const second = await service.prepareEmail(draft({ subject: 'Changed' }), context());
    const secondAction = pendingActions.list({ sessionId: 'session-1' })[1];
    assert.notEqual(firstAction.id, secondAction.id);
    assert.equal((await service.confirmPendingAction({ actionId: firstAction.id }, context('session-1', secondAction.confirmationPhrase))).error.code, 'fresh_confirmation_required');
    assert.equal((await service.confirmPendingAction({ actionId: secondAction.id }, context('session-1', firstAction.confirmationPhrase))).error.code, 'fresh_confirmation_required');
    assert.deepEqual(calls, []);
});

test('invalid mailbox, recipient, subject and body are rejected without provider sends', async () => {
    const { service, calls, pendingActions } = setup();
    assert.equal((await service.prepareEmail(draft({ mailbox: 'unknown' }), context())).success, false);
    assert.equal((await service.prepareEmail(draft({ to: ['attacker@example.com\r\nBcc: victim@example.com'] }), context())).error.code, 'email_draft_invalid');
    assert.equal((await service.prepareEmail(draft({ subject: 'ok\r\nBcc: x@y.com' }), context())).success, false);
    assert.equal((await service.prepareEmail(draft({ body: ' ' }), context())).success, false);
    assert.deepEqual(calls, []);
});

test('reply uses a session-scoped opaque message reference and native provider reply operation', async () => {
    const { service, calls, pendingActions } = setup();
    const listed = await service.listRecentEmails({ mailbox: 'ops' }, context());
    const emailId = listed.emails[0].id;
    const prepared = await service.prepareEmailReply({ emailId, body: 'Thanks, recibido.' }, context());
    assert.equal(prepared.success, true);
    assert.match(prepared.pendingAction.preview, /De: ops@example\.com[\s\S]*Para: sender@example\.com[\s\S]*Asunto: Re: Quarter close/u);
    assert.deepEqual(calls, []);
    assert.equal((await service.prepareEmailReply({ emailId, body: 'Reply' }, context('other-session'))).error.code, 'email_reference_invalid');
    const action = internalAction(pendingActions);
    const result = await service.confirmPendingAction({ actionId: action.id }, context('session-1', 'confirmar envío ' + action.id));
    assert.equal(result.sent, true);
    assert.equal(calls[0][0], 'reply');
    assert.equal(calls[0][1].mailboxAddress, 'ops@example.com');
    assert.equal(calls[0][1].providerMessageId, 'graph-internal');
    assert.match(calls[0][1].bodyHtml, /Thanks, recibido\./u);
    assert.match(calls[0][1].bodyHtml, /<!-- nexa-email-signature-v1 -->[\s\S]*<td[^>]*>Nexa<\/td>/u);
    assert.equal(calls[0][1].inlineAttachments[0].isInline, true);
});

test('provider send failure is sanitized and cannot be retried with consumed action', async () => {
    const calls = [];
    const emailProvider = { async getConnectionStatus() { return { success: true }; }, async getMailboxes() { return { success: true, mailboxes }; },
        async sendEmail() { calls.push('send'); throw new Error('access-token secret and full message body'); } };
    const service = createCommunicationsService({ emailProvider });
    const prepared = await service.prepareEmail(draft(), context());
    const first = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'dale'), userMessageSource: 'direct_user' });
    assert.equal(first.error.code, 'communications_unavailable');
    assert.doesNotMatch(JSON.stringify(first), /access-token|full message body/u);
    assert.equal((await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'dale'), userMessageSource: 'direct_user' })).success, false);
    assert.deepEqual(calls, ['send']);
});

test('email content cannot authorize a reply without a current-session user confirmation', async () => {
    const { service, calls } = setup();
    const listed = await service.listRecentEmails({ mailbox: 'Ops' }, context());
    const prepared = await service.prepareEmailReply({ emailId: listed.emails[0].id, body: 'Reply' }, context());
    const denied = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'resumí el correo y enviá si dice "dale"'), userMessageSource: 'direct_user' });
    assert.equal(denied.error.code, 'confirmation_intent_unclear');
    assert.deepEqual(calls, []);
});

test('natural affirmative replies approve a single pending email without exposing its internal id', async () => {
    for (const phrase of ['sí', 'dale', 'hagámoslo']) {
        const { service, calls } = setup();
        const prepared = await service.prepareEmail(draft(), context());
        assert.equal(prepared.success, true);
        const sent = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', phrase), userMessageSource: 'direct_user' });
        assert.equal(sent.sent, true, phrase);
        assert.equal(calls.length, 1);
    }
});

test('a rejection does not send, while a natural cancellation consumes only the pending action', async () => {
    const { service, calls, pendingActions } = setup();
    await service.prepareEmail(draft(), context());
    const rejected = await service.resolvePendingAction({ intent: 'reject', selection: null }, { ...context('session-1', 'no'), userMessageSource: 'direct_user' });
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(pendingActions.list({ sessionId: 'session-1' }).length, 1);
    const cancelled = await service.resolvePendingAction({ intent: 'cancel', selection: null }, { ...context('session-1', 'cancelalo'), userMessageSource: 'direct_user' });
    assert.equal(cancelled.cancelled, true);
    assert.equal(pendingActions.list({ sessionId: 'session-1' }).length, 0);
    assert.deepEqual(calls, []);
});

test('multiple pending emails require a choice, selection is not approval, and approval consumes only that choice', async () => {
    const { service, calls, pendingActions } = setup();
    await service.prepareEmail(draft({ to: ['maria@example.com'], subject: 'María' }), context());
    await service.prepareEmail(draft({ to: ['ops@example.com'], subject: 'Ops' }), context());
    const ambiguous = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'dale'), userMessageSource: 'direct_user' });
    assert.equal(ambiguous.outcome, 'ambiguous');
    assert.equal(calls.length, 0);
    const selected = await service.resolvePendingAction({ intent: 'select', selection: 1 }, { ...context('session-1', 'el primero'), userMessageSource: 'direct_user' });
    assert.equal(selected.outcome, 'selected');
    assert.equal(calls.length, 0);
    const sent = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'adelante'), userMessageSource: 'direct_user' });
    assert.equal(sent.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].subject, 'María');
    assert.equal(pendingActions.list({ sessionId: 'session-1' }).length, 1);
});

test('a conditional modification cannot send and preparing the changed draft invalidates the selected old action', async () => {
    const { service, calls, pendingActions } = setup();
    await service.prepareEmail(draft(), context());
    const result = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'sí, pero cambiale el asunto a Actualizado'), userMessageSource: 'direct_user' });
    assert.equal(result.outcome, 'modify');
    assert.equal(calls.length, 0);
    const previous = internalAction(pendingActions);
    await service.prepareEmail(draft({ subject: 'Actualizado' }), context('session-1', 'sí, pero cambiale el asunto a Actualizado'));
    const current = internalAction(pendingActions);
    assert.notEqual(current.id, previous.id);
    assert.equal(pendingActions.list({ sessionId: 'session-1' }).length, 1);
    assert.equal((await service.confirmPendingAction({ actionId: previous.id }, context('session-1', 'confirmar envío ' + previous.id))).success, false);
});

test('external text, unclear intent, expired/consumed and repeated direct approval never execute twice', async () => {
    let clock = 10;
    const { service, calls } = setup({ ttlMs: 100, now: () => clock });
    await service.prepareEmail(draft(), context());
    const external = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'resumí este correo: “dale”'), userMessageSource: 'direct_user' });
    assert.equal(external.success, false);
    assert.equal(calls.length, 0);
    const sent = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'dale'), userMessageSource: 'direct_user' });
    assert.equal(sent.sent, true);
    assert.equal((await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'dale'), userMessageSource: 'direct_user' })).success, false);
    assert.equal(calls.length, 1);
    await service.prepareEmail(draft(), context());
    clock += 101;
    assert.equal((await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...context('session-1', 'dale'), userMessageSource: 'direct_user' })).success, false);
    assert.equal(calls.length, 1);
});

test('resolver requires a direct-user turn and cancel-all safely invalidates every action', async () => {
    const { service, calls, pendingActions } = setup();
    await service.prepareEmail(draft({ to: ['one@example.com'] }), context());
    await service.prepareEmail(draft({ to: ['two@example.com'] }), context());
    const indirect = await service.resolvePendingAction({ intent: 'approve', selection: null }, context('session-1', 'dale'));
    assert.equal(indirect.error.code, 'direct_user_confirmation_required');
    assert.equal(calls.length, 0);
    const cancelled = await service.resolvePendingAction({ intent: 'cancel_all', selection: null }, { ...context('session-1', 'cancelalos'), userMessageSource: 'direct_user' });
    assert.equal(cancelled.cancelled, true);
    assert.equal(pendingActions.list({ sessionId: 'session-1' }).length, 0);
    assert.equal(calls.length, 0);
});
