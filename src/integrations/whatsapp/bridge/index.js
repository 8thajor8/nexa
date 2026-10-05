import { getWhatsAppBrowser } from './session.js';
import { whatsappSelectors } from './selectors.js';

function fail(code, message, extra = {}) {
    return { success: false, error: { code, message }, ...extra };
}

export function normalizeWhatsAppText(value) {
    return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
        .toLocaleLowerCase('es').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

async function uniqueVisible(locator) {
    const matches = await locator.all();
    const visible = [];
    for (const match of matches) if (await match.isVisible().catch(() => false)) visible.push(match);
    return visible.length === 1 ? { item: visible[0] } : { ambiguous: visible.length > 1 };
}

async function resolveSearch(page) {
    for (const label of whatsappSelectors.searchLabels) {
        const found = await uniqueVisible(page.getByRole('textbox', { name: label, exact: true }));
        if (found.item || found.ambiguous) return found;
    }
    const fallback = await uniqueVisible(page.locator(whatsappSelectors.searchFallback[0]));
    return fallback;
}

async function findNamedResult(page, contact) {
    const wanted = normalizeWhatsAppText(contact);
    for (const role of whatsappSelectors.resultRoles) {
        const candidates = [];
        const items = await page.getByRole(role).all();
        for (const item of items) {
            if (!await item.isVisible().catch(() => false)) continue;
            const accessibleName = await item.getAttribute('aria-label').catch(() => '');
            const text = accessibleName || await item.innerText().catch(() => '');
            const lines = text.split(/\r?\n/u).map(normalizeWhatsAppText).filter(Boolean);
            if (lines[0] === wanted) candidates.push(item);
        }
        if (candidates.length) return candidates.length === 1 ? { item: candidates[0] } : { ambiguous: true };
    }
    return {};
}

async function verifyHeader(page, contact) {
    const wanted = normalizeWhatsAppText(contact);
    const headers = [];
    for (const role of whatsappSelectors.headerRoles) {
        for (const item of await page.getByRole(role).all()) {
            if (!await item.isVisible().catch(() => false)) continue;
            if (normalizeWhatsAppText(await item.innerText().catch(() => '')) === wanted) headers.push(item);
        }
    }
    if (headers.length === 1) return true;
    if (headers.length > 1) return false;
    for (const selector of whatsappSelectors.headerFallback) {
        const matches = [];
        for (const item of await page.locator(selector).all()) {
            if (!await item.isVisible().catch(() => false)) continue;
            const title = await item.getAttribute('title').catch(() => '') || await item.getAttribute('aria-label').catch(() => '');
            if (normalizeWhatsAppText(title) === wanted) matches.push(item);
        }
        if (matches.length) return matches.length === 1;
    }
    return false;
}

export function createWhatsAppBridge({ browser = getWhatsAppBrowser() } = {}) {
    async function getStatus() { return browser.status(); }

    async function authenticatedPage() {
        const state = await browser.status();
        if (!state.success) return { error: state };
        if (state.status === 'unauthenticated') return { error: fail('whatsapp_not_authenticated', 'WhatsApp Web necesita que completes el inicio de sesión manual.') };
        if (state.status !== 'authenticated') return { error: fail('whatsapp_session_unavailable', 'WhatsApp Web todavía no está listo.') };
        try { return { page: await browser.getPage() }; }
        catch { return { error: fail('whatsapp_browser_failed', 'El navegador de WhatsApp se cerró o no está disponible.') }; }
    }

    async function openChat(contact) {
        if (typeof contact !== 'string' || !contact.trim() || contact.length > 200) return fail('contact_not_found', 'Indicá un nombre de contacto válido.');
        const session = await authenticatedPage();
        if (session.error) return session.error;
        const { page } = session;
        try {
            const search = await resolveSearch(page);
            if (search.ambiguous) return fail('whatsapp_ui_changed', 'Encontré varias búsquedas posibles; no elegí una.');
            if (!search.item) return fail('whatsapp_ui_changed', 'No encontré la búsqueda accesible de chats.');
            await search.item.fill(contact);
            await page.waitForTimeout(400);
            const result = await findNamedResult(page, contact);
            if (result.ambiguous) return fail('ambiguous_contact', 'Hay varios resultados para ese contacto; no abrí ninguno.');
            if (!result.item) return fail('contact_not_found', `No encontré el contacto «${contact}».`);
            await result.item.click();
            await page.waitForTimeout(250);
            if (!await verifyHeader(page, contact)) return fail('contact_verification_failed', 'No pude confirmar que el chat abierto sea el contacto solicitado.');
            return { success: true, contact, _page: page };
        } catch {
            return fail('whatsapp_ui_changed', 'La interfaz de WhatsApp Web cambió o dejó de responder.');
        }
    }

    async function prepareMessage(contact, message) {
        if (typeof message !== 'string' || message.length < 1 || message.length > 2000) return fail('message_write_failed', 'El mensaje debe tener entre 1 y 2000 caracteres.');
        const opened = await openChat(contact);
        if (!opened.success) return opened;
        const { _page: page } = opened;
        try {
            if (!await verifyHeader(page, opened.contact)) return fail('contact_verification_failed', 'No confirmé el chat; no escribí el borrador.');
            let composer;
            for (const label of whatsappSelectors.composerLabels) {
                const found = await uniqueVisible(page.getByRole('textbox', { name: label, exact: true }));
                if (found.ambiguous) return fail('composer_not_found', 'Encontré varios campos de mensaje; no escribí en ninguno.');
                if (found.item) { composer = found.item; break; }
            }
            if (!composer) {
                const found = await uniqueVisible(page.locator(whatsappSelectors.composerFallback[0]));
                if (found.ambiguous) return fail('composer_not_found', 'Encontré varios campos de mensaje; no escribí en ninguno.');
                composer = found.item;
            }
            if (!composer) return fail('composer_not_found', 'No encontré el campo de mensaje del chat confirmado.');
            const existing = await composer.innerText().catch(() => '');
            if (existing.length > 0) return fail('existing_draft', 'El campo ya contiene un borrador. No lo modifiqué.', { contact: opened.contact, draftExists: true, draftLength: existing.length, sent: false });
            // Locator.fill changes only the composer value; it does not press Enter or activate Send.
            await composer.fill(message);
            return { success: true, completed: true, contact: opened.contact, draftPrepared: true, sent: false };
        } catch {
            return fail('message_write_failed', 'No pude dejar el texto en el campo; no se envió.');
        }
    }

    return { openChat, prepareMessage, getStatus };
}

const bridge = createWhatsAppBridge();
export const openWhatsAppChat = bridge.openChat;
export const prepareWhatsAppMessage = bridge.prepareMessage;
export const getWhatsAppBridgeStatus = bridge.getStatus;
