import assert from 'node:assert/strict';
import test from 'node:test';
import { createWhatsAppDesktop } from '../src/integrations/whatsapp/desktop.js';
import { createWhatsAppNavigation } from '../src/integrations/whatsapp/navigation.js';
import { createWhatsAppComposer } from '../src/integrations/whatsapp/composer.js';
import { executeTool, localToolRegistry } from '../src/tools/index.js';
import { toolPermissions } from '../src/tools/permissions.js';

function uiElement(id, name, controlType, patterns, overrides = {}) {
    return {
        locator: { id, path: [0], runtimeId: [1], ancestry: [] },
        identity: { name, controlType, automationId: id },
        name, controlType, automationId: id,
        enabled: true, patterns,
        ...overrides,
    };
}

const searchField = () => uiElement('SearchBox', 'Search', 'Edit', ['Value']);
const contactRow = (name = 'Coti', id = 'contact') => uiElement(id, name, 'ListItem', ['Invoke']);
const chatView = (header = 'Coti', includeComposer = true) => [
    uiElement('chat-title', header, 'Text', []),
    ...(includeComposer ? [uiElement('MessageInput', 'Message', 'Edit', ['Value'])] : []),
];

function makeFlow({ inspections, draft = '', resolveResults } = {}) {
    const calls = [];
    let currentDraft = draft;
    const pendingInspections = [...inspections];
    const lastInspection = pendingInspections.at(-1) ?? [];
    const navigation = createWhatsAppNavigation({
        readyWindow: async () => ({ success: true, app: 'WhatsApp', windowId: '0x123' }),
        inspect: async app => {
            calls.push(['inspect', app]);
            return { success: true, app, windowId: '0x123', elements: pendingInspections.shift() ?? lastInspection };
        },
        act: async (app, locator, operation, value) => {
            calls.push(['act', app, locator.id, operation, value]);
            if (operation === 'get_value') return { success: true, value: currentDraft };
            if (operation === 'set_value' && ['MessageInput', 'MensajeInput'].includes(locator.id)) currentDraft = value;
            return { success: true, action: operation };
        },
        sleep: async () => {},
    });
    const composer = createWhatsAppComposer({
        openChat: navigation.openChat,
        act: async (app, locator, operation, value) => {
            calls.push(['act', app, locator.id, operation, value]);
            if (operation === 'get_value') return { success: true, value: currentDraft };
            if (operation === 'set_value' && ['MessageInput', 'MensajeInput'].includes(locator.id)) currentDraft = value;
            return { success: true, action: operation };
        },
    });
    return { navigation, composer, calls, getDraft: () => currentDraft };
}

test('WhatsApp already open: search, unique contact and verified chat complete without Send', async () => {
    const flow = makeFlow({ inspections: [
        [searchField()],
        [searchField(), contactRow()],
        chatView(),
    ] });
    const result = await flow.navigation.openChat('Coti');
    assert.equal(result.result, null);
    assert.equal(result.contact, 'Coti');
    assert.equal(flow.calls.filter(call => call[0] === 'inspect').length, 3);
    assert.deepEqual(flow.calls.filter(call => call[0] === 'act').map(call => [call[2], call[3]]), [
        ['SearchBox', 'set_value'], ['contact', 'invoke'],
    ]);
    assert.equal(flow.calls.some(call => call[2] === 'send' && call[3] === 'invoke'), false);
});

test('closed WhatsApp launches, waits for its window and focuses the resolved app', async () => {
    const results = [
        { success: false, error: { code: 'app_not_running' } },
        { success: true, app: 'WhatsApp', window: { id: '0x555', _handle: 0x555n } },
    ];
    const calls = [];
    const desktop = createWhatsAppDesktop({
        resolveWindow: async app => { calls.push(['resolve', app]); return results.shift(); },
        openApplication: async () => { calls.push(['open']); return { success: true }; },
        focusApplication: async () => { calls.push(['focus']); return { success: true }; },
        sleep: async milliseconds => calls.push(['sleep', milliseconds]),
        now: () => 0,
    });
    const result = await desktop.readyWindow();
    assert.deepEqual(result, { success: true, app: 'WhatsApp', windowId: '0x555' });
    assert.deepEqual(calls.map(call => call[0]), ['resolve', 'open', 'sleep', 'resolve', 'focus']);
});

