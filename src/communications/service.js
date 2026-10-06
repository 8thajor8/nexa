import { randomBytes } from 'node:crypto';
import { createPendingActionManager } from '../core/pending-actions.js';
import { emailSignatureRenderer } from './signature/renderer.js';
import { createCalendarService } from './calendar-service.js';

const limitMax = 25;
const maxRecipients = 20;
const maxBodyLength = 20000;
const safeError = { success: false, error: { code: 'communications_unavailable', message: 'El servicio de correo no está disponible en este momento.' } };
const mailPattern = /^[^@\s<>]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/iu;
function normalizeAlias(value) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase('es-ES').normalize('NFD').replace(/\p{Diacritic}/gu, '') : '';
}
function validAddresses(values, { required = false } = {}) {
    if (!Array.isArray(values) || (required && values.length === 0) || values.length > maxRecipients) return null;
    const normalized = values.map(value => typeof value === 'string' ? value.trim() : '');
    if (normalized.some(value => value.length > 254 || /[\r\n<>]/u.test(value) || !mailPattern.test(value))) return null;
    return [...new Set(normalized.map(value => value.toLocaleLowerCase('en-US')))];
}
function validSubject(subject) { return typeof subject === 'string' && subject.trim().length > 0 && subject.trim().length <= 255 && !/[\r\n]/u.test(subject); }
function validBody(body) { return typeof body === 'string' && body.trim().length > 0 && body.length <= maxBodyLength && !body.includes('\0'); }
function formatPreview({ from, to, cc, subject, body }) {
    return ['De: ' + from, 'Para: ' + (to.join(', ') || '—'), 'CC: ' + (cc.join(', ') || '—'), 'Asunto: ' + subject, '', body].join('\n');
}
function pendingResult(action) {
    const { type, preview, expiresAt } = action;
    return { success: true, pendingAction: { type, preview, expiresAt },
        nextStep: 'Revisá la vista previa. Si está bien, respondé naturalmente: ¿Lo envío? También podés pedirme que lo modifique o cancelarlo.' };
}

