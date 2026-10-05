import { controlWindow } from '../../windows/window-control.js';
import { resolveAppWindow } from '../../windows/ui-automation/provider.js';
import { openApp } from '../../tools/windows.js';

export const whatsappAppName = 'WhatsApp';

const defaultWindowTimeoutMs = 20_000;
const defaultPollIntervalMs = 500;

function failure(code, message, extra = {}) {
    return { success: false, error: { code, message }, ...extra };
}

export function createWhatsAppDesktop({
    resolveWindow = app => resolveAppWindow(app),
    openApplication = () => openApp({ args: { app: whatsappAppName } }),
    focusApplication = () => controlWindow({ args: { target: whatsappAppName }, action: 'focus' }),
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    timeoutMs = defaultWindowTimeoutMs,
    pollIntervalMs = defaultPollIntervalMs,
} = {}) {
    async function waitForWindow() {
        let resolved = await resolveWindow(whatsappAppName);
        if (resolved?.success) return resolved;
        if (resolved?.error?.code !== 'app_not_running') {
            return resolved?.error?.code === 'app_not_found'
                ? failure('whatsapp_not_found', 'WhatsApp no aparece en el catálogo de aplicaciones conocido.')
                : failure('ui_changed', 'No pude resolver una ventana única de WhatsApp.', { cause: resolved?.error?.code });
        }

        const launched = await openApplication();
        if (!launched?.success) {
            const code = ['app_not_found', 'ambiguous_app'].includes(launched?.error?.code)
                ? 'whatsapp_not_found'
                : 'whatsapp_launch_failed';
            return failure(code, launched?.error?.message ?? 'No se pudo abrir WhatsApp.');
        }

        const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await sleep(pollIntervalMs);
            resolved = await resolveWindow(whatsappAppName);
            if (resolved?.success) return resolved;
            if (!['app_not_running', 'window_not_found'].includes(resolved?.error?.code)) {
                return failure('ui_changed', 'WhatsApp cambió o tiene varias ventanas candidatas.', { cause: resolved?.error?.code });
            }
        }
        return failure('whatsapp_window_timeout', 'WhatsApp se inició, pero no apareció una ventana utilizable a tiempo.');
    }

    async function readyWindow() {
        const resolved = await waitForWindow();
        if (!resolved.success) return resolved;
        const focused = await focusApplication();
        if (!focused?.success) {
            return failure('ui_changed', 'Encontré WhatsApp, pero no pude enfocar una ventana única.', { cause: focused?.error?.code });
        }
        return { success: true, app: resolved.app ?? whatsappAppName, windowId: resolved.window.id };
    }

    return { readyWindow };
}

const desktop = createWhatsAppDesktop();
export const prepareWhatsAppWindow = desktop.readyWindow;
