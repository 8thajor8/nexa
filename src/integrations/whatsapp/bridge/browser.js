import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsappSelectors, whatsappWebUrl } from './selectors.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const whatsappSessionPath = path.join(projectRoot, 'data', 'whatsapp-session');

function safeError(code, message) {
    return { success: false, error: { code, message } };
}

export function createWhatsAppBrowser({ chromium, sessionPath = whatsappSessionPath, headless = false } = {}) {
    let contextPromise;
    let page;

    async function getContext() {
        if (!contextPromise) {
            contextPromise = (async () => {
                try {
                    const engine = chromium ?? (await import('playwright')).chromium;
                    await mkdir(sessionPath, { recursive: true });
                    const context = await engine.launchPersistentContext(sessionPath, {
                        headless,
                        viewport: null,
                        acceptDownloads: false,
                    });
                    context.on('close', () => { contextPromise = undefined; page = undefined; });
                    context.on('page', openedPage => { page = openedPage; });
                    page = context.pages()[0] ?? await context.newPage();
                    page.on('crash', () => { page = undefined; });
                    return context;
                } catch {
                    contextPromise = undefined;
                    throw new Error('whatsapp_browser_failed');
                }
            })();
        }
        return contextPromise;
    }

    async function getPage() {
        const context = await getContext();
        if (!page || page.isClosed()) page = context.pages()[0] ?? await context.newPage();
        if (page.url() !== whatsappWebUrl && !page.url().startsWith(whatsappWebUrl)) {
            await page.goto(whatsappWebUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        }
        return page;
    }

    async function close() {
        const pending = contextPromise;
        contextPromise = undefined;
        page = undefined;
        if (!pending) return;
        try { await (await pending).close(); } catch { /* Browser may already have disconnected. */ }
    }

    async function status() {
        let currentPage;
        try { currentPage = await getPage(); }
        catch { return { success: true, status: 'unavailable', code: 'whatsapp_browser_failed' }; }
        try {
            await currentPage.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
            const url = currentPage.url();
            if (!url.startsWith(whatsappWebUrl)) return { success: true, status: 'loading' };
            const authenticated = await currentPage.locator(whatsappSelectors.authenticatedSelectors[0]).count().catch(() => 0) > 0;
            if (authenticated) return { success: true, status: 'authenticated' };
            const login = await currentPage.getByText(whatsappSelectors.loginText).count().catch(() => 0);
            if (login > 0) return { success: true, status: 'unauthenticated' };
            return { success: true, status: 'loading' };
        } catch {
            return { success: true, status: 'disconnected', code: 'whatsapp_session_unavailable' };
        }
    }

    async function waitForAuthentication({ timeoutMs = 180_000, pollMs = 1000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const state = await status();
            if (state.status === 'authenticated') return state;
            if (!state.success) return state;
            await new Promise(resolve => setTimeout(resolve, pollMs));
        }
        return safeError('whatsapp_loading_timeout', 'No se completó el inicio de sesión dentro del tiempo esperado.');
    }

    return { getPage, status, waitForAuthentication, close };
}
