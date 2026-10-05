import { useAppUiElement } from '../../windows/ui-automation/provider.js';
import { verifyWhatsAppChat, normalizeWhatsAppText, createWhatsAppNavigation } from './navigation.js';
import { whatsappAppName } from './desktop.js';

const composerNames = [
    'mensaje', 'message', 'escribe un mensaje', 'escribir un mensaje', 'type a message',
    'message input', 'cuadro de mensaje',
];
const composerIds = ['composer', 'messageinput', 'messagebox', 'composermessage', 'chatinput'];

function failure(code, message, extra = {}) {
    return { success: false, error: { code, message }, ...extra };
}

function findComposer(elements) {
    const candidates = (elements ?? []).filter(element => {
        if (element.enabled === false || element.controlType !== 'Edit' || !element.patterns?.includes('Value')) return false;
        const name = normalizeWhatsAppText(element.identity?.name ?? element.name);
        const id = normalizeWhatsAppText(element.identity?.automationId ?? element.automationId);
        return composerNames.some(value => name.includes(normalizeWhatsAppText(value))) ||
            composerIds.some(value => id === normalizeWhatsAppText(value) || id.includes(normalizeWhatsAppText(value)));
    });
    const scored = candidates.map(element => {
        const name = normalizeWhatsAppText(element.identity?.name ?? element.name);
        const id = normalizeWhatsAppText(element.identity?.automationId ?? element.automationId);
        const idMatch = composerIds.some(value => id === normalizeWhatsAppText(value) || id.includes(normalizeWhatsAppText(value)));
        const nameMatch = composerNames.some(value => name.includes(normalizeWhatsAppText(value)));
        return { element, score: (idMatch ? 100 : 0) + (nameMatch ? 50 : 0) };
    }).sort((left, right) => right.score - left.score);
    if (scored.length === 0) return { status: 'missing' };
    const best = scored.filter(item => item.score === scored[0].score);
    return best.length === 1 ? { status: 'found', element: best[0].element } : { status: 'ambiguous' };
}

export function createWhatsAppComposer({
    openChat = createWhatsAppNavigation().openChat,
    act = useAppUiElement,
} = {}) {
    async function prepareMessage(contact, message) {
        if (typeof message !== 'string' || message.length === 0 || message.length > 2000) {
            return failure('message_write_failed', 'El mensaje debe tener entre 1 y 2000 caracteres.');
        }
        const opened = await openChat(contact);
        if (opened?.result) return opened.result;

        const { snapshot, windowId } = opened;
        if (!verifyWhatsAppChat(snapshot.elements, opened.contact).success) {
            return failure('contact_verification_failed', 'No pude confirmar el contacto actual; no escribí el borrador.');
        }
        const composer = findComposer(snapshot.elements);
        if (composer.status !== 'found') {
            return failure('composer_not_found', composer.status === 'ambiguous'
                ? 'Encontré varios campos de mensaje posibles; no escribí en ninguno.'
                : 'No encontré el campo editable del mensaje en el chat confirmado.');
        }

        let current;
        try {
            current = await act(whatsappAppName, composer.element.locator, 'get_value', undefined, {
                windowId,
                expected: composer.element.identity ?? {
                    name: composer.element.name ?? '',
                    controlType: composer.element.controlType ?? '',
                    automationId: composer.element.automationId ?? '',
                },
            });
        } catch {
            current = null;
        }
        if (!current?.success || typeof current.value !== 'string') {
            return failure('ui_changed', 'No pude comprobar si el campo ya tenía un borrador; por seguridad no escribí.');
        }
        if (current.value.length > 0) {
            return failure('existing_draft', 'El campo de mensaje ya contiene un borrador. No lo modifiqué.', {
                contact: opened.contact,
                draftExists: true,
                draftLength: current.value.length,
                sent: false,
            });
        }

        let written;
        try {
            written = await act(whatsappAppName, composer.element.locator, 'set_value', message, {
                windowId,
                expected: composer.element.identity ?? {
                    name: composer.element.name ?? '',
                    controlType: composer.element.controlType ?? '',
                    automationId: composer.element.automationId ?? '',
                },
            });
        } catch {
            written = null;
        }
        if (!written?.success) {
            return failure('message_write_failed', 'No pude dejar el mensaje en el campo de texto; no se envió.');
        }
        return {
            success: true,
            completed: true,
            contact: opened.contact,
            draftPrepared: true,
            sent: false,
        };
    }

    return { prepareMessage };
}

const composer = createWhatsAppComposer();
export const prepareWhatsAppMessage = ({ args } = {}) => composer.prepareMessage(args?.contact, args?.message);
