import assert from 'node:assert/strict';
import test from 'node:test';
import { createUiAutomation, defaultUiLimits } from '../src/windows/ui-automation/elements.js';
import { executeTool, localToolRegistry } from '../src/tools/index.js';
import { defaultPermissionPolicy, toolPermissions } from '../src/tools/permissions.js';
import { inspectAppUi, resolveAppWindow, runWindowsUiAutomation } from '../src/windows/ui-automation/provider.js';

function sampleElement(overrides = {}) {
    return {
        locator: { path: [0], runtimeId: [10, 20], ancestry: [] },
        identity: { name: 'Enviar', controlType: 'Button', automationId: 'send' },
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

test('Notepad-style provider locator can be reused immediately to set an editable value', async () => {
    const providerElement = {
        locator: { path: [1, 0], runtimeId: [42, 7], ancestry: [{ name: 'Document', controlType: 'Pane', automationId: 'doc' }] },
        identity: { name: 'Editor', controlType: 'Edit', automationId: 'Text Area' },
        name: 'Editor', controlType: 'Edit', automationId: 'Text Area', enabled: true, patterns: ['Value'],
    };
    const { service, calls } = createService({ elements: [providerElement], useResult: { success: true, action: 'set_value' } });
    const found = await service.findUiElement({ args: { app: 'Notepad', name: 'Editor', controlType: 'Edit' } });
    assert.equal(found.success, true);
    const updated = await service.setUiValue({ args: { ref: found.element.ref, value: 'guitarra Ibanez' } });
    assert.equal(updated.success, true);
    assert.equal(calls.filter(call => call[0] === 'inspect').length, 1);
    const useCall = calls.find(call => call[0] === 'use');
    assert.equal(useCall[2], providerElement.locator);
    assert.equal(useCall[3], 'set_value');
    assert.deepEqual(useCall[5].expected, providerElement.identity);
});

test('Calculator-style find then invoke needs one discovery and one action without focus', async () => {
    const seven = sampleElement({ name: '7', controlType: 'Button', automationId: 'num7', patterns: ['Invoke'] });
    const { service, calls } = createService({ elements: [seven], useResult: { success: true, action: 'invoke' } });
    const found = await service.findUiElement({ args: { app: 'Calculator', name: '7', controlType: 'Button' } });
    const invoked = await service.invokeUiElement({ args: { ref: found.element.ref } });
    assert.equal(invoked.success, true);
    assert.equal(calls.filter(call => call[0] === 'inspect').length, 1);
    assert.deepEqual(calls.filter(call => call[0] === 'use').map(call => call[3]), ['invoke']);
});

test('TextPattern-only edit control reports a precise read-only failure', async () => {
    const { service } = createService({
        elements: [sampleElement({ name: 'Editor', controlType: 'Edit', automationId: 'edit', patterns: ['Text'] })],
        useResult: { success: false, error: { code: 'text_pattern_read_only', message: 'TextPattern is read-only.' } },
    });
    const found = await service.findUiElement({ args: { app: 'Notepad', controlType: 'Edit' } });
    const result = await service.setUiValue({ args: { ref: found.element.ref, value: 'test' } });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'text_pattern_read_only');
});

test('optional diagnostics record reference lifecycle without logging entered text', async () => {
    const diagnostics = [];
    const secretText = 'texto privado 91f3';
    const instrumented = createUiAutomation({
        now: () => 100,
        logger: (event, details) => diagnostics.push({ event, details }),
        inspect: async () => ({ success: true, app: 'Notepad', windowId: '0x123', elements: [sampleElement()] }),
        useElement: async () => ({ success: true }),
    });
    instrumented.clearReferences();
    const ref = (await instrumented.findUiElement({ args: { app: 'Notepad', name: 'Enviar' } })).element.ref;
    await instrumented.setUiValue({ args: { ref, value: secretText } });
    const serialized = JSON.stringify(diagnostics);
    assert.match(serialized, /reference_created/);
    assert.match(serialized, /reference_reused/);
    assert.match(serialized, /tool_result/);
    assert.match(serialized, /valueLength/);
    assert.equal(serialized.includes(secretText), false);
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
        readSnapshot: async () => ({ success: true, windows: [] }),
        loadCatalog: async () => ({ version: 1, apps: [] }),
    });
    assert.equal(notRunning.error.code, 'app_not_running');
    const unavailable = await runWindowsUiAutomation({ operation: 'inspect', windowHandle: '0x1' }, { platform: 'linux' });
    assert.equal(unavailable.error.code, 'ui_automation_unavailable');
});

