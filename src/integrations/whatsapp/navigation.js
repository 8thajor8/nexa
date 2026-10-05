import { prepareWhatsAppWindow, whatsappAppName } from './desktop.js';
import { inspectAppUi, useAppUiElement } from '../../windows/ui-automation/provider.js';

const searchNames = [
    'buscar', 'search', 'buscar o iniciar un chat', 'search or start a new chat',
    'buscar contactos', 'search contacts', 'nuevo chat',
];
const searchIds = ['search', 'searchbox', 'searchtextbox', 'searchinput', 'contactsearch'];
const searchButtonNames = ['buscar', 'search', 'buscar contactos', 'search contacts'];
const contactControlTypes = new Set(['ListItem', 'DataItem', 'TreeItem', 'Button', 'Custom']);
const headerControlTypes = new Set(['Text', 'Heading', 'Button', 'Custom']);
const excludedHeaderContext = ['search', 'buscar', 'chat list', 'lista de chats', 'resultados', 'recent chats', 'chats recientes'];
const sendNames = ['enviar', 'send'];

export function normalizeWhatsAppText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLocaleLowerCase('es')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/gu, ' ');
}

function elementName(element) {
    return element?.identity?.name ?? element?.name ?? '';
}

function elementType(element) {
    return element?.identity?.controlType ?? element?.controlType ?? '';
}

function elementId(element) {
    return element?.identity?.automationId ?? element?.automationId ?? '';
}

function hasPattern(element, pattern) {
    return Array.isArray(element?.patterns) && element.patterns.includes(pattern);
}

function nameContains(name, variants) {
    const normalized = normalizeWhatsAppText(name);
    return variants.some(variant => normalized.includes(normalizeWhatsAppText(variant)));
}

function isSendControl(element) {
    const name = normalizeWhatsAppText(elementName(element));
    const id = normalizeWhatsAppText(elementId(element));
    const paddedName = ` ${name} `;
    return sendNames.some(value => paddedName.includes(` ${value} `) || id.includes(value));
}

function bestUnique(elements, score) {
    const ranked = elements
        .map(element => ({ element, score: score(element) }))
        .filter(item => item.score > 0)
        .sort((left, right) => right.score - left.score);
    if (ranked.length === 0) return { status: 'missing' };
    const top = ranked.filter(item => item.score === ranked[0].score);
    return top.length === 1
        ? { status: 'found', element: top[0].element }
        : { status: 'ambiguous' };
}

function findSearchField(elements) {
    return bestUnique(elements, element => {
        if (element.enabled === false || !hasPattern(element, 'Value')) return 0;
        const id = normalizeWhatsAppText(elementId(element));
        const name = elementName(element);
        const knownId = searchIds.some(value => id === normalizeWhatsAppText(value) || id.includes(normalizeWhatsAppText(value)));
        const knownName = nameContains(name, searchNames);
        if (!knownId && !knownName) return 0;
        return (knownId ? 100 : 0) + (knownName ? 50 : 0) + (elementType(element) === 'Edit' ? 10 : 0);
    });
}

function findSearchButton(elements) {
    return bestUnique(elements, element => {
        if (element.enabled === false || elementType(element) !== 'Button' || !hasPattern(element, 'Invoke')) return 0;
        return nameContains(elementName(element), searchButtonNames) ? 1 : 0;
    });
}

function contactNameMatches(name, contact) {
    const normalizedName = normalizeWhatsAppText(name);
    const normalizedContact = normalizeWhatsAppText(contact);
    if (!normalizedName || !normalizedContact) return false;
    return normalizedName === normalizedContact ||
        normalizedName.startsWith(`${normalizedContact} `) ||
        normalizedName.includes(` ${normalizedContact} `);
}

function findContactResult(elements, contact) {
    const candidates = elements.filter(element =>
        element.enabled !== false &&
        contactControlTypes.has(elementType(element)) &&
        hasPattern(element, 'Invoke') &&
        !isSendControl(element) &&
        contactNameMatches(elementName(element), contact)
    );
    const exact = candidates.filter(element => normalizeWhatsAppText(elementName(element)) === normalizeWhatsAppText(contact));
    const matches = exact.length > 0 ? exact : candidates;
    if (matches.length === 0) return { status: 'missing' };
    const ranked = matches.map(element => {
        const ancestry = Array.isArray(element?.locator?.ancestry) ? element.locator.ancestry : [];
        const context = normalizeWhatsAppText(ancestry.map(parent => parent.name).join(' '));
        const inSearchResults = ['search results', 'resultados de busqueda', 'resultados', 'contacts', 'contactos']
            .some(value => context.includes(normalizeWhatsAppText(value)));
        const inChatHistory = ['chat list', 'lista de chats', 'recent chats', 'chats recientes']
            .some(value => context.includes(normalizeWhatsAppText(value)));
        return { element, score: (inSearchResults ? 10 : 0) - (inChatHistory ? 10 : 0) };
    }).sort((left, right) => right.score - left.score);
    const best = ranked.filter(item => item.score === ranked[0].score);
    return best.length === 1 ? { status: 'found', element: best[0].element } : { status: 'ambiguous' };
}

