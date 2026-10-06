import { randomBytes } from 'node:crypto';
import { getMicrosoftConfiguration } from '../config.js';
import { MicrosoftAuthError } from '../../integrations/microsoft/auth.js';

const graphRoot = 'https://graph.microsoft.com/v1.0/';
const messageFields = 'id,subject,from,replyTo,toRecipients,ccRecipients,receivedDateTime,bodyPreview,hasAttachments,isRead,importance';
const maximumBodyLength = 12000;

function base64Lines(value) { return Buffer.from(value).toString('base64').replace(/.{1,76}/gu, '$&\r\n').trimEnd(); }
function encodedHeader(value) {
    return /^[\x20-\x7e]*$/u.test(value) ? value : '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=';
}
function createRelatedMime({ from, to, cc = [], subject, htmlBody, inlineAttachments = [] }) {
    const boundary = 'nexa_' + randomBytes(18).toString('hex');
    const headers = ['From: ' + from, 'To: ' + to.join(', '), ...(cc.length ? ['Cc: ' + cc.join(', ')] : []),
        'Subject: ' + encodedHeader(subject), 'MIME-Version: 1.0', 'Content-Type: multipart/related; boundary="' + boundary + '"', '', ''];
    const parts = ['--' + boundary, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', base64Lines(htmlBody)];
    for (const attachment of inlineAttachments) {
        parts.push('--' + boundary, 'Content-Type: ' + attachment.contentType + '; name="' + attachment.name + '"',
            'Content-Transfer-Encoding: base64', 'Content-ID: <' + attachment.contentId + '>',
            'Content-Disposition: inline; filename="' + attachment.name + '"', '', base64Lines(Buffer.from(attachment.contentBytes, 'base64')));
    }
    parts.push('--' + boundary + '--', '');
    return headers.join('\r\n') + parts.join('\r\n');
}

export function normalizeMailbox({ id, address, displayName, type }) {
    if (![id, address].every(value => typeof value === 'string' && value.trim()) || !['personal', 'shared'].includes(type)) return null;
    return { id: id.trim(), provider: 'microsoft', address: address.trim().toLocaleLowerCase('en-US'),
        displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : address.trim(), type };
}
function graphError(status, writing = false, resourceKind = 'mail') {
    if (status === 401) return { code: 'microsoft_authorization_required', message: 'La sesión Microsoft venció o necesita reconectarse.' };
    if (status === 403) return { code: 'microsoft_access_denied', message: resourceKind === 'calendar'
        ? writing ? 'Microsoft no autorizó esta escritura de calendario. Verificá los permisos delegados Calendars.ReadWrite y el acceso de edición al calendario compartido.' : 'Microsoft no permite leer este calendario con la autorización o los accesos delegados actuales.'
        : writing ? 'Microsoft no autorizó este envío. Para un shared mailbox, verificá Mail.Send.Shared y los permisos Exchange Send As o Send on Behalf.' : 'Microsoft no permite leer este buzón con la autorización o los accesos delegados actuales.' };
    if (status === 404) return resourceKind === 'calendar'
        ? { code: 'microsoft_calendar_not_found', message: 'Microsoft Graph no encontró el calendario o evento.' }
        : { code: 'microsoft_mailbox_not_found', message: 'Microsoft Graph no encontró el buzón o mensaje.' };
    if (status === 429) return { code: 'microsoft_rate_limited', message: 'Microsoft Graph pidió reducir la frecuencia de solicitudes.' };
    if (status === 400) return { code: 'microsoft_request_invalid', message: 'Microsoft Graph rechazó los datos de la solicitud.' };
    return { code: 'microsoft_graph_unavailable', message: 'No se pudo completar la operación con Microsoft Graph.' };
}
const entityMap = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(text) {
    return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (whole, entity) => {
        if (entity[0] !== '#') return entityMap[entity.toLocaleLowerCase('en-US')] ?? whole;
        const hex = entity[1]?.toLocaleLowerCase('en-US') === 'x';
        const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    });
}
export function htmlToSafeText(html) {
    if (typeof html !== 'string') return '';
    let text = html.replace(/<!--[\s\S]*?-->/gu, ' ')
        .replace(/<(script|style|head|iframe|object|svg|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
        .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article)\s*>/giu, '\n')
        .replace(/<li\b[^>]*>/giu, '• ')
        .replace(/<a\b[^>]*href\s*=\s*(['"])(https?:\/\/[^'"]+)\1[^>]*>([\s\S]*?)<\/a\s*>/giu, (_m, _q, url, label) => label.replace(/<[^>]*>/gu, '') + ' (' + url + ')')
        .replace(/<[^>]*>/gu, ' ');
    text = decodeEntities(text).replace(/[\t\f\v ]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
    return text.slice(0, maximumBodyLength);
}
function person(value) { return { name: typeof value?.emailAddress?.name === 'string' ? value.emailAddress.name : '', address: typeof value?.emailAddress?.address === 'string' ? value.emailAddress.address : '' }; }
function recipientList(values) { return Array.isArray(values) ? values.map(person).filter(item => item.address || item.name) : []; }
function graphEventInstant(value) {
    const raw = typeof value?.dateTime === 'string' ? value.dateTime : '';
    const instant = new Date(/[zZ]|[+-]\d{2}:\d{2}$/u.test(raw) ? raw : raw + 'Z');
    return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}
function normalizeGraphCalendarEvent(event, { includeBody = false } = {}) {
    const startDateTime = graphEventInstant(event?.start), endDateTime = graphEventInstant(event?.end);
    if (typeof event?.id !== 'string' || !startDateTime || !endDateTime) return null;
    const bodyHtml = event?.body?.contentType?.toLocaleLowerCase('en-US') === 'html';
    return {
        providerEventId: event.id,
        subject: typeof event.subject === 'string' ? event.subject : '(Sin asunto)',
        startDateTime, endDateTime, isAllDay: event.isAllDay === true,
        isOrganizer: event.isOrganizer === true,
        location: typeof event.location?.displayName === 'string' ? { displayName: event.location.displayName.slice(0, 300) } : null,
        organizer: person(event.organizer), attendees: recipientList(event.attendees).slice(0, 50),
        preview: typeof event.bodyPreview === 'string' ? event.bodyPreview.slice(0, 500) : '',
        body: includeBody ? (bodyHtml ? htmlToSafeText(event.body.content) : String(event?.body?.content ?? '').slice(0, 3000)) : '',
    };
}
export function normalizeEmail(message, mailbox, { includeBody = false } = {}) {
    return {
        providerMessageId: message?.id, mailbox: mailbox.address,
        subject: typeof message?.subject === 'string' ? message.subject : '',
        from: person(message?.from), replyTo: recipientList(message?.replyTo),
        to: recipientList(message?.toRecipients), cc: recipientList(message?.ccRecipients),
        receivedAt: typeof message?.receivedDateTime === 'string' ? message.receivedDateTime : null,
        preview: typeof message?.bodyPreview === 'string' ? message.bodyPreview.slice(0, 1000) : '',
        body: includeBody ? (message?.body?.contentType?.toLocaleLowerCase('en-US') === 'html' ? htmlToSafeText(message.body.content) : String(message?.body?.content ?? '').slice(0, maximumBodyLength)) : '',
        bodyType: includeBody ? 'text' : null, hasAttachments: message?.hasAttachments === true,
        isRead: message?.isRead === true, importance: ['low', 'normal', 'high'].includes(message?.importance) ? message.importance : 'normal',
    };
}
function emailList(data, mailbox) {
    return Array.isArray(data?.value) ? data.value.map(item => normalizeEmail(item, mailbox)).sort((a, b) => Date.parse(b.receivedAt ?? '') - Date.parse(a.receivedAt ?? '')) : [];
}
function searchTokens(value) {
    return String(value).normalize('NFC').match(/[\p{L}\p{N}@._+-]+/gu)?.slice(0, 12) ?? [];
}
function kqlDate(value) { const [year, month, day] = value.split('-'); return month + '/' + day + '/' + year; }
function buildSearchQuery({ query, from, subject, dateFrom, dateTo }) {
    const parts = [];
    const freeTokens = query?.trim() ? searchTokens(query) : [];
    if (freeTokens.length) parts.push('(' + freeTokens.map(token => '(body:' + token + ' OR subject:' + token + ' OR from:' + token + ')').join(' AND ') + ')');
    const fromTokens = from?.trim() ? searchTokens(from) : [];
    if (fromTokens.length) parts.push(...fromTokens.map(token => 'from:' + token));
    const subjectTokens = subject?.trim() ? searchTokens(subject) : [];
    if (subjectTokens.length) parts.push(...subjectTokens.map(token => 'subject:' + token));
    if (dateFrom) parts.push('received>=' + kqlDate(dateFrom));
    if (dateTo) parts.push('received<=' + kqlDate(dateTo));
    return parts.join(' AND ');
}
function validSearchArgs(args) {
    const date = value => value === undefined || value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')));
    return ['query', 'from', 'subject'].every(key => (args[key] === undefined || args[key] === null) || (typeof args[key] === 'string' && args[key].trim().length <= 160))
        && date(args.dateFrom) && date(args.dateTo) && (!args.dateFrom || !args.dateTo || args.dateFrom <= args.dateTo);
}
export function createMicrosoftGraphProvider({ auth, fetchImpl = fetch, environment = process.env } = {}) {
    async function request(resource, { preferText = false, preferTimezone = null, resourceKind = 'mail', method = 'GET', jsonBody, rawBody, contentType = 'application/json' } = {}) {
        let accessToken;
        try { accessToken = await auth.getAccessToken(); }
        catch (error) {
            if (error instanceof MicrosoftAuthError) return { success: false, error: { code: error.code, message: error.message } };
            return { success: false, error: { code: 'microsoft_authentication_failed', message: 'No se pudo obtener una sesión Microsoft válida.' } };
        }
        if (!accessToken) return { success: false, error: { code: 'email_not_connected', message: 'Microsoft todavía no está conectado. Ejecutá npm run connect:microsoft.' } };
        const headers = { authorization: 'Bearer ' + accessToken, accept: 'application/json' };
        const preferences = [];
        if (preferText) preferences.push('outlook.body-content-type="text"');
        if (preferTimezone) preferences.push('outlook.timezone="' + preferTimezone + '"');
        if (preferences.length) headers.prefer = preferences.join(', ');
        const options = { method, headers };
        if (jsonBody !== undefined) { headers['content-type'] = contentType; options.body = JSON.stringify(jsonBody); }
        else if (rawBody !== undefined) { headers['content-type'] = contentType; options.body = rawBody; }
        let response;
        try { response = await fetchImpl(new URL(resource, graphRoot), options); }
        catch { return { success: false, error: { code: 'microsoft_network_error', message: 'No se pudo conectar con Microsoft Graph.' } }; }
        if (!response.ok) return { success: false, error: graphError(response.status, method !== 'GET', resourceKind) };
        if (response.status === 202 || response.status === 204) return { success: true, data: null };
        try { return { success: true, data: await response.json() }; }
        catch { return { success: false, error: { code: 'microsoft_response_invalid', message: 'Microsoft Graph devolvió una respuesta no válida.' } }; }
    }
    function mailboxMessagesPath(mailbox, inbox = false) {
        const owner = encodeURIComponent(mailbox.address);
        return inbox ? 'users/' + owner + '/mailFolders/inbox/messages' : 'users/' + owner + '/messages';
    }
    async function getConnectionStatus() {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: true, connected: false, provider: 'microsoft', reason: 'configuration_missing' };
        const response = await request('me?$select=id,displayName,mail,userPrincipalName');
        if (!response.success) return response.error.code === 'email_not_connected' ? { success: true, connected: false, provider: 'microsoft' } : response;
        const address = response.data.mail ?? response.data.userPrincipalName;
        const mailbox = normalizeMailbox({ id: response.data.id, address, displayName: response.data.displayName, type: 'personal' });
        if (!mailbox) return { success: false, error: { code: 'microsoft_identity_invalid', message: 'Microsoft no devolvió una identidad de buzón válida.' } };
        return { success: true, connected: true, provider: 'microsoft', account: mailbox.address };
    }
    async function getMailboxes() {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: false, error: config.error };
        const personal = await request('me?$select=id,displayName,mail,userPrincipalName');
        if (!personal.success) return personal;
        const account = normalizeMailbox({ id: personal.data.id, address: personal.data.mail ?? personal.data.userPrincipalName, displayName: personal.data.displayName, type: 'personal' });
        if (!account) return { success: false, error: { code: 'microsoft_identity_invalid', message: 'Microsoft no devolvió una identidad de buzón válida.' } };
        const mailboxes = [account], sharedMailboxIssues = [];
        for (const address of config.sharedMailboxes) {
            if (address === account.address) continue;
            const validation = await request('users/' + encodeURIComponent(address) + '/mailFolders/inbox?$select=id');
            if (!validation.success) { sharedMailboxIssues.push({ address, code: validation.error.code }); continue; }
            mailboxes.push(normalizeMailbox({ id: address, address, displayName: address, type: 'shared' }));
        }
        return { success: true, mailboxes, sharedMailboxIssues };
    }
    async function listRecentEmails({ mailbox, limit = 10 }) {
        const params = new URLSearchParams({ '$select': messageFields, '$orderby': 'receivedDateTime desc', '$top': String(limit) });
        const response = await request(mailboxMessagesPath(mailbox, true) + '?' + params);
        return response.success ? { success: true, emails: emailList(response.data, mailbox) } : response;
    }
    async function searchEmails(args) {
        const search = buildSearchQuery(args);
        if (!validSearchArgs(args) || !search) return { success: false, error: { code: 'email_search_invalid', message: 'Indicá un criterio de búsqueda válido y fechas en formato AAAA-MM-DD.' } };
        const params = new URLSearchParams({ '$select': messageFields, '$top': String(args.limit ?? 10), '$search': '"' + search + '"' });
        const response = await request(mailboxMessagesPath(args.mailbox) + '?' + params);
        return response.success ? { success: true, emails: emailList(response.data, args.mailbox) } : response;
    }
    async function getEmail({ mailboxAddress, providerMessageId }) {
        if (typeof mailboxAddress !== 'string' || typeof providerMessageId !== 'string' || !providerMessageId || providerMessageId.length > 512) return { success: false, error: { code: 'email_reference_invalid', message: 'La referencia del correo no es válida.' } };
        const owner = encodeURIComponent(mailboxAddress), messageId = encodeURIComponent(providerMessageId);
        const response = await request('users/' + owner + '/messages/' + messageId + '?$select=' + messageFields + ',body', { preferText: true });
        return response.success ? { success: true, email: normalizeEmail(response.data, { address: mailboxAddress }, { includeBody: true }) } : response;
    }
    async function listCalendarEvents({ calendarAddress = null, startDateTime, endDateTime, limit = 25 }) {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: false, error: config.error };
        if (calendarAddress && !config.sharedCalendars.includes(String(calendarAddress).toLocaleLowerCase('en-US'))) {
            return { success: false, error: { code: 'calendar_not_configured', message: 'Ese calendario compartido no está en la lista configurada.' } };
        }
        const owner = calendarAddress ? 'users/' + encodeURIComponent(calendarAddress) : 'me';
        const params = new URLSearchParams({ startDateTime, endDateTime, '$select': 'id,subject,start,end,isAllDay,isOrganizer,location,organizer,attendees,bodyPreview', '$top': String(Math.max(1, Math.min(50, limit))) });
        const response = await request(owner + '/calendarView?' + params, { preferTimezone: 'UTC', resourceKind: 'calendar' });
        if (!response.success) return response;
        if (!Array.isArray(response.data?.value)) return { success: false, error: { code: 'calendar_response_invalid', message: 'Microsoft Graph devolvió una lista de eventos no válida.' } };
        return { success: true, events: response.data.value.map(item => normalizeGraphCalendarEvent(item)).filter(Boolean), truncated: Boolean(response.data['@odata.nextLink']) || response.data.value.length >= Number(params.get('$top')) };
    }
    async function getCalendarEvent({ calendarAddress = null, providerEventId }) {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: false, error: config.error };
        if (calendarAddress && !config.sharedCalendars.includes(String(calendarAddress).toLocaleLowerCase('en-US'))) {
            return { success: false, error: { code: 'calendar_not_configured', message: 'Ese calendario compartido no está en la lista configurada.' } };
        }
        if (typeof providerEventId !== 'string' || !providerEventId || providerEventId.length > 512) return { success: false, error: { code: 'calendar_reference_invalid', message: 'La referencia del evento no es válida.' } };
        const owner = calendarAddress ? 'users/' + encodeURIComponent(calendarAddress) : 'me';
        const eventId = encodeURIComponent(providerEventId);
        const fields = 'id,subject,start,end,isAllDay,isOrganizer,location,organizer,attendees,bodyPreview,body';
        const response = await request(owner + '/events/' + eventId + '?$select=' + fields, { preferText: true, preferTimezone: 'UTC', resourceKind: 'calendar' });
        if (!response.success) return response;
        const event = normalizeGraphCalendarEvent(response.data, { includeBody: true });
        return event ? { success: true, event } : { success: false, error: { code: 'calendar_event_invalid', message: 'Microsoft Graph devolvió un evento no válido.' } };
    }
    function calendarOwner(calendarAddress) { return calendarAddress ? 'users/' + encodeURIComponent(calendarAddress) : 'me'; }
    function calendarWritePath(calendarAddress, providerEventId = null) {
        const owner = calendarOwner(calendarAddress);
        return owner + (providerEventId ? '/events/' + encodeURIComponent(providerEventId) : '/calendar/events');
    }
    function graphDateTime(instant) {
        const value = new Date(instant);
        if (!Number.isFinite(value.getTime())) return null;
        return { dateTime: value.toISOString().replace(/Z$/u, ''), timeZone: 'UTC' };
    }
    async function createCalendarEvent({ calendarAddress = null, event }) {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: false, error: config.error };
        if (calendarAddress && !config.sharedCalendars.includes(String(calendarAddress).toLocaleLowerCase('en-US'))) return { success: false, error: { code: 'calendar_not_configured', message: 'Ese calendario compartido no está en la lista configurada.' } };
        const start = graphDateTime(event?.startDateTime), end = graphDateTime(event?.endDateTime);
        if (!start || !end || Date.parse(event.endDateTime) <= Date.parse(event.startDateTime)) return { success: false, error: { code: 'calendar_event_invalid', message: 'El horario del evento no es válido.' } };
        const attendees = Array.isArray(event.attendees) ? event.attendees.map(address => ({ emailAddress: { address }, type: 'required' })) : [];
        const jsonBody = { subject: event.title, start, end, attendees,
            body: { contentType: 'text', content: event.description ?? '' },
            ...(event.location ? { location: { displayName: event.location } } : {}) };
        const response = await request(calendarWritePath(calendarAddress), { method: 'POST', jsonBody, resourceKind: 'calendar' });
        if (!response.success) return response;
        const created = normalizeGraphCalendarEvent(response.data);
        return created ? { success: true, event: created } : { success: false, error: { code: 'calendar_response_invalid', message: 'Microsoft Graph no devolvió el evento creado.' } };
    }
    async function updateCalendarEvent({ calendarAddress = null, providerEventId, patch }) {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: false, error: config.error };
        if (calendarAddress && !config.sharedCalendars.includes(String(calendarAddress).toLocaleLowerCase('en-US'))) return { success: false, error: { code: 'calendar_not_configured', message: 'Ese calendario compartido no está en la lista configurada.' } };
        if (typeof providerEventId !== 'string' || !providerEventId || providerEventId.length > 512) return { success: false, error: { code: 'calendar_reference_invalid', message: 'La referencia del evento no es válida.' } };
        const jsonBody = {};
        if (patch?.title !== undefined) jsonBody.subject = patch.title;
        if (patch?.startDateTime !== undefined) jsonBody.start = graphDateTime(patch.startDateTime);
        if (patch?.endDateTime !== undefined) jsonBody.end = graphDateTime(patch.endDateTime);
        if (patch?.location !== undefined) jsonBody.location = { displayName: patch.location };
        if (!Object.keys(jsonBody).length || (jsonBody.start === null) || (jsonBody.end === null)) return { success: false, error: { code: 'calendar_event_invalid', message: 'No hay cambios válidos para aplicar al evento.' } };
        const response = await request(calendarWritePath(calendarAddress, providerEventId), { method: 'PATCH', jsonBody, preferTimezone: 'UTC', resourceKind: 'calendar' });
        if (!response.success) return response;
        const event = normalizeGraphCalendarEvent(response.data);
        return event ? { success: true, event } : { success: false, error: { code: 'calendar_response_invalid', message: 'Microsoft Graph no devolvió el evento modificado.' } };
    }
    async function cancelCalendarEvent({ calendarAddress = null, providerEventId, sendMeetingCancellation = false }) {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: false, error: config.error };
        if (calendarAddress && !config.sharedCalendars.includes(String(calendarAddress).toLocaleLowerCase('en-US'))) return { success: false, error: { code: 'calendar_not_configured', message: 'Ese calendario compartido no está en la lista configurada.' } };
        if (typeof providerEventId !== 'string' || !providerEventId || providerEventId.length > 512) return { success: false, error: { code: 'calendar_reference_invalid', message: 'La referencia del evento no es válida.' } };
        const eventPath = calendarWritePath(calendarAddress, providerEventId);
        const response = sendMeetingCancellation
            ? await request(eventPath + '/cancel', { method: 'POST', jsonBody: {}, resourceKind: 'calendar' })
            : await request(eventPath, { method: 'DELETE', resourceKind: 'calendar' });
        return response.success ? { success: true, cancelled: true, notificationSent: sendMeetingCancellation } : response;
    }
    async function sendEmail({ mailboxAddress, to, cc, subject, bodyHtml, inlineAttachments }) {
        const mimeBody = createRelatedMime({ from: mailboxAddress, to, cc, subject, htmlBody: bodyHtml, inlineAttachments });
        const response = await request('users/' + encodeURIComponent(mailboxAddress) + '/sendMail', {
            method: 'POST', rawBody: Buffer.from(mimeBody, 'utf8').toString('base64'), contentType: 'text/plain',
        });
        return response.success ? { success: true, sent: true } : response;
    }
    async function sendReply({ mailboxAddress, providerMessageId, to, cc, subject, bodyHtml, inlineAttachments }) {
        const mimeBody = createRelatedMime({ from: mailboxAddress, to, cc, subject, htmlBody: bodyHtml, inlineAttachments });
        const response = await request('users/' + encodeURIComponent(mailboxAddress) + '/messages/' + encodeURIComponent(providerMessageId) + '/reply', {
            method: 'POST', rawBody: Buffer.from(mimeBody, 'utf8').toString('base64'), contentType: 'text/plain',
        });
        return response.success ? { success: true, sent: true } : response;
    }
    return { getConnectionStatus, getMailboxes, listRecentEmails, searchEmails, getEmail, listCalendarEvents, getCalendarEvent, createCalendarEvent, updateCalendarEvent, cancelCalendarEvent, sendEmail, sendReply };
}
