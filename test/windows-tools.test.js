import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { defaultPermissionPolicy } from '../src/tools/permissions.js';
import { executeTool, getToolsForModel, localToolRegistry } from '../src/tools/index.js';
import {
    getOpenApps,
    openApp,
    openUrl,
    windowsAppWhitelist,
} from '../src/tools/windows.js';

test('open_app launches only a whitelisted application target', async () => {
    const calls = [];
    const result = await openApp({
        args: { app: 'notepad' },
        platform: 'win32',
        loadCatalog: async () => ({ apps: [] }),
        launchProcess: async (...args) => calls.push(args),
    });

    assert.equal(result.success, true);
    assert.equal(result.app, 'notepad');
    assert.deepEqual(calls, [[windowsAppWhitelist.notepad[0].executable, []]]);
});

test('open_app rejects arbitrary commands without launching a process', async () => {
    let launched = false;
    const result = await openApp({
        args: { app: 'powershell -Command calc' },
        platform: 'win32',
        launchProcess: async () => { launched = true; },
    });

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'app_not_found');
    assert.equal(launched, false);
});

test('open_url accepts HTTPS and sends it as an argument to the fixed Windows handler', async () => {
    let call;
    const result = await openUrl({
        args: { url: 'https://example.com/path?q=hello' },
        platform: 'win32',
        launchProcess: async (...args) => { call = args; },
    });

    assert.equal(result.success, true);
    assert.equal(path.win32.basename(call[0]), 'rundll32.exe');
    assert.equal(path.win32.basename(path.win32.dirname(call[0])), 'System32');
    assert.deepEqual(call[1], [
        'url.dll,FileProtocolHandler',
        'https://example.com/path?q=hello',
    ]);
});

test('open_url rejects file URLs and command-like input', async () => {
    for (const url of ['file:///C:/Windows/win.ini', 'https://example.com & calc']) {
        let launched = false;
        const result = await openUrl({
            args: { url },
            platform: 'win32',
            launchProcess: async () => { launched = true; },
        });

        assert.equal(result.success, false);
        assert.equal(result.error.code, 'invalid_url');
        assert.equal(launched, false);
    }
});

test('get_open_apps returns a bounded structured process list', async () => {
    const output = Array.from({ length: 105 }, (_, index) =>
        `"app${index}.exe","${index + 10}","Console","1","1,024 K"`
    ).join('\r\n');
    const result = await getOpenApps({
        listProcesses: async () => output,
        platform: 'win32',
    });

    assert.equal(result.success, true);
    assert.equal(result.count, 100);
    assert.equal(result.totalCount, 105);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.processes[0], { name: 'app0.exe', pid: 10 });
    assert.deepEqual(Object.keys(result.processes[0]), ['name', 'pid']);
});

test('permission denial prevents a Windows action from executing', async () => {
    let launched = false;
    const result = await executeTool('open_app', { app: 'notepad' }, {
        platform: 'win32',
        launchProcess: async () => { launched = true; },
        permissionPolicy: { ...defaultPermissionPolicy, action: false },
    });

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'permission_denied');
    assert.equal(launched, false);
});

test('process launcher always disables shell execution and detaches the child', async () => {
    const { launchDetachedProcess } = await import('../src/tools/windows.js');
    const child = new EventEmitter();
    let launchOptions;
    let unreferenced = false;
    child.unref = () => { unreferenced = true; };

    const started = launchDetachedProcess('fixed.exe', ['safe-arg'], (executable, args, options) => {
        launchOptions = { executable, args, options };
        queueMicrotask(() => child.emit('spawn'));
        return child;
    });

    await started;
    assert.equal(launchOptions.executable, 'fixed.exe');
    assert.deepEqual(launchOptions.args, ['safe-arg']);
    assert.equal(launchOptions.options.shell, false);
    assert.equal(unreferenced, true);
});

test('Windows tools are registered without removing existing tools or hosted Web Search', () => {
    for (const name of ['open_app', 'open_url', 'get_open_apps']) {
        assert(localToolRegistry.has(name));
    }
    for (const name of ['get_current_time', 'remember', 'recall', 'forget', 'get_weather']) {
        assert(localToolRegistry.has(name));
    }
    assert(getToolsForModel().some(tool => tool.type === 'web_search'));
});