test('Spanish Buscar and Mensaje controls work when search must first be opened', async () => {
    const flow = makeFlow({ inspections: [
        [uiElement('search-button', 'Buscar', 'Button', ['Invoke'])],
        [uiElement('Buscar', 'Buscar', 'Edit', ['Value'])],
        [uiElement('Buscar', 'Buscar', 'Edit', ['Value']), contactRow()],
        [uiElement('chat-title', 'Coti', 'Text', []), uiElement('MensajeInput', 'Mensaje', 'Edit', ['Value'])],
    ] });
    const result = await flow.composer.prepareMessage('Coti', 'Hola');
    assert.equal(result.success, true);
    assert.equal(flow.getDraft(), 'Hola');
    assert.deepEqual(flow.calls.filter(call => call[0] === 'act').map(call => [call[2], call[3]]), [
        ['search-button', 'invoke'], ['Buscar', 'set_value'], ['contact', 'invoke'],
        ['MensajeInput', 'get_value'], ['MensajeInput', 'set_value'],
    ]);
});

test('unknown WhatsApp identity and failed launch return structured errors', async () => {
    const unknown = createWhatsAppDesktop({
        resolveWindow: async () => ({ success: false, error: { code: 'app_not_found' } }),
    });
    assert.equal((await unknown.readyWindow()).error.code, 'whatsapp_not_found');
    const launchFailed = createWhatsAppDesktop({
        resolveWindow: async () => ({ success: false, error: { code: 'app_not_running' } }),
        openApplication: async () => ({ success: false, error: { code: 'app_launch_failed' } }),
    });
    assert.equal((await launchFailed.readyWindow()).error.code, 'whatsapp_launch_failed');
    const timedOut = createWhatsAppDesktop({
        resolveWindow: async () => ({ success: false, error: { code: 'app_not_running' } }),
        openApplication: async () => ({ success: true }),
        sleep: async () => {}, timeoutMs: 1, pollIntervalMs: 1,
    });
    assert.equal((await timedOut.readyWindow()).error.code, 'whatsapp_window_timeout');
});

test('contact not found and duplicate reasonable results do not open any chat', async () => {
    const missing = makeFlow({ inspections: [[searchField()], [searchField()], chatView()] });
    assert.equal((await missing.navigation.openChat('Coti')).result.error.code, 'contact_not_found');
    assert.equal(missing.calls.some(call => call[0] === 'act' && call[3] === 'invoke'), false);

    const duplicate = makeFlow({ inspections: [
        [searchField()], [contactRow('Coti', 'contact-one'), contactRow('Coti', 'contact-two')],
    ] });
    assert.equal((await duplicate.navigation.openChat('Coti')).result.error.code, 'ambiguous_contact');
    assert.equal(duplicate.calls.some(call => call[0] === 'act' && call[3] === 'invoke'), false);
});

test('chat is verified by its accessible header before the navigation succeeds', async () => {
    const flow = makeFlow({ inspections: [[searchField()], [contactRow()], chatView('Coti')] });
    assert.equal((await flow.navigation.openChat('Coti')).result, null);

    const wrong = makeFlow({ inspections: [[searchField()], [contactRow()], chatView('Otra persona')] });
    assert.equal((await wrong.navigation.openChat('Coti')).result.error.code, 'contact_verification_failed');
});

