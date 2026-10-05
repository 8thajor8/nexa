import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWhatsAppBridge } from '../src/integrations/whatsapp/bridge/index.js';
import { createWhatsAppBrowser, whatsappSessionPath } from '../src/integrations/whatsapp/bridge/browser.js';
import { whatsappSelectors } from '../src/integrations/whatsapp/bridge/selectors.js';
import { whatsappRegistrations } from '../src/integrations/whatsapp/index.js';
import { checkToolPermission } from '../src/tools/permissions.js';

function mockPage({ contacts = ['Coti'], status = 'authenticated', draft = '', headerMismatch = false, composerMissing = false } = {}) {
    const state = { contacts, query: '', opened: '', draft, calls: [], sent: false, headerMismatch, composerMissing };
    class Locator {
        constructor(kind, name = '') { this.kind = kind; this.name = name; }
        async all() {
            if (this.kind === 'search' || this.kind === 'composer') return [this];
            if (this.kind === 'result') return state.contacts.filter(name => name.toLocaleLowerCase() === state.query.toLocaleLowerCase()).map(name => new Locator('result-item', name));
            if (this.kind === 'header') return state.opened ? [new Locator('header-item', state.opened)] : [];
            return [];
        }
        async isVisible() { return true; }
        async fill(value) {
            if (this.kind === 'search') state.query = value;
            else state.draft = value;
            state.calls.push({ operation: 'fill', kind: this.kind, value });
        }
        async innerText() { return this.kind === 'composer' ? state.draft : this.name; }
        async getAttribute(name) { return name === 'aria-label' ? this.name : null; }
        async click() {
            state.calls.push({ operation: 'click', name: this.name });
            if (this.kind === 'result-item') state.opened = state.headerMismatch ? 'Otra persona' : this.name;
            if (/send|enviar/i.test(this.name)) state.sent = true;
        }
    }
    const page = {
        getByRole(role, options = {}) {
            const name = options.name ?? '';
            if (role === 'textbox' && /search|buscar/i.test(name)) return new Locator('search', name);
            if (role === 'textbox' && /message|mensaje/i.test(name)) return new Locator(state.composerMissing ? 'none' : 'composer', name);
            if (['row', 'listitem', 'button'].includes(role)) return new Locator('result', name);
            if (role === 'heading') return new Locator('header', name);
            return new Locator('none', name);
        },
        locator(selector) { return selector.includes('footer') ? new Locator(state.composerMissing ? 'none' : 'composer') : new Locator('search'); },
        async waitForTimeout() {},
    };
    const browser = { async status() { return { success: true, status }; }, async getPage() { return page; } };
    return { state, page, browser };
}

test('existing authenticated browser session opens matching contact and verifies header', async () => {
    const mock = mockPage();
    const result = await createWhatsAppBridge({ browser: mock.browser }).openChat('Coti');
    assert.deepEqual({ success: result.success, contact: result.contact }, { success: true, contact: 'Coti' });
    assert.equal(mock.state.opened, 'Coti');
});

test('unauthenticated session requires official manual login and does not search chats', async () => {
    const mock = mockPage({ status: 'unauthenticated' });
    const result = await createWhatsAppBridge({ browser: mock.browser }).openChat('Coti');
    assert.equal(result.error.code, 'whatsapp_not_authenticated');
    assert.equal(mock.state.calls.length, 0);
});

test('unknown and ambiguous contacts are never opened', async () => {
    const missing = mockPage();
    assert.equal((await createWhatsAppBridge({ browser: missing.browser }).openChat('Jor')).error.code, 'contact_not_found');
    assert.equal(missing.state.opened, '');
    const ambiguous = mockPage({ contacts: ['Coti', 'Coti'] });
    assert.equal((await createWhatsAppBridge({ browser: ambiguous.browser }).openChat('Coti')).error.code, 'ambiguous_contact');
    assert.equal(ambiguous.state.opened, '');
});

test('header mismatch prevents continuing, and missing composer reports a structured error', async () => {
    const mismatch = mockPage({ headerMismatch: true });
    assert.equal((await createWhatsAppBridge({ browser: mismatch.browser }).openChat('Coti')).error.code, 'contact_verification_failed');
    const missingComposer = mockPage({ composerMissing: true });
    const result = await createWhatsAppBridge({ browser: missingComposer.browser }).prepareMessage('Coti', 'texto');
    assert.equal(result.error.code, 'composer_not_found');
});

