import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiAutomation, defaultUiLimits } from '../src/windows/ui-automation/elements.js';
import { executeTool, localToolRegistry } from '../src/tools/index.js';
import { defaultPermissionPolicy, toolPermissions } from '../src/tools/permissions.js';
import { resolveAppWindow, runWindowsUiAutomation } from '../src/windows/ui-automation/provider.js';

function sampleElement(overrides = {}) {
    return {
        locator: { path: [0], runtimeId: [10, 20] },
        name: 'Enviar',
        controlType: 'Button',
        automationId: 'send',
        enabled: true,
        focusable: true,
        patterns: ['Invoke'],
        ...overrides,
    };
}

function createService({ elements = [sampleElement()], inspectResult = {}, useResult = { success: true }, clock = () => 100 } = {}) {
    const calls = [];
    const service = createUiAutomation({
        now: clock,
        inspect: async (app, options) => {
            calls.push(['inspect', app, options]);
            return { success: true, app, windowId: '0x123', elements, ...inspectResult };
        },
        useElement: async (...args) => {
            calls.push(['use', ...args]);
            return useResult;
        },
    });
    service.clearReferences();
    return { service, calls };
}

test('inspect_ui generates ephemeral refs, exposes accessible metadata, and clamps tree limits', async () => {
    const { service, calls } = createService({ elements: [sampleElement(), sampleElement({ name: 'Cancelar' })] });
    const result = await service.inspectUi({ args: { app: 'WhatsApp', maxDepth: 99, maxElements: 999, maxTextLength: 1 } });
    assert.equal(result.success, true);
    assert.equal(result.elements.length, 2);
    assert.equal(result.elements[0].ref, 'ui_1');
    assert.equal(result.elements[1].ref, 'ui_2');
    assert.equal(result.elements[0].patterns.includes('Invoke'), true);
    assert.equal(result.elements[0].sensitivity, 'may_be_sensitive');
    assert.deepEqual(calls[0][2], { maxDepth: 6, maxElements: 150, maxTextLength: 20 });
    assert.deepEqual(defaultUiLimits, { maxDepth: 4, maxElements: 80, maxTextLength: 160 });
});

test('find_ui_element matches name, controlType and automationId deterministically', async () => {
    const { service } = createService({ elements: [
        sampleElement(),
        sampleElement({ name: 'Buscar', controlType: 'Edit', automationId: 'search' }),
    ] });
    assert.equal((await service.findUiElement({ args: { app: 'WhatsApp', name: 'env', controlType: '', automationId: '' } })).element.name, 'Enviar');
    assert.equal((await service.findUiElement({ args: { app: 'WhatsApp', name: '', controlType: 'Edit', automationId: '' } })).element.name, 'Buscar');
    assert.equal((await service.findUiElement({ args: { app: 'WhatsApp', name: '', controlType: '', automationId: 'search' } })).element.name, 'Buscar');
    assert.equal((await service.findUiElement({ args: { app: 'WhatsApp', name: '', controlType: '', automationId: '' } })).error.code, 'invalid_search');
});

test('find_ui_element preserves ambiguity and returns only limited descriptions', async () => {
    const { service } = createService({ elements: [sampleElement(), sampleElement({ automationId: 'send-2' })] });
    const result = await service.findUiElement({ args: { app: 'WhatsApp', name: 'Enviar', controlType: 'Button', automationId: '' } });
    assert.equal(result.error.code, 'ambiguous_element');
    assert.equal(result.matches.length, 2);
    assert.equal(JSON.stringify(result).includes('runtimeId'), false);
    assert.equal(JSON.stringify(result).includes('path'), false);
});

test('focus, invoke, set value and get value use only Nexa-issued references', async () => {
    const { service, calls } = createService({ useResult: { success: true, value: 'x'.repeat(1200) } });
    const { elements } = await service.inspectUi({ args: { app: 'Notepad', maxDepth: 4, maxElements: 80, maxTextLength: 160 } });
    await service.focusUiElement({ args: { ref: elements[0].ref } });
    await service.invokeUiElement({ args: { ref: elements[0].ref } });
    await service.setUiValue({ args: { ref: elements[0].ref, value: 'Hola Coti' } });
    const read = await service.getUiValue({ args: { ref: elements[0].ref } });
    assert.deepEqual(calls.filter(call => call[0] === 'use').map(call => call[3]), ['focus', 'invoke', 'set_value', 'get_value']);
    assert.equal(calls.find(call => call[0] === 'use' && call[3] === 'set_value')[4], 'Hola Coti');
    assert.equal(read.value.length, 1000);
    assert.equal(read.truncated, true);
    assert.equal((await service.setUiValue({ args: { ref: elements[0].ref, value: 'x'.repeat(2001) } })).error.code, 'invalid_value');
});

