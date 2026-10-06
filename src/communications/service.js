import { randomBytes } from 'node:crypto';

const limitMax = 25;
const safeError = { success: false, error: { code: 'communications_unavailable', message: 'El servicio de correo no está disponible en este momento.' } };
function normalizeAlias(value) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase('es-ES').normalize('NFD').replace(/\p{Diacritic}/gu, '') : '';
}
export function createCommunicationsService({ emailProvider }) {
    if (!emailProvider || typeof emailProvider.getConnectionStatus !== 'function' || typeof emailProvider.getMailboxes !== 'function') throw new TypeError('email_provider_invalid');
    const messageReferences = new Map();
    async function safelyCall(operation) {
        try { return await operation(); } catch { return safeError; }
    }
    function boundedLimit(limit) { return Number.isInteger(limit) ? Math.max(1, Math.min(limitMax, limit)) : 10; }
    async function selectMailbox(reference) {
        const result = await emailProvider.getMailboxes();
        if (!result?.success || !Array.isArray(result.mailboxes)) return result?.success === false ? result : safeError;
        if (!reference) return result.mailboxes.find(item => item.type === 'personal') ?? null;
        const alias = normalizeAlias(reference);
        const matches = result.mailboxes.filter(item => {
            const address = normalizeAlias(item.address), local = address.split('@')[0];
            if (alias === address || alias === local || alias === normalizeAlias(item.displayName)) return true;
            return item.type === 'personal' && ['me', 'my email', 'my mailbox', 'mi correo', 'mi buzon', 'mi buzon de correo'].includes(alias);
        });
        return matches.length === 1 ? matches[0] : null;
    }
    function attachReferences(messages, mailbox) {
        return messages.map(message => {
            const id = 'email_' + randomBytes(12).toString('hex');
            messageReferences.set(id, { mailboxAddress: mailbox.address, providerMessageId: message.providerMessageId });
            const { providerMessageId: _internal, ...publicMessage } = message;
            return { ...publicMessage, id, mailbox: mailbox.address };
        });
    }
    async function withMailbox(args, operation) {
        const mailbox = await selectMailbox(args.mailbox);
        if (!mailbox) return { success: false, error: { code: 'mailbox_not_found_or_ambiguous', message: 'No pude identificar un único buzón. Indicá su dirección o un nombre inequívoco.' } };
        return operation(mailbox);
    }
    return {
        getConnectionStatus: () => safelyCall(() => emailProvider.getConnectionStatus()),
        getMailboxes: () => safelyCall(() => emailProvider.getMailboxes()),
        listRecentEmails: args => safelyCall(() => withMailbox(args ?? {}, async mailbox => {
            if (typeof emailProvider.listRecentEmails !== 'function') return safeError;
            const result = await emailProvider.listRecentEmails({ mailbox, limit: boundedLimit(args?.limit) });
            return result?.success ? { success: true, emails: attachReferences(result.emails ?? [], mailbox) } : result;
        })),
        searchEmails: args => safelyCall(() => withMailbox(args ?? {}, async mailbox => {
            if (typeof emailProvider.searchEmails !== 'function') return safeError;
            const result = await emailProvider.searchEmails({ ...args, mailbox, limit: boundedLimit(args?.limit) });
            return result?.success ? { success: true, emails: attachReferences(result.emails ?? [], mailbox) } : result;
        })),
        getEmail: args => safelyCall(async () => {
            const reference = typeof args?.id === 'string' ? messageReferences.get(args.id) : null;
            if (!reference || typeof emailProvider.getEmail !== 'function') return { success: false, error: { code: 'email_reference_invalid', message: 'La referencia del correo no existe o venció. Buscalo nuevamente.' } };
            const result = await emailProvider.getEmail(reference);
            if (!result?.success) return result;
            const { providerMessageId: _internal, ...email } = result.email;
            return { success: true, email: { ...email, id: args.id, mailbox: reference.mailboxAddress } };
        }),
    };
}