test('UI app resolution finds a traditional Win32 window by its known executable', async () => {
    const window = { id: '0x234', _handle: 0x234n, title: 'Project - Ableton Live', process: 'ableton live.exe', pid: 88 };
    const result = await resolveAppWindow('Ableton', {
        platform: 'win32',
        readSnapshot: async () => ({ success: true, windows: [window] }),
        loadCatalog: async () => ({ version: 1, apps: [{
            name: 'Ableton Live 12', aliases: ['Ableton'], path: 'C:\\Program Files\\Ableton\\Live 12\\Ableton Live.exe',
        }] }),
        environment: { ProgramFiles: 'C:\\Program Files' },
    });
    assert.equal(result.success, true);
    assert.equal(result.window._handle, 0x234n);
});

test('modern AppX identity resolves its ApplicationFrameHost-owned window by exact known title', async () => {
    const app = {
        name: 'Example Notes', displayName: 'Example Notes', aliases: ['Notes'], packageName: 'Example.Package',
        source: 'appx', appUserModelId: 'Example.Package_123abc!App', launchable: true,
        processNames: ['example-notes.exe'],
    };
    const window = { id: '0x345', _handle: 0x345n, title: 'Example Notes', process: 'ApplicationFrameHost.exe', pid: 99 };
    const result = await resolveAppWindow('Notes', {
        platform: 'win32',
        readSnapshot: async () => ({ success: true, windows: [window] }),
        loadCatalog: async () => ({ version: 1, apps: [app] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.window._handle, 0x345n);
    assert.equal(result.app, 'Example Notes');
});

test('the built-in Calculator alias resolves a modern frame-host window without process-name equality', async () => {
    const window = { id: '0x789', _handle: 0x789n, title: 'Calculator', process: 'ApplicationFrameHost.exe', pid: 121 };
    const result = await resolveAppWindow('Calculator', {
        platform: 'win32',
        readSnapshot: async () => ({ success: true, windows: [window] }),
        loadCatalog: async () => ({ version: 1, apps: [] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.window._handle, 0x789n);
});

test('the resolved modern window handle is passed to the fixed UI Automation provider', async () => {
    let request;
    const window = { id: '0xabc', _handle: 0xabcn, title: 'Example Notes', process: 'ApplicationFrameHost.exe', pid: 99 };
    const result = await inspectAppUi('Example Notes', {
        windowOptions: {
            platform: 'win32',
            readSnapshot: async () => ({ success: true, windows: [window] }),
            loadCatalog: async () => ({ version: 1, apps: [{
                name: 'Example Notes', displayName: 'Example Notes', aliases: [], source: 'appx',
                appUserModelId: 'Example.Package_123abc!App', launchable: true, processNames: ['different.exe'],
            }] }),
        },
        provider: async value => { request = value; return { success: true, elements: [], truncated: false }; },
    });
    assert.equal(result.success, true);
    assert.equal(request.operation, 'inspect');
    assert.equal(request.windowHandle, '0xabc');
});

test('modern app window ambiguity is preserved instead of choosing a matching title', async () => {
    const app = {
        name: 'Example Notes', displayName: 'Example Notes', source: 'appx',
        appUserModelId: 'Example.Package_123abc!App', launchable: true, processNames: ['notes.exe'],
    };
    const windows = [
        { id: '0x1', _handle: 1n, title: 'Example Notes', process: 'ApplicationFrameHost.exe', pid: 10 },
        { id: '0x2', _handle: 2n, title: 'Example Notes', process: 'ApplicationFrameHost.exe', pid: 11 },
    ];
    const result = await resolveAppWindow('Example Notes', {
        platform: 'win32', readSnapshot: async () => ({ success: true, windows }),
        loadCatalog: async () => ({ version: 1, apps: [app] }),
    });
    assert.equal(result.error.code, 'ambiguous_window');
});

test('app resolution reuses known process/window matching and rejects multiple windows', async () => {
    const window = { id: '0x123', _handle: 0x123n, title: 'Untitled - Notepad', process: 'notepad.exe', pid: 44 };
    const resolve = async windows => resolveAppWindow('Notepad', {
        platform: 'win32',
        readSnapshot: async () => ({ success: true, windows }),
        loadCatalog: async () => ({ version: 1, apps: [] }),
    });
    const found = await resolve([window]);
    assert.equal(found.success, true);
    assert.equal(found.window._handle, 0x123n);
    const ambiguous = await resolve([window, { ...window, id: '0x124', _handle: 0x124n, pid: 45 }]);
    assert.equal(ambiguous.error.code, 'ambiguous_window');
});
