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
    assert.equal(result.error.code, 'permission_denied');
    assert.equal(result.permission, 'write');
    assert.deepEqual(memory.facts, []);
    assert.equal(saveCount, 0);
});

test('the default policy still lets read and write tools execute', async () => {
    const memory = { facts: [], preferences: {} };
    let saveCount = 0;
    const context = {
        memory,
        saveMemory: async () => { saveCount += 1; },
    };

    assert((await executeTool('get_current_time', {}, context)).iso);
    await executeTool(
        'remember',
        { category: 'fact', key: 'permission_test', value: 'allowed' },
        context
    );
    assert.equal(
        (await executeTool('recall', { query: 'permission_test' }, context)).results.length,
        1
    );
    assert.equal(
        (await executeTool('forget', { category: 'fact', key: 'permission_test' }, context)).success,
        true
    );
    assert.deepEqual(memory.facts, []);
    assert.equal(saveCount, 2);
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

test('hosted Web Search is available only when external reads are allowed', () => {
    assert(getToolsForModel().some(tool => tool.type === 'web_search'));

    const restrictedTools = getToolsForModel({
        ...defaultPermissionPolicy,
        external_read: false,
    });

    assert(!restrictedTools.some(tool => tool.type === 'web_search'));
    assert(restrictedTools.some(tool => tool.name === 'get_weather'));
});