test('prepare message writes only into an empty composer and reports an unsent draft', async () => {
    const flow = makeFlow({ inspections: [[searchField()], [contactRow()], chatView()] });
    const result = await flow.composer.prepareMessage('Coti', 'Hola, llego en 20 minutos');
    assert.deepEqual(result, {
        success: true, completed: true, contact: 'Coti', draftPrepared: true, sent: false,
    });
    assert.equal(flow.getDraft(), 'Hola, llego en 20 minutos');
    assert.deepEqual(flow.calls.filter(call => call[0] === 'act').map(call => [call[2], call[3]]), [
        ['SearchBox', 'set_value'], ['contact', 'invoke'], ['MessageInput', 'get_value'], ['MessageInput', 'set_value'],
    ]);
    assert.equal(flow.calls.some(call => call[2] === 'Send' || call[2] === 'send'), false);
});

test('existing composer draft is preserved and the requested message is not written', async () => {
    const flow = makeFlow({ inspections: [[searchField()], [contactRow()], chatView()], draft: 'borrador previo' });
    const result = await flow.composer.prepareMessage('Coti', 'nuevo mensaje');
    assert.equal(result.error.code, 'existing_draft');
    assert.equal(result.draftLength, 'borrador previo'.length);
    assert.equal(flow.getDraft(), 'borrador previo');
    assert.equal(flow.calls.some(call => call[0] === 'act' && call[3] === 'set_value' && call[2] === 'MessageInput'), false);
});

test('missing composer, unexpected search UI and failed chat verification stop safely', async () => {
    const noComposer = makeFlow({ inspections: [[searchField()], [contactRow()], chatView('Coti', false)] });
    assert.equal((await noComposer.composer.prepareMessage('Coti', 'hola')).error.code, 'composer_not_found');

    const unexpected = makeFlow({ inspections: [[uiElement('random', 'Inbox', 'Pane', [])]] });
    assert.equal((await unexpected.navigation.openChat('Coti')).result.error.code, 'search_control_not_found');

    const wrongHeader = makeFlow({ inspections: [[searchField()], [contactRow()], chatView('Otro chat')] });
    assert.equal((await wrongHeader.composer.prepareMessage('Coti', 'hola')).error.code, 'contact_verification_failed');
    assert.equal(wrongHeader.calls.some(call => call[0] === 'act' && call[3] === 'set_value' && call[2] === 'MessageInput'), false);
});

test('message write failure is reported and never treated as a prepared draft', async () => {
    const opened = {
        result: null, contact: 'Coti', windowId: '0x123',
        snapshot: { elements: chatView() },
    };
    const composer = createWhatsAppComposer({
        openChat: async () => opened,
        act: async (_app, _locator, operation) => operation === 'get_value'
            ? { success: true, value: '' }
            : { success: false, error: { code: 'action_failed' } },
    });
    const result = await composer.prepareMessage('Coti', 'Hola');
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'message_write_failed');
});

test('WhatsApp tools are action protected and prepare_message never invokes Send', async () => {
    assert.equal(toolPermissions.whatsapp_open_chat, 'action');
    assert.equal(toolPermissions.whatsapp_prepare_message, 'action');
    assert.equal(localToolRegistry.get('whatsapp_open_chat').permission, 'action');
    assert.equal(localToolRegistry.get('whatsapp_prepare_message').permission, 'action');
    assert.equal(localToolRegistry.has('whatsapp_send_message'), false);
    const denied = await executeTool('whatsapp_prepare_message', { contact: 'Coti', message: 'hola' }, {
        permissionPolicy: { read: true, external_read: true, write: true, action: false, destructive: false },
    });
    assert.equal(denied.error.code, 'permission_denied');

    const flow = makeFlow({ inspections: [[searchField()], [contactRow()], [
        ...chatView(), uiElement('send', 'Send', 'Button', ['Invoke']),
    ]] });
    const prepared = await flow.composer.prepareMessage('Coti', 'no enviar');
    assert.equal(prepared.success, true);
    assert.equal(prepared.sent, false);
    assert.equal(flow.calls.some(call => call[0] === 'act' && call[2] === 'send' && call[3] === 'invoke'), false);
});