test('message is prepared and no send or Enter action is available', async () => {
    const mock = mockPage();
    const result = await createWhatsAppBridge({ browser: mock.browser }).prepareMessage('Coti', 'prueba de Nexa');
    assert.deepEqual(result, { success: true, completed: true, contact: 'Coti', draftPrepared: true, sent: false });
    assert.equal(mock.state.draft, 'prueba de Nexa');
    assert.equal(mock.state.sent, false);
    assert.equal(mock.state.calls.filter(call => call.operation === 'click' && /send|enviar/i.test(call.name)).length, 0);
    assert.equal(mock.state.calls.some(call => call.operation === 'press' || call.operation === 'keyboard'), false);
});

test('existing draft remains untouched', async () => {
    const mock = mockPage({ draft: 'texto previo' });
    const result = await createWhatsAppBridge({ browser: mock.browser }).prepareMessage('Coti', 'texto nuevo');
    assert.equal(result.error.code, 'existing_draft');
    assert.equal(result.sent, false);
    assert.equal(mock.state.draft, 'texto previo');
});

test('bridge errors and status do not expose session secrets', async () => {
    const bridge = createWhatsAppBridge({ browser: { async status() {
        return { success: false, error: { code: 'whatsapp_session_unavailable', message: 'La pestaña se desconectó.' } };
    } } });
    const result = await bridge.getStatus();
    assert.equal(result.error.code, 'whatsapp_session_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /cookie|token|storage state/iu);
});

test('browser startup failure reports unavailable without leaking launch details', async () => {
    const sessionPath = await mkdtemp(path.join(os.tmpdir(), 'nexa-whatsapp-failed-'));
    const browser = createWhatsAppBrowser({ chromium: { async launchPersistentContext() {
        throw new Error('cookie=/sensitive/browser/profile');
    } }, sessionPath });
    try {
        const result = await browser.status();
        assert.deepEqual(result, { success: true, status: 'unavailable', code: 'whatsapp_browser_failed' });
        assert.doesNotMatch(JSON.stringify(result), /cookie|sensitive/iu);
    } finally {
        await rm(sessionPath, { recursive: true, force: true });
    }
});

test('new local browser profile reports that manual authentication is required', async () => {
    const sessionPath = await mkdtemp(path.join(os.tmpdir(), 'nexa-whatsapp-new-'));
    const page = {
        on() {}, isClosed: () => false, url: () => 'https://web.whatsapp.com/',
        async waitForLoadState() {},
        locator() { return { async count() { return 0; } }; },
        getByText() { return { async count() { return 1; } }; },
    };
    const context = { pages: () => [page], on() {}, async close() {} };
    const browser = createWhatsAppBrowser({ chromium: { async launchPersistentContext() { return context; } }, sessionPath });
    try {
        assert.deepEqual(await browser.status(), { success: true, status: 'unauthenticated' });
    } finally {
        await browser.close();
        await rm(sessionPath, { recursive: true, force: true });
    }
});

test('persistent visible browser is reused and navigates only to WhatsApp Web', async () => {
    const calls = { launched: 0, navigated: [] };
    let currentUrl = 'about:blank';
    const page = { on() {}, isClosed: () => false, url: () => currentUrl, async goto(url) { calls.navigated.push(url); currentUrl = url; } };
    const context = { pages: () => [page], on() {}, async close() {} };
    const sessionPath = await mkdtemp(path.join(os.tmpdir(), 'nexa-whatsapp-test-'));
    const browser = createWhatsAppBrowser({ chromium: { async launchPersistentContext(dir, options) {
        calls.launched++; calls.dir = dir; calls.options = options; return context;
    } }, sessionPath });
    try {
        await browser.getPage(); await browser.getPage();
        assert.equal(calls.launched, 1);
        assert.equal(calls.dir, sessionPath);
        assert.deepEqual(calls.navigated, ['https://web.whatsapp.com/']);
        assert.equal(calls.options.headless, false);
    } finally {
        await browser.close();
        await rm(sessionPath, { recursive: true, force: true });
    }
});

test('local session path and public tools remain constrained', () => {
    assert.match(whatsappSessionPath, /data[\\/]whatsapp-session$/u);
    const names = whatsappRegistrations.map(item => item.definition.name);
    assert.deepEqual(names, ['whatsapp_open_chat', 'whatsapp_prepare_message', 'whatsapp_get_status']);
    assert.equal(names.some(name => /send/i.test(name)), false);
    assert.equal(checkToolPermission({ permission: 'read' }).allowed, true);
    assert.equal(whatsappSelectors.composerFallback.some(selector => /send|enviar/i.test(selector)), false);
});
