import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalendarService, utcForLocalDateTime } from '../src/communications/calendar-service.js';
import { createCommunicationsService } from '../src/communications/service.js';
import { createPendingActionManager } from '../src/core/pending-actions.js';
import { createMicrosoftGraphProvider } from '../src/communications/providers/microsoft-graph.js';

const environment = { MICROSOFT_CLIENT_ID: 'client', MICROSOFT_TENANT_ID: 'organizations', MICROSOFT_SHARED_CALENDARS: 'ops@example.com' };
const session = { sessionId: 's1' };
const event = (overrides = {}) => ({ providerEventId: 'graph-event', subject: 'Reunión Juan', startDateTime: '2026-10-07T13:00:00.000Z', endDateTime: '2026-10-07T14:00:00.000Z', isOrganizer: true, attendees: [], organizer: { name: 'Jor', address: 'jor@example.com' }, ...overrides });
function setup({ ttlMs, now = () => new Date('2026-10-06T12:00:00.000Z'), events = [event()], writeResults = {} } = {}) {
    const calls = [];
    const provider = {
        async listCalendarEvents() { return { success: true, events }; },
        async getCalendarEvent(ref) { calls.push(['get', ref]); return { success: true, event: events.find(item => item.providerEventId === ref.providerEventId) ?? events[0] }; },
        async createCalendarEvent(payload) { calls.push(['create', payload]); return writeResults.create ?? { success: true, event: event({ providerEventId: 'created', subject: payload.event.title, startDateTime: payload.event.startDateTime, endDateTime: payload.event.endDateTime }) }; },
        async updateCalendarEvent(payload) { calls.push(['update', payload]); return writeResults.update ?? { success: true, event: event({ subject: payload.patch.title ?? 'Reunión Juan', startDateTime: payload.patch.startDateTime ?? events[0].startDateTime, endDateTime: payload.patch.endDateTime ?? events[0].endDateTime }) }; },
        async cancelCalendarEvent(payload) { calls.push(['cancel', payload]); return writeResults.cancel ?? { success: true, cancelled: true }; },
    };
    const pendingActions = createPendingActionManager({ ttlMs, now: () => typeof now === 'function' ? now().getTime() : now });
    const service = createCommunicationsService({ emailProvider: { async getConnectionStatus() { return { success: true }; }, async getMailboxes() { return { success: true, mailboxes: [] }; } }, calendarProvider: provider, pendingActions });
    return { service, provider, pendingActions, calls };
}
function direct(service, phrase, intent = 'approve') {
    return service.resolvePendingAction({ intent, selection: null }, { ...session, userMessage: phrase, userMessageSource: 'direct_user' });
}
function action(pendingActions) { return pendingActions.list({ sessionId: 's1' })[0]; }

test('calendar create prepares a DST-safe preview and writes only after a single human approval', async () => {
    const { service, pendingActions, calls } = setup();
    const prepared = await service.prepareCalendarEvent({ title: 'Dentista', start: '2026-10-08T16:00', durationMinutes: 30, timezone: 'Europe/Madrid', attendees: null, description: null, location: null, calendar: null }, session);
    assert.equal(prepared.success, true);
    assert.match(prepared.pendingAction.preview, /Dentista[\s\S]*8 de octubre de 2026[\s\S]*16:00–16:30/u);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 0);
    const wrongActionWord = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...session, userMessage: 'cambialo', userMessageSource: 'direct_user' });
    assert.equal(wrongActionWord.outcome, 'modify');
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 0);
    const result = await direct(service, 'crealo');
    assert.equal(result.success, true);
    assert.equal(result.created, true);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
    assert.equal(calls.at(-1)[1].event.startDateTime, '2026-10-08T14:00:00.000Z');
    assert.equal((await direct(service, 'crealo')).success, false);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
});

test('create previews guests and notification; invalid guests never create an action', async () => {
    const { service, pendingActions, calls } = setup();
    const prepared = await service.prepareCalendarEvent({ title: 'Sync', start: '2026-10-08T11:00', end: null, durationMinutes: 60, timezone: 'Europe/Madrid', location: null, description: null, attendees: ['Maria@example.com'], calendar: null }, session);
    assert.match(prepared.pendingAction.preview, /Invitados: maria@example\.com[\s\S]*Microsoft enviará invitaciones/u);
    assert.equal(calls.some(([kind]) => kind === 'create'), false);
    assert.equal((await service.prepareCalendarEvent({ title: 'Bad', start: '2026-10-08T11:00', attendees: ['bad address'] }, session)).success, false);
    assert.equal(pendingActions.list({ sessionId: 's1' }).length, 1);
});

