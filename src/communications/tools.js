import { communicationsService } from './default.js';

function statusTool(name, description) {
    return { type: 'function', name, description,
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true };
}
export const getEmailConnectionStatusTool = statusTool('get_email_connection_status', 'Informa si Nexa está conectada a Microsoft y la dirección de la cuenta autenticada. No lee mensajes.');
export const listEmailMailboxesTool = statusTool('list_email_mailboxes', 'Lista el buzón personal autenticado y los shared mailboxes configurados que Microsoft Graph valida. No lee mensajes.');
export const communicationsRegistrations = [
    { definition: getEmailConnectionStatusTool, execute: () => communicationsService.getConnectionStatus() },
    { definition: listEmailMailboxesTool, execute: () => communicationsService.getMailboxes() },
];
