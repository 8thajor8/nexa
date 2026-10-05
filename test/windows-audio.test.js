import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultPermissionPolicy } from '../src/tools/permissions.js';
import { executeTool, localToolRegistry } from '../src/tools/index.js';
import {
    getVolume,
    mediaPlayPause,
    muteVolume,
    setVolume,
    unmuteVolume,
} from '../src/windows/audio.js';

test('get_volume returns a validated system volume response', async () => {
    assert.deepEqual(await getVolume({
        platform: 'win32',
        volumeController: { getVolume: async () => 50, getMuted: async () => false },
    }), { success: true, volume: 50, muted: false });
});

test('set_volume rejects values outside the integer range without calling Windows', async () => {
    let calls = 0;
    const volumeController = { setVolume: async () => { calls += 1; } };
    for (const volume of [-1, 101, 50.5, '50']) {
        const result = await setVolume({ args: { volume }, platform: 'win32', volumeController });
        assert.equal(result.success, false);
        assert.equal(result.error.code, 'invalid_volume');
    }
    assert.equal(calls, 0);
});

test('set, mute and unmute execute only their explicit volume operations', async () => {
    const calls = [];
    const volumeController = {
        setVolume: async value => calls.push(['volume', value]),
        setMuted: async value => calls.push(['muted', value]),
    };
    assert.deepEqual(await setVolume({ args: { volume: 35 }, platform: 'win32', volumeController }), { success: true, volume: 35 });
    assert.deepEqual(await muteVolume({ platform: 'win32', volumeController }), { success: true, muted: true });
    assert.deepEqual(await unmuteVolume({ platform: 'win32', volumeController }), { success: true, muted: false });
    assert.deepEqual(calls, [['volume', 35], ['muted', true], ['muted', false]]);
});

test('media_play_pause sends only the fixed media action', async () => {
    let sends = 0;
    const result = await mediaPlayPause({
        platform: 'win32',
        sendMediaKey: async () => { sends += 1; },
    });
    assert.deepEqual(result, { success: true, action: 'play_pause' });
    assert.equal(sends, 1);
});

test('permission denial prevents volume and media operations', async () => {
    let called = false;
    const permissionPolicy = { ...defaultPermissionPolicy, action: false };
    for (const name of ['set_volume', 'mute_volume', 'unmute_volume', 'media_play_pause']) {
        const result = await executeTool(name, { volume: 55 }, {
            platform: 'win32',
            permissionPolicy,
            volumeController: { setVolume: async () => { called = true; }, setMuted: async () => { called = true; } },
            sendMediaKey: async () => { called = true; },
        });
        assert.equal(result.error.code, 'permission_denied');
    }
    assert.equal(called, false);
});

test('all Batch 5 tools are registered with the intended permissions', () => {
    for (const [name, permission] of [
        ['list_directory', 'read'],
        ['read_file', 'read'],
        ['get_volume', 'read'],
        ['set_volume', 'action'],
        ['mute_volume', 'action'],
        ['unmute_volume', 'action'],
        ['media_play_pause', 'action'],
    ]) {
        const registration = localToolRegistry.get(name);
        assert(registration, `${name} must be registered`);
        assert.equal(registration.permission, permission);
        assert.equal(typeof registration.execute, 'function');
    }
});
