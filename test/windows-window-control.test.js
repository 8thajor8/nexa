import assert from 'node:assert/strict';
import test from 'node:test';

import { executeTool, localToolRegistry } from '../src/tools/index.js';
import { defaultPermissionPolicy } from '../src/tools/permissions.js';
import {
    getActiveWindow,
    isAppRunning,
    listWindows,
    matchWindows,
} from '../src/windows/window-control.js';
import { listRunningProcesses } from '../src/windows/processes.js';

function taskList(processes) {
    return processes.map(({ name, pid }) => `"${name}","${pid}","Console","1","1,024 K"`).join('\r\n');
}

function makeWindowsApi({ windows, activeHandle = null } = {}) {
    const calls = [];
    const records = new Map(windows.map(window => [window.handle, window]));
    return {
        calls,
        enumerateHandles: () => [...records.keys()],
        isWindowVisible: handle => records.get(handle)?.visible ?? false,
        getWindowInfo: handle => records.get(handle),
        getForegroundHandle: () => activeHandle,
        focus: handle => { calls.push(['focus', handle]); return true; },
        show: (handle, action) => { calls.push(['show', handle, action]); return true; },
        close: handle => { calls.push(['close', handle]); return true; },
    };
}

const visibleWindows = [
    { handle: 0x10n, title: 'ChatGPT - Google Chrome', pid: 42, visible: true },
    { handle: 0x20n, title: 'Spotify Premium', pid: 43, visible: true },
    { handle: 0x30n, title: 'Spotify - Playlist', pid: 44, visible: true },
    { handle: 0x40n, title: 'Hidden window', pid: 45, visible: false },
    { handle: 0x50n, title: '', pid: 42, visible: true },
];

const listProcesses = async () => taskList([
    { name: 'chrome.exe', pid: 42 },
    { name: 'Spotify.exe', pid: 43 },
    { name: 'Spotify.exe', pid: 44 },
    { name: 'hidden.exe', pid: 45 },
]);

const loadCatalog = async () => ({ version: 1, apps: [] });

test('is_app_running finds an application outside get_open_apps first 100 rows', async () => {
    const processes = Array.from({ length: 125 }, (_, index) => ({
        name: `process${index}.exe`, pid: index + 1,
    }));
    processes.push({ name: 'Spotify.exe', pid: 126 });
    const result = await isAppRunning({
        args: { app: 'Spotify' },
        platform: 'win32',
        loadCatalog,
        listProcesses: async () => taskList(processes),
    });
    assert.deepEqual(result, {
        success: true,
        running: true,
        app: 'spotify',
        processes: [{ name: 'Spotify.exe', pid: 126 }],
    });
});

test('native Tool Help snapshot includes the current Windows process', {
    skip: process.platform !== 'win32',
}, async () => {
    const result = await listRunningProcesses();
    assert.equal(result.success, true);
    assert(result.processes.some(processInfo => processInfo.pid === process.pid));
});

test('get_open_apps keeps working against the native Windows process snapshot', {
    skip: process.platform !== 'win32',
}, async () => {
    const result = await executeTool('get_open_apps', {});
    assert.equal(result.success, true);
    assert(result.totalCount > 0);
    assert.equal(result.processes.length, Math.min(result.totalCount, 100));
});

test('is_app_running returns a structured false result and rejects unknown names', async () => {
    const notRunning = await isAppRunning({
        args: { app: 'Spotify' }, platform: 'win32', loadCatalog,
        listProcesses: async () => taskList([{ name: 'chrome.exe', pid: 42 }]),
        readSnapshot: async () => ({ success: true, windows: [] }),
    });
    assert.deepEqual(notRunning, {
        success: true, running: false, app: 'spotify', processes: [],
    });

    const unknown = await isAppRunning({
        args: { app: 'powershell.exe -Command whoami' }, platform: 'win32', loadCatalog,
        listProcesses: async () => '',
    });
    assert.equal(unknown.success, false);
    assert.equal(unknown.error.code, 'app_not_found');
});

