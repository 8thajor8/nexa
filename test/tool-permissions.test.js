import assert from 'node:assert/strict';
import test from 'node:test';

import {
    checkToolPermission,
    defaultPermissionPolicy,
    toolPermissions,
} from '../src/tools/permissions.js';
import { getToolsForModel, executeTool, localToolRegistry } from '../src/tools/index.js';

test('existing local tools declare their intended permissions', () => {
    assert.deepEqual(toolPermissions, {
        get_current_time: 'read',
        recall: 'read',
        remember: 'write',
        forget: 'write',
        get_weather: 'external_read',
        web_search: 'external_read',
        open_app: 'action',
        open_url: 'action',
        get_open_apps: 'read',
        discover_apps: 'read',
        list_directory: 'read',
        read_file: 'read',
        get_volume: 'read',
        set_volume: 'action',
        mute_volume: 'action',
        unmute_volume: 'action',
        media_play_pause: 'action',
        is_app_running: 'read',
        get_active_window: 'read',
        list_windows: 'read',
        focus_window: 'action',
        maximize_window: 'action',
        minimize_window: 'action',
        restore_window: 'action',
        close_window: 'action',
        inspect_ui: 'read',
        find_ui_element: 'read',
        focus_ui_element: 'action',
        invoke_ui_element: 'action',
        set_ui_value: 'action',
        get_ui_value: 'read',
        whatsapp_open_chat: 'action',
        whatsapp_prepare_message: 'action',
        whatsapp_get_status: 'read',
        generate_speech: 'external_read',
        play_audio: 'action',
        spotify_get_current_track: 'external_read',
        spotify_search: 'external_read',
        spotify_get_devices: 'external_read',
        spotify_play: 'action',
        spotify_pause: 'action',
        spotify_next: 'action',
        spotify_previous: 'action',
        get_email_connection_status: 'read',
        list_email_mailboxes: 'read',
        list_recent_emails: 'read',
        search_emails: 'read',
        get_email: 'read',
        prepare_email: 'read',
        prepare_email_reply: 'read',
        confirm_pending_action: 'action',
        cancel_pending_action: 'action',
        resolve_pending_action: 'action',
        list_calendar_events: 'read',
        get_calendar_event: 'read',
        prepare_calendar_event: 'action',
        prepare_calendar_event_update: 'action',
        prepare_calendar_event_cancel: 'action',
    });

    for (const registration of localToolRegistry.values()) {
        assert.equal(registration.permission, toolPermissions[registration.definition.name]);
        assert.deepEqual(Object.keys(registration), ['definition', 'execute', 'permission']);
    }
});

test('the default policy allows current permissions and denies unknown ones', () => {
    for (const registration of localToolRegistry.values()) {
        assert.equal(checkToolPermission(registration).allowed, true);
    }
    assert.equal(checkToolPermission({ permission: 'destructive' }).allowed, false);
    assert.equal(defaultPermissionPolicy.action, true);
    assert.equal(defaultPermissionPolicy.destructive, false);

    assert.deepEqual(
        checkToolPermission({ permission: 'not_configured' }),
        {
            allowed: false,
            permission: 'not_configured',
            reason: 'permission_denied',
        }
    );
});

test('a denied tool returns a structured result without executing or saving', async () => {
    const memory = { facts: [], preferences: {} };
    let saveCount = 0;
    const result = await executeTool(
        'remember',
        { category: 'fact', key: 'blocked', value: 'should not be saved' },
        {
            memory,
            saveMemory: async () => { saveCount += 1; },
            permissionPolicy: {
                ...defaultPermissionPolicy,
                write: false,
            },
        }
    );

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'memory1_write_disabled');
    assert.equal(result.permission, 'write');
    assert.deepEqual(memory.facts, []);
    assert.equal(saveCount, 0);
});

test('legacy Memory1 writes stay blocked even when invoked directly through the dispatcher', async () => {
    const memory = { facts: [], preferences: {} };
    let saveCount = 0;
    const context = {
        memory,
        saveMemory: async () => { saveCount += 1; },
        permissionPolicy: defaultPermissionPolicy,
    };

    assert((await executeTool('get_current_time', {}, context)).iso);
    for (const [name, args] of [
        ['remember', { category: 'fact', key: 'permission_test', value: 'must not be saved' }],
        ['forget', { category: 'fact', key: 'permission_test' }],
    ]) {
        const result = await executeTool(name, args, context);
        assert.equal(result.success, false);
        assert.equal(result.error.code, 'memory1_write_disabled');
        assert.match(result.error.message, /no se modificó ningún recuerdo/u);
    }
    assert.deepEqual(memory, { facts: [], preferences: {} });
    assert.equal(saveCount, 0);
});

test('legacy write tools are omitted from model tool definitions while recall remains available', async () => {
    const offered = getToolsForModel(defaultPermissionPolicy).map(tool => tool.name);
    assert(!offered.includes('remember'));
    assert(!offered.includes('forget'));
    assert(offered.includes('recall'));

    const memory = { user: {}, preferences: {}, facts: [{ key: 'permission_test', value: 'synthetic value' }] };
    const result = await executeTool('recall', { query: 'permission_test' }, { memory });
    assert.equal(result.success, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].value, 'synthetic value');
});