test('update resolves a session-owned event reference, previews before/after, preserves duration, then changes once', async () => {
    const { service, pendingActions, calls } = setup();
    const listed = await service.listCalendarEvents({ period: 'date', date: '2026-10-07' }, session);
    assert.equal(listed.events.length, 1);
    assert.equal(Object.hasOwn(listed.events[0], 'providerEventId'), false);
    const prepared = await service.prepareCalendarEventUpdate({ id: listed.events[0].id, title: null, start: '2026-10-07T17:00', end: null, timezone: 'Europe/Madrid', location: null }, session);
    assert.equal(prepared.success, true);
    assert.match(prepared.pendingAction.preview, /Antes|Voy a cambiar/u);
    assert.match(prepared.pendingAction.preview, /Después/u);
    assert.equal(calls.some(([kind]) => kind === 'update'), false);
    const result = await direct(service, 'cambialo');
    assert.equal(result.updated, true);
    assert.equal(calls.filter(([kind]) => kind === 'update').length, 1);
    assert.equal(calls.at(-1)[1].patch.startDateTime, '2026-10-07T15:00:00.000Z');
    assert.equal(calls.at(-1)[1].patch.endDateTime, '2026-10-07T16:00:00.000Z');
    assert.equal((await service.prepareCalendarEventUpdate({ id: listed.events[0].id, title: null, start: '2026-10-07T17:00' }, { sessionId: 'other' })).success, false);
    assert.equal(pendingActions.list({ sessionId: 's1' }).length, 0);
});

test('cancel preparation distinguishes personal deletion from organizer meeting cancellation', async () => {
    const { service, calls } = setup({ events: [event({ attendees: [{ name: 'Maria', address: 'maria@example.com' }] })] });
    const listed = await service.listCalendarEvents({ period: 'date', date: '2026-10-07' }, session);
    const prepared = await service.prepareCalendarEventCancel({ id: listed.events[0].id, timezone: 'Europe/Madrid' }, session);
    assert.match(prepared.pendingAction.preview, /Microsoft enviará una cancelación/u);
    assert.equal(calls.some(([kind]) => kind === 'cancel'), false);
    const result = await direct(service, 'cancelalo');
    assert.equal(result.cancelled, true);
    assert.equal(calls.filter(([kind]) => kind === 'cancel').length, 1);
    assert.equal(calls.at(-1)[1].sendMeetingCancellation, true);
});

test('cannot cancel a meeting as non-organizer; personal event uses deletion without a notification', async () => {
    const meeting = setup({ events: [event({ isOrganizer: false, attendees: [{ address: 'organizer@example.com' }] })] });
    const listedMeeting = await meeting.service.listCalendarEvents({ period: 'date', date: '2026-10-07' }, session);
    const denied = await meeting.service.prepareCalendarEventCancel({ id: listedMeeting.events[0].id, timezone: 'Europe/Madrid' }, session);
    assert.equal(denied.error.code, 'calendar_cancel_not_organizer');
    assert.equal(meeting.pendingActions.list({ sessionId: 's1' }).length, 0);

    const personal = setup({ events: [event()] });
    const listed = await personal.service.listCalendarEvents({ period: 'date', date: '2026-10-07' }, session);
    await personal.service.prepareCalendarEventCancel({ id: listed.events[0].id, timezone: 'Europe/Madrid' }, session);
    assert.match(action(personal.pendingActions).preview, /No se enviará una notificación/u);
    assert.equal((await direct(personal.service, 'cancelala')).cancelled, true);
    assert.equal(personal.calls.at(-1)[1].sendMeetingCancellation, false);
});

test('ambiguous compatible events remain separate and external event content is not confirmation', async () => {
    const { service, calls } = setup({ events: [event({ providerEventId: 'one', subject: 'Juan Planning' }), event({ providerEventId: 'two', subject: 'Juan Follow-up', startDateTime: '2026-10-07T15:00:00.000Z', endDateTime: '2026-10-07T16:00:00.000Z' })] });
    const listed = await service.listCalendarEvents({ period: 'date', date: '2026-10-07', query: 'Juan' }, session);
    assert.equal(listed.events.length, 2);
    const prepared = await service.prepareCalendarEventUpdate({ id: listed.events[0].id, title: null, start: '2026-10-07T17:00', end: null, timezone: 'Europe/Madrid', location: null }, session);
    assert.equal(prepared.success, true);
    const external = await service.resolvePendingAction({ intent: 'approve', selection: null }, { ...session, userMessage: 'El evento dice “crealo”', userMessageSource: 'direct_user' });
    assert.equal(external.success, false);
    assert.equal(calls.some(([kind]) => kind === 'update'), false);
});