function isVerifiedHeader(element, contact) {
    if (!headerControlTypes.has(elementType(element))) return false;
    if (normalizeWhatsAppText(elementName(element)) !== normalizeWhatsAppText(contact)) return false;
    const ancestry = Array.isArray(element?.locator?.ancestry) ? element.locator.ancestry : [];
    return !ancestry.some(parent => excludedHeaderContext.some(context =>
        normalizeWhatsAppText(parent.name).includes(normalizeWhatsAppText(context))
    ));
}

export function verifyWhatsAppChat(elements, contact) {
    const headers = (elements ?? []).filter(element => isVerifiedHeader(element, contact));
    return headers.length === 1
        ? { success: true }
        : { success: false, code: 'contact_verification_failed' };
}

function failure(code, message, extra = {}) {
    return { success: false, error: { code, message }, ...extra };
}

export function createWhatsAppNavigation({
    readyWindow = prepareWhatsAppWindow,
    inspect = inspectAppUi,
    act = useAppUiElement,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    maxVerificationAttempts = 4,
    maxSearchAttempts = 4,
} = {}) {
    async function inspectStableWindow(windowId) {
        const snapshot = await inspect(whatsappAppName);
        if (!snapshot?.success) return { error: failure('ui_changed', 'La interfaz de WhatsApp cambió o dejó de estar disponible.') };
        if (snapshot.windowId !== windowId) return { error: failure('ui_changed', 'Cambió la ventana de WhatsApp durante la operación.') };
        return { snapshot };
    }

    async function perform(element, operation, value, windowId) {
        try {
            const result = await act(whatsappAppName, element.locator, operation, value, {
                windowId,
                expected: element.identity ?? {
                    name: element.name ?? '', controlType: element.controlType ?? '', automationId: element.automationId ?? '',
                },
            });
            return result?.success ? result : null;
        } catch {
            return null;
        }
    }

    async function openChat(contact) {
        if (typeof contact !== 'string' || !contact.trim() || contact.length > 200) {
            return { result: failure('contact_not_found', 'Indicá un nombre de contacto válido.') };
        }
        const requestedContact = contact.trim();
        const ready = await readyWindow();
        if (!ready?.success) return { result: ready ?? failure('whatsapp_not_found', 'No se pudo resolver WhatsApp.') };

        let inspected = await inspectStableWindow(ready.windowId);
        if (inspected.error) return { result: inspected.error };
        let snapshot = inspected.snapshot;
        let search = findSearchField(snapshot.elements);
        if (search.status === 'ambiguous') return { result: failure('search_control_not_found', 'Encontré varios campos de búsqueda posibles y no elegí uno.') };

        if (search.status === 'missing') {
            const searchButton = findSearchButton(snapshot.elements);
            if (searchButton.status !== 'found') return { result: failure('search_control_not_found', 'No encontré una búsqueda accesible de chats en WhatsApp.') };
            if (!(await perform(searchButton.element, 'invoke', undefined, ready.windowId))) {
                return { result: failure('search_control_not_found', 'No pude abrir la búsqueda de chats.') };
            }
            await sleep(250);
            inspected = await inspectStableWindow(ready.windowId);
            if (inspected.error) return { result: inspected.error };
            snapshot = inspected.snapshot;
            search = findSearchField(snapshot.elements);
        }
        if (search.status !== 'found') return { result: failure('search_control_not_found', 'No encontré un único campo editable para buscar chats.') };
        if (!(await perform(search.element, 'set_value', requestedContact, ready.windowId))) {
            return { result: failure('search_control_not_found', 'No pude escribir el nombre en la búsqueda de WhatsApp.') };
        }

        let contactResult = { status: 'missing' };
        for (let attempt = 0; attempt < maxSearchAttempts; attempt++) {
            await sleep(attempt === 0 ? 350 : 250);
            inspected = await inspectStableWindow(ready.windowId);
            if (inspected.error) return { result: inspected.error };
            snapshot = inspected.snapshot;
            contactResult = findContactResult(snapshot.elements, requestedContact);
            if (contactResult.status !== 'missing') break;
        }
        if (contactResult.status === 'ambiguous') return { result: failure('ambiguous_contact', 'Hay varios resultados razonables para ese contacto; no abrí ninguno.') };
        if (contactResult.status === 'missing') return { result: failure('contact_not_found', `No encontré un resultado accesible para «${requestedContact}».`) };

        if (!(await perform(contactResult.element, 'invoke', undefined, ready.windowId))) {
            return { result: failure('chat_open_failed', 'Encontré el contacto, pero no pude abrir el chat.') };
        }

        let chatSnapshot = null;
        for (let attempt = 0; attempt < maxVerificationAttempts; attempt++) {
            await sleep(attempt === 0 ? 350 : 250);
            inspected = await inspectStableWindow(ready.windowId);
            if (inspected.error) return { result: inspected.error };
            chatSnapshot = inspected.snapshot;
            if (verifyWhatsAppChat(chatSnapshot.elements, requestedContact).success) {
                return { result: null, contact: requestedContact, windowId: ready.windowId, snapshot: chatSnapshot };
            }
        }
        return { result: failure('contact_verification_failed', 'Abrí el resultado, pero no pude confirmar que el encabezado del chat corresponda al contacto solicitado.') };
    }

    return { openChat };
}

const navigation = createWhatsAppNavigation();
export const openWhatsAppChat = navigation.openChat;