test('references expire, invalidate after UI changes, and reject arbitrary ids', async () => {
    let time = 100;
    const { service } = createService({ clock: () => time, useResult: { success: false, error: { code: 'stale_ui_reference', message: 'changed' } } });
    const { elements } = await service.inspectUi({ args: { app: 'Notepad', maxDepth: 4, maxElements: 80, maxTextLength: 160 } });
    assert.equal((await service.invokeUiElement({ args: { ref: 'ui_999' } })).error.code, 'stale_ui_reference');
    assert.equal((await service.invokeUiElement({ args: { ref: elements[0].ref } })).error.code, 'stale_ui_reference');
    const fresh = (await service.inspectUi({ args: { app: 'Notepad', maxDepth: 4, maxElements: 80, maxTextLength: 160 } })).elements[0];
    time += 120_001;
    assert.equal((await service.focusUiElement({ args: { ref: fresh.ref } })).error.code, 'stale_ui_reference');
});

test('pattern failures and disabled controls remain structured and never report success', async () => {
    const unsupported = createService({ useResult: { success: false, error: { code: 'pattern_not_supported', message: 'unsupported' } } });
    const ref = (await unsupported.service.inspectUi({ args: { app: 'Notepad', maxDepth: 4, maxElements: 80, maxTextLength: 160 } })).elements[0].ref;
    assert.equal((await unsupported.service.invokeUiElement({ args: { ref } })).error.code, 'pattern_not_supported');
    const disabled = createService({ useResult: { success: false, error: { code: 'element_disabled', message: 'disabled' } } });
    const disabledRef = (await disabled.service.inspectUi({ args: { app: 'Notepad', maxDepth: 4, maxElements: 80, maxTextLength: 160 } })).elements[0].ref;
    assert.equal((await disabled.service.setUiValue({ args: { ref: disabledRef, value: 'x' } })).error.code, 'element_disabled');
});

test('UI Automation tools are registered with read/action permissions and permission denial blocks execution', async () => {
    const expected = {
        inspect_ui: 'read', find_ui_element: 'read', get_ui_value: 'read',
        focus_ui_element: 'action', invoke_ui_element: 'action', set_ui_value: 'action',
    };
    for (const [name, permission] of Object.entries(expected)) {
        assert.equal(toolPermissions[name], permission);
        assert.equal(localToolRegistry.get(name).permission, permission);
    }
    const result = await executeTool('invoke_ui_element', { ref: 'ui_1' }, {
        permissionPolicy: { ...defaultPermissionPolicy, action: false },
    });
    assert.equal(result.error.code, 'permission_denied');
});

test('app resolution requires a running known application and the native provider is Windows-only', async () => {
    const notRunning = await resolveAppWindow('Notepad', {
        platform: 'win32',
        checkRunning: async () => ({ success: true, running: false }),
    });
    assert.equal(notRunning.error.code, 'app_not_running');
    const unavailable = await runWindowsUiAutomation({ operation: 'inspect', windowHandle: '0x1' }, { platform: 'linux' });
    assert.equal(unavailable.error.code, 'ui_automation_unavailable');
});

test('app resolution reuses known process/window matching and rejects multiple windows', async () => {
    const checkRunning = async () => ({ success: true, running: true });
    const window = { id: '0x123', _handle: 0x123n, title: 'Untitled - Notepad', process: 'notepad.exe', pid: 44 };
    const resolve = async windows => resolveAppWindow('Notepad', {
        platform: 'win32',
        checkRunning,
        readSnapshot: async () => ({ success: true, windows }),
        loadCatalog: async () => ({ version: 1, apps: [] }),
    });
    const found = await resolve([window]);
    assert.equal(found.success, true);
    assert.equal(found.window._handle, 0x123n);
    const ambiguous = await resolve([window, { ...window, id: '0x124', _handle: 0x124n, pid: 45 }]);
    assert.equal(ambiguous.error.code, 'ambiguous_window');
});