function normalizedText(value) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/\p{Diacritic}/gu, '') : '';
}
function directActionCue(message) {
    const text = normalizedText(message);
    if (!text || text.length > 160 || /["“”'‘’`]/u.test(text)) return null;
    if (/\b(pero|aunque|cambi|modific|corrig|agreg|sac[ae]|reemplaz|asunto|destinatari|cuerpo|texto|antes de|si\s+(?:podes|puedes|podrias|podrías)|en vez de)\b/u.test(text)) return 'modify';
    if (/^(?:ningun[oa]s?|olvidate|dejalo|dejala|cancelalos|cancelalas)(?:[.!\s]*)$/u.test(text)) return 'cancel_all';
    if (/^(?:cancelalo|cancelala|cancelar|no lo mandes|no la envies|no lo envies|no enviar)(?:[.!\s]*)$/u.test(text)) return 'cancel';
    if (/^(?:no(?:\s+gracias)?|mejor no|todavia no|aun no)(?:[.!\s]*)$/u.test(text)) return 'reject';
    if (/^(?:si|dale|ok(?:ay)?|de acuerdo|confirmo|confirmado|mandalo|mandala|envialo|enviala|envia(?:lo|la)?|hacelo|hacela|adelante|perfecto|listo|vamos|hagamoslo|metele|va|suena bien|do it|go ahead|send it|sounds good)(?:[.!\s]*)$/u.test(text)) return 'approve';
    if (/^(?:el|la|los|las)\s+(?:primero|primera|segundo|segunda|tercero|tercera|ultimo|ultima|de\s+.{1,100})(?:[.!\s]*)$/u.test(text)) return 'select';
    return null;
}
function actionDescription(action) {
    const payload = action.payload ?? {};
    if (Array.isArray(payload.to)) return 'correo para ' + payload.to.join(', ');
    return action.type;
}
export function createCommunicationsService({ emailProvider, calendarProvider = null, pendingActions = createPendingActionManager(), signatureRenderer = emailSignatureRenderer }) {
    if (!emailProvider || typeof emailProvider.getConnectionStatus !== 'function' || typeof emailProvider.getMailboxes !== 'function') throw new TypeError('email_provider_invalid');
    const messageReferences = new Map();
    const calendarService = calendarProvider ? createCalendarService({ provider: calendarProvider }) : null;
    async function safelyCall(operation) { try { return await operation(); } catch { return safeError; } }
    function boundedLimit(limit) { return Number.isInteger(limit) ? Math.max(1, Math.min(limitMax, limit)) : 10; }
    function session(context) { return typeof context?.sessionId === 'string' && context.sessionId ? context.sessionId : null; }
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
    function attachReferences(messages, mailbox, sessionId) {
        return messages.filter(message => typeof message.providerMessageId === 'string' && message.providerMessageId.length > 0).map(message => {
            const id = 'email_' + randomBytes(12).toString('hex');
            const { providerMessageId, ...publicMessage } = message;
            messageReferences.set(id, {
                mailboxAddress: mailbox.address, mailbox, providerMessageId, sessionId,
                snapshot: { subject: publicMessage.subject, from: publicMessage.from, replyTo: publicMessage.replyTo, to: publicMessage.to, cc: publicMessage.cc },
            });
            return { ...publicMessage, id, mailbox: mailbox.address };
        });
    }
    function replacementIds(context) {
        const sessionId = session(context);
        if (!sessionId || directActionCue(context?.userMessage) !== 'modify') return [];
        const pending = pendingActions.list({ sessionId });
        const selected = pendingActions.getSelected({ sessionId });
        if (selected) return [selected.id];
        return pending.length === 1 ? [pending[0].id] : [];
    }
    function modificationTargetIsAmbiguous(context) {
        const sessionId = session(context);
        if (!sessionId || directActionCue(context?.userMessage) !== 'modify') return false;
        return pendingActions.list({ sessionId }).length > 1 && !pendingActions.getSelected({ sessionId });
    }
    async function withMailbox(args, context, operation) {
        const mailbox = await selectMailbox(args?.mailbox);
        if (!mailbox) return { success: false, error: { code: 'mailbox_not_found_or_ambiguous', message: 'No pude identificar un único buzón. Indicá su dirección o un nombre inequívoco.' } };
        return operation(mailbox, session(context) ?? 'direct');
    }
    async function prepareEmail(args, context) {
        return safelyCall(() => withMailbox(args, context, async mailbox => {
            if (modificationTargetIsAmbiguous(context)) return { success: false, error: { code: 'pending_action_ambiguous', message: 'Hay varias vistas previas. Elegí cuál querés modificar antes de preparar otra.' } };
            const to = validAddresses(args?.to, { required: true }), cc = validAddresses(args?.cc ?? []);
            if (!to || !cc || !validSubject(args?.subject) || !validBody(args?.body)) return { success: false, error: { code: 'email_draft_invalid', message: 'Revisá destinatarios, asunto y cuerpo. No envié nada.' } };
            const subject = args.subject.trim(), renderedBody = signatureRenderer.render(args.body);
            const payload = { mailboxAddress: mailbox.address, to, cc, subject,
                bodyHtml: renderedBody.htmlBody, inlineAttachments: renderedBody.inlineAttachments };
            const preview = formatPreview({ from: mailbox.address, to, cc, subject, body: renderedBody.previewBody });
            const action = pendingActions.create({ type: 'email.send', payload, preview, sessionId: session(context),
                replaceIds: replacementIds(context) });
            return pendingResult(action);
        }));
    }
    async function prepareEmailReply(args, context) {
        return safelyCall(async () => {
            if (modificationTargetIsAmbiguous(context)) return { success: false, error: { code: 'pending_action_ambiguous', message: 'Hay varias vistas previas. Elegí cuál querés modificar antes de preparar otra.' } };
            const sessionId = session(context), reference = typeof args?.emailId === 'string' ? messageReferences.get(args.emailId) : null;
            if (!sessionId || !reference || reference.sessionId !== sessionId) return { success: false, error: { code: 'email_reference_invalid', message: 'No puedo responder a esa referencia. Buscá nuevamente el mensaje en esta sesión.' } };
            if (!validBody(args?.body)) return { success: false, error: { code: 'email_draft_invalid', message: 'El cuerpo de la respuesta no es válido. No envié nada.' } };
            const mailbox = await selectMailbox(reference.mailboxAddress);
            if (!mailbox) return { success: false, error: { code: 'mailbox_not_found_or_ambiguous', message: 'El buzón del mensaje ya no está disponible.' } };
            const replyTo = Array.isArray(reference.snapshot.replyTo) && reference.snapshot.replyTo.length ? reference.snapshot.replyTo : [reference.snapshot.from];
            const to = validAddresses(replyTo.map(item => item?.address), { required: true });
            if (!to) return { success: false, error: { code: 'email_reply_recipient_invalid', message: 'No pude validar el destinatario de la respuesta. No envié nada.' } };
            const originalSubject = typeof reference.snapshot.subject === 'string' ? reference.snapshot.subject : '';
            const subject = /^re:/iu.test(originalSubject) ? originalSubject : 'Re: ' + originalSubject;
            const renderedBody = signatureRenderer.render(args.body);
            const payload = { mailboxAddress: mailbox.address, providerMessageId: reference.providerMessageId, to, cc: [], subject,
                bodyHtml: renderedBody.htmlBody, inlineAttachments: renderedBody.inlineAttachments };
            const preview = formatPreview({ from: mailbox.address, to, cc: [], subject, body: renderedBody.previewBody });
            const action = pendingActions.create({ type: 'email.reply', payload, preview, sessionId,
                replaceIds: replacementIds(context) });
            return pendingResult(action);
        });
    }
    async function confirmPendingAction(args, context) {
        return safelyCall(async () => {
            const sessionId = session(context);
            if (!sessionId) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción no pertenece a una sesión activa.' } };
            const claimed = pendingActions.claim({ id: args?.actionId, sessionId, userMessage: context.userMessage });
            if (!claimed.success) return claimed;
            return sendClaimedAction(claimed);
        });
    }
    async function cancelPendingAction(args, context) {
        return safelyCall(async () => {
            const sessionId = session(context);
            if (!sessionId) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción no pertenece a una sesión activa.' } };
            const expectedPhrase = 'cancelar envío ' + args?.actionId;
            if (typeof context.userMessage !== 'string' || context.userMessage !== expectedPhrase) {
                return { success: false, error: { code: 'fresh_cancellation_required', message: 'Para cancelar, respondé exactamente con la frase indicada en la vista previa.' } };
            }
            const result = pendingActions.cancel({ id: args?.actionId, sessionId });
            return result.success ? { success: true, cancelled: true, message: 'Acción pendiente cancelada. No se envió nada.' } : result;
        });
    }
    async function resolvePendingAction(args, context) {
        return safelyCall(async () => {
            const sessionId = session(context);
            if (!sessionId || context?.userMessageSource !== 'direct_user') return { success: false, error: { code: 'direct_user_confirmation_required', message: 'Sólo un mensaje directo del usuario puede confirmar o cancelar una acción pendiente.' } };
            const actions = pendingActions.list({ sessionId });
            if (!actions.length) return { success: false, error: { code: 'pending_action_not_found', message: 'No hay acciones pendientes para esta sesión.' } };
            const cue = directActionCue(context.userMessage);
            const decision = args?.intent;
            if (cue === 'modify' || decision === 'modify') {
                return { success: true, outcome: 'modify', message: 'No ejecuté la acción. Prepará una nueva vista previa con los cambios solicitados; hará falta confirmarla nuevamente.' };
            }
            if (!cue) return { success: false, error: { code: 'confirmation_intent_unclear', message: 'No pude verificar una aprobación directa del usuario. No ejecuté ninguna acción.' } };
            if (decision !== cue) return { success: false, error: { code: 'confirmation_intent_mismatch', message: 'No pude verificar una confirmación directa e inequívoca. La acción sigue pendiente y no se ejecutó.' } };
            const selected = pendingActions.getSelected({ sessionId });
            if (decision === 'approve') {
                let action;
                if (selected) action = actions.find(item => item.id === selected.id);
                else if (actions.length === 1) action = actions[0];
                else return { success: true, outcome: 'ambiguous', actions: actions.map((item, index) => ({ index: index + 1, description: actionDescription(item) })), message: 'Hay varias acciones pendientes. Preguntá cuál quiere confirmar; todavía no ejecutes ninguna.' };
                if (!action) return { success: false, error: { code: 'pending_action_invalid', message: 'La acción elegida venció o ya no está disponible.' } };
                pendingActions.clearSelected({ sessionId });
                const claimed = pendingActions.claimApproved({ id: action.id, sessionId });
                return claimed.success ? sendClaimedAction(claimed) : claimed;
            }
            if (decision === 'select') {
                if (actions.length < 2 || !Number.isInteger(args?.selection) || args.selection < 1 || args.selection > actions.length) {
                    return { success: true, outcome: 'ambiguous', actions: actions.map((item, index) => ({ index: index + 1, description: actionDescription(item) })), message: 'No pude identificar una única acción pendiente. Preguntá cuál quiso decir.' };
                }
                const action = actions[args.selection - 1];
                pendingActions.setSelected({ id: action.id, sessionId });
                return { success: true, outcome: 'selected', message: 'Acción seleccionada: ' + actionDescription(action) + '. Preguntá si confirma esta acción. La selección por sí sola no autoriza ejecutarla.' };
            }
            if (decision === 'cancel_all') {
                const result = pendingActions.cancelAll({ sessionId });
                return { success: true, cancelled: true, count: result.count, message: 'Acciones pendientes canceladas. No se ejecutó ninguna.' };
            }
            if (decision === 'cancel') {
                let action = selected ?? (actions.length === 1 ? actions[0] : null);
                if (!action) return { success: true, outcome: 'ambiguous', actions: actions.map((item, index) => ({ index: index + 1, description: actionDescription(item) })), message: 'Hay varias acciones pendientes. Preguntá cuál quiere cancelar.' };
                const result = pendingActions.cancel({ id: action.id, sessionId });
                pendingActions.clearSelected({ sessionId });
                return result.success ? { success: true, cancelled: true, message: 'Acción pendiente cancelada. No se ejecutó.' } : result;
            }
            if (decision === 'reject') {
                pendingActions.clearSelected({ sessionId });
                return { success: true, outcome: 'rejected', message: 'Entendido. No ejecuté ni cancelé la acción.' };
            }
            return { success: false, error: { code: 'confirmation_intent_unclear', message: 'No pude interpretar la respuesta con seguridad. No se ejecutó ninguna acción.' } };
        });
    }
    async function sendClaimedAction(claimed) {
        let result;
        if (claimed.type === 'email.send' && typeof emailProvider.sendEmail === 'function') result = await emailProvider.sendEmail(claimed.payload);
        else if (claimed.type === 'email.reply' && typeof emailProvider.sendReply === 'function') result = await emailProvider.sendReply(claimed.payload);
        else return { success: false, error: { code: 'pending_action_type_unavailable', message: 'La acción ya no se puede ejecutar. Preparala nuevamente.' } };
        if (!result?.success) return result?.error ? { success: false, error: result.error } : safeError;
        return { success: true, sent: true, message: 'Microsoft Graph confirmó la aceptación del envío.' };
    }
    return {
        getConnectionStatus: () => safelyCall(() => emailProvider.getConnectionStatus()),
        getMailboxes: () => safelyCall(() => emailProvider.getMailboxes()),
        listRecentEmails: (args, context) => safelyCall(() => withMailbox(args ?? {}, context, async (mailbox, sessionId) => {
            if (typeof emailProvider.listRecentEmails !== 'function') return safeError;
            const result = await emailProvider.listRecentEmails({ mailbox, limit: boundedLimit(args?.limit) });
            return result?.success ? { success: true, emails: attachReferences(result.emails ?? [], mailbox, sessionId) } : result;
        })),
        searchEmails: (args, context) => safelyCall(() => withMailbox(args ?? {}, context, async (mailbox, sessionId) => {
            if (typeof emailProvider.searchEmails !== 'function') return safeError;
            const result = await emailProvider.searchEmails({ ...args, mailbox, limit: boundedLimit(args?.limit) });
            return result?.success ? { success: true, emails: attachReferences(result.emails ?? [], mailbox, sessionId) } : result;
        })),
        getEmail: (args, context) => safelyCall(async () => {
            const reference = typeof args?.id === 'string' ? messageReferences.get(args.id) : null;
            if (!reference || reference.sessionId !== (session(context) ?? 'direct') || typeof emailProvider.getEmail !== 'function') return { success: false, error: { code: 'email_reference_invalid', message: 'La referencia del correo no existe, pertenece a otra sesión o venció. Buscalo nuevamente.' } };
            const result = await emailProvider.getEmail(reference);
            if (!result?.success) return result;
            const { providerMessageId: _internal, ...email } = result.email;
            return { success: true, email: { ...email, id: args.id, mailbox: reference.mailboxAddress } };
        }),
        prepareEmail, prepareEmailReply, confirmPendingAction, cancelPendingAction, resolvePendingAction,
        listCalendarEvents: (args, context) => calendarService ? calendarService.listCalendarEvents(args, context) : safeError,
        getCalendarEvent: (args, context) => calendarService ? calendarService.getCalendarEvent(args, context) : safeError,
    };
}