test('is_app_running recognizes an AppX app when its visible window belongs to the generic frame host', async () => {
    const app = {
        name: 'Example Notes', displayName: 'Example Notes', aliases: ['Notes'], source: 'appx',
        appUserModelId: 'Example.Package_123abc!App', launchable: true, processNames: ['notes.exe'],
    };
    const result = await isAppRunning({
        args: { app: 'Notes' },
        platform: 'win32',
        loadCatalog: async () => ({ version: 1, apps: [app] }),
        listProcesses: async () => taskList([{ name: 'ApplicationFrameHost.exe', pid: 404 }]),
        readSnapshot: async () => ({ success: true, windows: [{
            id: '0x454', title: 'Example Notes', process: 'ApplicationFrameHost.exe', pid: 404,
        }] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.running, true);
    assert.deepEqual(result.processes, [{ name: 'ApplicationFrameHost.exe', pid: 404 }]);
});

test('is_app_running and UI Automation share the built-in modern-window matcher', async () => {
    const result = await isAppRunning({
        args: { app: 'Calculator' },
        platform: 'win32',
        loadCatalog: async () => ({ version: 1, apps: [] }),
        listProcesses: async () => taskList([{ name: 'ApplicationFrameHost.exe', pid: 505 }]),
        readSnapshot: async () => ({ success: true, windows: [{
            id: '0x505', title: 'Calculator', process: 'ApplicationFrameHost.exe', pid: 505,
        }] }),
    });
    assert.equal(result.success, true);
    assert.equal(result.running, true);
    assert.equal(result.processes[0].name, 'ApplicationFrameHost.exe');
});

test('is_app_running resolves discovered apps through the existing catalog', async () => {
    const result = await isAppRunning({
        args: { app: 'Ableton' },
        platform: 'win32',
        loadCatalog: async () => ({
            version: 1,
            apps: [{
                name: 'Ableton Live 12 Suite',
                aliases: ['ableton'],
                path: 'C:\\Program Files\\Ableton\\Live 12\\Ableton Live.exe',
            }],
        }),
        environment: { ProgramFiles: 'C:\\Program Files' },
        listProcesses: async () => taskList([{ name: 'Ableton Live.exe', pid: 84 }]),
    });
    assert.deepEqual(result, {
        success: true,
        running: true,
        app: 'Ableton Live 12 Suite',
        processes: [{ name: 'Ableton Live.exe', pid: 84 }],
    });
});

test('list_windows and get_active_window return identified visible windows only', async () => {
    const windowsApi = makeWindowsApi({ windows: visibleWindows, activeHandle: 0x10n });
    const options = { platform: 'win32', windowsApi, listProcesses };
    const listed = await listWindows(options);
    assert.equal(listed.success, true);
    assert.equal(listed.count, 3);
    assert.deepEqual(listed.windows[0], {
        id: '0x10', title: 'ChatGPT - Google Chrome', process: 'chrome.exe', pid: 42,
    });

    assert.deepEqual(await getActiveWindow(options), {
        success: true,
        window: {
            id: '0x10', title: 'ChatGPT - Google Chrome', process: 'chrome.exe', pid: 42,
        },
    });
});

test('get_active_window reports null when Windows has no identified foreground window', async () => {
    const result = await getActiveWindow({
        platform: 'win32',
        windowsApi: makeWindowsApi({ windows: visibleWindows }),
        listProcesses,
    });
    assert.deepEqual(result, { success: true, window: null });
});

test('application and title matching preserve ambiguity instead of choosing a window', () => {
    const windows = visibleWindows.slice(0, 3).map(window => ({
        id: `0x${window.handle.toString(16)}`,
        title: window.title,
        process: window.handle === 0x10n ? 'chrome.exe' : 'Spotify.exe',
        pid: window.pid,
        _handle: window.handle,
    }));
    const spotify = matchWindows(windows, 'Spotify', { apps: [] });
    assert.equal(spotify.matches.length, 2);
    assert.equal(spotify.kind, 'application');
    const title = matchWindows(windows, 'ChatGPT', { apps: [] });
    assert.equal(title.matches.length, 1);
    assert.equal(title.kind, 'title');
});

test('window actions act only on a unique resolved window and use normal close', async () => {
    const windowsApi = makeWindowsApi({ windows: visibleWindows });
    const context = {
        platform: 'win32', windowsApi, listProcesses, loadCatalog,
    };

    const ambiguous = await executeTool('minimize_window', { target: 'Spotify' }, context);
    assert.equal(ambiguous.error.code, 'ambiguous_window');
    assert.deepEqual(windowsApi.calls, []);

    const focused = await executeTool('focus_window', { target: 'ChatGPT' }, context);
    assert.equal(focused.success, true);
    assert.deepEqual(windowsApi.calls[0], ['focus', 0x10n]);

    const closed = await executeTool('close_window', { target: 'ChatGPT' }, context);
    assert.equal(closed.success, true);
    assert.deepEqual(windowsApi.calls[1], ['close', 0x10n]);
});

test('maximize, minimize and restore resolve a window and issue their fixed actions', async () => {
    const windowsApi = makeWindowsApi({ windows: visibleWindows });
    const context = { platform: 'win32', windowsApi, listProcesses, loadCatalog };
    for (const action of ['maximize', 'minimize', 'restore']) {
        const result = await executeTool(`${action}_window`, { target: 'ChatGPT' }, context);
        assert.equal(result.success, true);
        assert.equal(result.action, action);
    }
    assert.deepEqual(windowsApi.calls, [
        ['show', 0x10n, 'maximize'],
        ['show', 0x10n, 'minimize'],
        ['show', 0x10n, 'restore'],
    ]);
});

test('window actions report missing windows and do not accept HWND or PID input', async () => {
    const windowsApi = makeWindowsApi({ windows: visibleWindows });
    const result = await executeTool('maximize_window', { target: 'No such window' }, {
        platform: 'win32', windowsApi, listProcesses, loadCatalog,
    });
    assert.equal(result.error.code, 'window_not_found');

    for (const name of [
        'focus_window', 'maximize_window', 'minimize_window', 'restore_window', 'close_window',
    ]) {
        const properties = localToolRegistry.get(name).definition.parameters.properties;
        assert.deepEqual(Object.keys(properties), ['target']);
        assert(!Object.hasOwn(properties, 'hwnd'));
        assert(!Object.hasOwn(properties, 'pid'));
    }
});

test('permission denial blocks window actions before Windows is called', async () => {
    let enumerationCount = 0;
    const windowsApi = makeWindowsApi({ windows: visibleWindows });
    const originalEnumerate = windowsApi.enumerateHandles;
    windowsApi.enumerateHandles = () => {
        enumerationCount += 1;
        return originalEnumerate();
    };
    const result = await executeTool('close_window', { target: 'ChatGPT' }, {
        platform: 'win32', windowsApi, listProcesses, loadCatalog,
        permissionPolicy: { ...defaultPermissionPolicy, action: false },
    });
    assert.equal(result.error.code, 'permission_denied');
    assert.equal(enumerationCount, 0);
});

test('window awareness tools declare the requested permissions', () => {
    for (const [name, permission] of [
        ['is_app_running', 'read'], ['get_active_window', 'read'], ['list_windows', 'read'],
        ['focus_window', 'action'], ['maximize_window', 'action'], ['minimize_window', 'action'],
        ['restore_window', 'action'], ['close_window', 'action'],
    ]) {
        assert.equal(localToolRegistry.get(name)?.permission, permission);
    }
    assert.deepEqual(
        Object.keys(localToolRegistry.get('is_app_running').definition.parameters.properties),
        ['app']
    );
});
