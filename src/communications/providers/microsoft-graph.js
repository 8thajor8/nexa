import { getMicrosoftConfiguration } from '../config.js';
import { MicrosoftAuthError } from '../../integrations/microsoft/auth.js';

const graphRoot = 'https://graph.microsoft.com/v1.0/';

export function normalizeMailbox({ id, address, displayName, type }) {
    if (![id, address].every(value => typeof value === 'string' && value.trim()) || !['personal', 'shared'].includes(type)) return null;
    return { id: id.trim(), provider: 'microsoft', address: address.trim().toLocaleLowerCase('en-US'),
        displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : address.trim(), type };
}

function graphError(status) {
    if (status === 401) return { code: 'microsoft_authorization_required', message: 'La sesión Microsoft venció o necesita reconectarse.' };
    if (status === 403) return { code: 'microsoft_access_denied', message: 'Microsoft no permite leer este buzón con la autorización o los accesos delegados actuales.' };
    if (status === 404) return { code: 'microsoft_mailbox_not_found', message: 'Microsoft Graph no encontró el buzón configurado.' };
    if (status === 429) return { code: 'microsoft_rate_limited', message: 'Microsoft Graph pidió reducir la frecuencia de solicitudes.' };
    return { code: 'microsoft_graph_unavailable', message: 'No se pudo consultar Microsoft Graph.' };
}

export function createMicrosoftGraphProvider({ auth, fetchImpl = fetch, environment = process.env } = {}) {
    async function request(resource) {
        let accessToken;
        try { accessToken = await auth.getAccessToken(); }
        catch (error) {
            if (error instanceof MicrosoftAuthError) return { success: false, error: { code: error.code, message: error.message } };
            return { success: false, error: { code: 'microsoft_authentication_failed', message: 'No se pudo obtener una sesión Microsoft válida.' } };
        }
        if (!accessToken) return { success: false, error: { code: 'email_not_connected', message: 'Microsoft todavía no está conectado. Ejecutá npm run connect:microsoft.' } };
        let response;
        try { response = await fetchImpl(new URL(resource, graphRoot), { method: 'GET', headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }); }
        catch { return { success: false, error: { code: 'microsoft_network_error', message: 'No se pudo conectar con Microsoft Graph.' } }; }
        if (!response.ok) return { success: false, error: graphError(response.status) };
        try { return { success: true, data: await response.json() }; }
        catch { return { success: false, error: { code: 'microsoft_response_invalid', message: 'Microsoft Graph devolvió una respuesta no válida.' } }; }
    }
    async function getConnectionStatus() {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) return { success: true, connected: false, provider: 'microsoft', reason: 'configuration_missing' };
        const response = await request('me?$select=id,displayName,mail,userPrincipalName');
        if (!response.success) return response.error.code === 'email_not_connected'
            ? { success: true, connected: false, provider: 'microsoft' } : response;
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
        const account = normalizeMailbox({ id: personal.data.id, address: personal.data.mail ?? personal.data.userPrincipalName,
            displayName: personal.data.displayName, type: 'personal' });
        if (!account) return { success: false, error: { code: 'microsoft_identity_invalid', message: 'Microsoft no devolvió una identidad de buzón válida.' } };
        const mailboxes = [account], sharedMailboxIssues = [];
        for (const address of config.sharedMailboxes) {
            if (address === account.address) continue;
            const validation = await request(`users/${encodeURIComponent(address)}/mailFolders/inbox?$select=id`);
            if (!validation.success) { sharedMailboxIssues.push({ address, code: validation.error.code }); continue; }
            mailboxes.push(normalizeMailbox({ id: address, address, displayName: address, type: 'shared' }));
        }
        return { success: true, mailboxes, sharedMailboxIssues };
    }
    return { getConnectionStatus, getMailboxes };
}
