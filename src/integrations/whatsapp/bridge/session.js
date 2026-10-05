import { createWhatsAppBrowser } from './browser.js';

let browserInstance;

export function getWhatsAppBrowser() {
    if (!browserInstance) browserInstance = createWhatsAppBrowser();
    return browserInstance;
}

export async function closeWhatsAppBrowser() {
    const current = browserInstance;
    browserInstance = undefined;
    await current?.close();
}

export async function getWhatsAppStatus() {
    return getWhatsAppBrowser().status();
}

