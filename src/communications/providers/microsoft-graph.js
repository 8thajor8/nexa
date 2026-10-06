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
function graphError(status, writing = false) {
    if (status === 401) return { code: 'microsoft_authorization_required', message: 'La sesión Microsoft venció o necesita reconectarse.' };
    if (status === 403) return { code: 'microsoft_access_denied', message: writing
        ? 'Microsoft no autorizó este envío. Para un shared mailbox, verificá Mail.Send.Shared y los permisos Exchange Send As o Send on Behalf.'
        : 'Microsoft no permite leer este buzón con la autorización o los accesos delegados actuales.' };
    if (status === 404) return { code: 'microsoft_mailbox_not_found', message: 'Microsoft Graph no encontró el buzón o mensaje.' };
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
    async function request(resource, { preferText = false, method = 'GET', jsonBody, rawBody, contentType = 'application/json' } = {}) {
        let accessToken;
        try { accessToken = await auth.getAccessToken(); }
        catch (error) {
            if (error instanceof MicrosoftAuthError) return { success: false, error: { code: error.code, message: error.message } };
            return { success: false, error: { code: 'microsoft_authentication_failed', message: 'No se pudo obtener una sesión Microsoft válida.' } };
        }
        if (!accessToken) return { success: false, error: { code: 'email_not_connected', message: 'Microsoft todavía no está conectado. Ejecutá npm run connect:microsoft.' } };
        const headers = { authorization: 'Bearer ' + accessToken, accept: 'application/json' };
        if (preferText) headers.prefer = 'outlook.body-content-type="text"';
        const options = { method, headers };
        if (jsonBody !== undefined) { headers['content-type'] = contentType; options.body = JSON.stringify(jsonBody); }
        else if (rawBody !== undefined) { headers['content-type'] = contentType; options.body = rawBody; }
        let response;
        try { response = await fetchImpl(new URL(resource, graphRoot), options); }
        catch { return { success: false, error: { code: 'microsoft_network_error', message: 'No se pudo conectar con Microsoft Graph.' } }; }
        if (!response.ok) return { success: false, error: graphError(response.status, method !== 'GET') };
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
    return { getConnectionStatus, getMailboxes, listRecentEmails, searchEmails, getEmail, sendEmail, sendReply };
}