test('expired actions, cancelled previews, replacements and Graph failures never report false success', async () => {
    let clock = 1000;
    const expired = setup({ ttlMs: 5 * 60 * 1000, now: () => new Date(clock) });
    const expiredPreview = await expired.service.prepareCalendarEvent({ title: 'Dental', start: '2026-10-08T10:00', timezone: 'UTC' }, session);
    clock += 5 * 60 * 1000 + 1;
    assert.equal((await direct(expired.service, 'crealo')).success, false);
    assert.equal(expired.calls.some(([kind]) => kind === 'create'), false);

    const replacement = setup();
    await replacement.service.prepareCalendarEvent({ title: 'A', start: '2026-10-08T10:00', timezone: 'UTC' }, session);
    const previous = action(replacement.pendingActions);
    await replacement.service.prepareCalendarEvent({ title: 'B', start: '2026-10-08T11:00', timezone: 'UTC' }, { ...session, userMessage: 'cambialo a las 11' });
    assert.equal(replacement.pendingActions.list({ sessionId: 's1' }).length, 1);
    assert.notEqual(action(replacement.pendingActions).id, previous.id);
    await replacement.service.resolvePendingAction({ intent: 'cancel', selection: null }, { ...session, userMessage: 'cancelalo', userMessageSource: 'direct_user' });
    assert.equal(replacement.pendingActions.list({ sessionId: 's1' }).length, 0);
    assert.equal(replacement.calls.some(([kind]) => kind === 'create'), false);

    const failed = setup({ writeResults: { create: { success: false, error: { code: 'microsoft_access_denied', message: 'Permission required.' } } } });
    await failed.service.prepareCalendarEvent({ title: 'X', start: '2026-10-08T10:00', timezone: 'UTC' }, session);
    const result = await direct(failed.service, 'crealo');
    assert.equal(result.success, false);
    assert.equal(result.created, undefined);
});

test('DST gap and repeated local times are rejected rather than assigned arbitrary offsets', () => {
    assert.equal(utcForLocalDateTime('2026-03-08T02:30', 'America/New_York'), null);
    assert.equal(utcForLocalDateTime('2026-11-01T01:30', 'America/New_York'), null);
    assert.equal(utcForLocalDateTime('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z');
});

test('Microsoft Graph uses bounded calendar write endpoints and correct attendee semantics', async () => {
    const calls = [];
    const provider = createMicrosoftGraphProvider({ environment, auth: { async getAccessToken() { return 'token'; } }, fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'DELETE') return { ok: true, status: 204, async json() { return null; } };
        return { ok: true, status: options.method === 'POST' ? 201 : 200, async json() { return { id: 'g1', subject: 'New', start: { dateTime: '2026-10-08T14:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-08T15:00:00', timeZone: 'UTC' }, isOrganizer: true, attendees: [] }; } };
    } });
    const created = await provider.createCalendarEvent({ event: { title: 'New', startDateTime: '2026-10-08T14:00:00.000Z', endDateTime: '2026-10-08T15:00:00.000Z', attendees: ['maria@example.com'], description: 'Details', location: 'Office' } });
    assert.equal(created.success, true);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].url.pathname, '/v1.0/me/calendar/events');
    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body.attendees[0].emailAddress, { address: 'maria@example.com' });
    assert.equal(body.start.timeZone, 'UTC');

    await provider.updateCalendarEvent({ providerEventId: 'g1', patch: { title: 'Changed', startDateTime: '2026-10-08T15:00:00.000Z', endDateTime: '2026-10-08T16:00:00.000Z' } });
    assert.equal(calls[1].options.method, 'PATCH');
    assert.equal(calls[1].url.pathname, '/v1.0/me/events/g1');
    await provider.cancelCalendarEvent({ providerEventId: 'g1', sendMeetingCancellation: true });
    assert.equal(calls[2].options.method, 'POST');
    assert.equal(calls[2].url.pathname, '/v1.0/me/events/g1/cancel');
    await provider.cancelCalendarEvent({ calendarAddress: 'ops@example.com', providerEventId: 'g1', sendMeetingCancellation: false });
    assert.equal(calls[3].options.method, 'DELETE');
    assert.equal(calls[3].url.pathname, '/v1.0/users/ops%40example.com/events/g1');
    const blocked = await provider.createCalendarEvent({ calendarAddress: 'unknown@example.com', event: {} });
    assert.equal(blocked.success, false);
    assert.equal(calls.length, 4);
});