test('disabled Memory1 writes do not call a persistence callback that targets a synthetic file', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-m0-memory-'));
    const filePath = path.join(directory, 'memory.json');
    const original = '{"facts":[],"preferences":{}}\n';
    await fs.writeFile(filePath, original, 'utf8');
    let saveCount = 0;
    try {
        const memory = { facts: [], preferences: {} };
        const saveMemory = async value => {
            saveCount += 1;
            await fs.writeFile(filePath, JSON.stringify(value), 'utf8');
        };
        for (const [name, args] of [
            ['remember', { category: 'fact', key: 'synthetic', value: 'synthetic' }],
            ['forget', { category: 'fact', key: 'synthetic' }],
        ]) await executeTool(name, args, { memory, saveMemory });
        assert.equal(await fs.readFile(filePath, 'utf8'), original);
        assert.equal(saveCount, 0);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('Spotify, Windows and general tool definitions remain available', () => {
    const offered = new Set(getToolsForModel(defaultPermissionPolicy).map(tool => tool.name));
    for (const name of ['spotify_search', 'open_app', 'get_current_time', 'recall']) assert(offered.has(name));
});

test('legacy write registrations keep their declared permission but the dispatcher still denies them', async () => {
    for (const name of ['remember', 'forget']) {
        assert.equal(localToolRegistry.get(name).permission, 'write');
        const result = await executeTool(name, {}, { permissionPolicy: { write: true } });
        assert.equal(result.success, false);
        assert.equal(result.error.code, 'memory1_write_disabled');
    }
});

test('the Memory1 write block does not change the selected backend or automatic-memory defaults', async () => {
    const { config } = await import('../src/config.js');
    assert.equal(config.memoryBackend, 'memory1');

    const { createAgent } = await import('../src/core/agent.js');
    const agent = await createAgent({
        ask: async () => ({ output: [], output_text: '' }),
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
    });
    try {
        assert.equal(agent.memoryBackend, 'memory1');
        assert.equal(agent.automaticMemoryControls.automaticAnalysisEnabled, false);
        assert.equal(agent.automaticMemoryControls.automaticSavingEnabled, false);
    } finally {
        await agent.close();
    }
});

test('an unsolicited model write call is denied even though the model tool list omits it', async () => {
    const requests = [];
    let saveCount = 0;
    const responses = [
        { output: [{ type: 'function_call', name: 'remember', call_id: 'remember-1',
            arguments: JSON.stringify({ category: 'fact', key: 'synthetic', value: 'synthetic' }) }], output_text: '' },
        { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Entendido.' }] }], output_text: 'Entendido.' },
    ];
    const { createAgent } = await import('../src/core/agent.js');
    const agent = await createAgent({
        ask: async request => { requests.push(request); return responses.shift(); },
        load: async () => ({ user: {}, preferences: {}, facts: [] }),
        save: async () => { saveCount += 1; },
    });
    try {
        const answer = await agent.run('Una solicitud sintética.');
        assert.equal(answer, 'Entendido.');
        assert(!requests[0].tools.some(tool => ['remember', 'forget'].includes(tool.name)));
        assert(requests[1].input.some(item => item.type === 'function_call_output'
            && JSON.parse(item.output).error?.code === 'memory1_write_disabled'));
        assert.equal(saveCount, 0);
        assert.deepEqual(agent.memory.facts, []);
    } finally {
        await agent.close();
    }
});

test('read and non-memory tools remain callable under the default policy', async () => {
    const context = { permissionPolicy: defaultPermissionPolicy };
    assert((await executeTool('get_current_time', {}, context)).iso);
    assert.equal((await executeTool('recall', { query: 'missing' }, { memory: { facts: [] } })).success, true);
});

test('a denied external tool does not make an HTTP request', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    try {
        globalThis.fetch = async () => {
            fetchCalled = true;
            throw new Error('fetch should not be called');
        };

        const result = await executeTool(
            'get_weather',
            { location: 'Barcelona' },
            {
                permissionPolicy: {
                    ...defaultPermissionPolicy,
                    external_read: false,
                },
            }
        );

        assert.equal(result.success, false);
        assert.equal(result.error.code, 'permission_denied');
        assert.equal(result.permission, 'external_read');
        assert.equal(fetchCalled, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a denied email confirmation is stopped before the communications tool runs', async () => {
    const result = await executeTool('confirm_pending_action', { actionId: 'action_0123456789abcdef0123456789abcdef' }, {
        permissionPolicy: { ...defaultPermissionPolicy, action: false },
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'permission_denied');
    assert.equal(result.permission, 'action');
});

test('hosted Web Search is available only when external reads are allowed', () => {
    assert(getToolsForModel().some(tool => tool.type === 'web_search'));

    const restrictedTools = getToolsForModel({
        ...defaultPermissionPolicy,
        external_read: false,
    });

    assert(!restrictedTools.some(tool => tool.type === 'web_search'));
    assert(restrictedTools.some(tool => tool.name === 'get_weather'));
});
