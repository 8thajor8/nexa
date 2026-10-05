import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAppInCatalog, normalizeAppName } from '../src/windows/app-catalog.js';
import { mergeDiscoveredApps } from '../src/windows/app-discovery.js';
import { launchResolvedApp } from '../src/windows/app-launcher.js';
import { resolveApp } from '../src/windows/app-resolution.js';
import { discoverAppxApps, normalizeAppxInventory } from '../src/windows/appx-discovery.js';
import { openApp } from '../src/tools/windows.js';
import { isAppRunning } from '../src/windows/window-control.js';

const appx = {
    name: 'Example Camera',
    displayName: 'Example Camera',
    aliases: ['Example Camera'],
    source: 'appx',
    packageName: 'Example.Camera',
    appUserModelId: 'Example.Camera_123abc!App',
    executable: 'CameraApp.exe',
    processNames: ['cameraapp.exe'],
    launchable: true,
};

test('AppX inventory normalizes valid entries and rejects unsafe identities', () => {
    const result = normalizeAppxInventory([
        { DisplayName: 'Camera', AppUserModelId: 'Microsoft.Camera_8wekyb3d8bbwe!App', PackageName: 'Microsoft.Camera', Executable: 'Camera.exe' },
        { DisplayName: 'Bad', AppUserModelId: 'bad!id & calc', PackageName: 'Bad', Executable: 'bad.exe' },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'appx');
    assert.deepEqual(result[0].processNames, ['camera.exe']);
});

test('AppX inventory invocation is fixed, non-interactive, and has no model arguments', async () => {
    let call;
    const result = await discoverAppxApps({
        platform: 'win32',
        environment: { SystemRoot: 'C:\\Windows' },
        readInventory: async options => {
            call = options;
            return [{ DisplayName: 'Camera', AppUserModelId: 'Microsoft.Camera_8wekyb3d8bbwe!App' }];
        },
    });
    assert.equal(result.success, true);
    assert.deepEqual(call, { environment: { SystemRoot: 'C:\\Windows' } });
});

test('unified catalog combines sources and deduplicates stable source identities', () => {
    const apps = mergeDiscoveredApps(
        [
            { name: 'Example Camera', aliases: ['camera'], path: 'C:\\Program Files\\Camera\\camera.exe', source: 'common_start_menu' },
            { ...appx },
            { ...appx, aliases: ['Example Camera', 'camera'], processNames: ['cameraapp.exe'] },
        ]
    );
    assert.equal(apps.length, 2);
    assert.deepEqual(new Set(apps.map(app => app.source)), new Set(['appx', 'common_start_menu']));
    assert(apps.some(app => app.aliases.includes('camera')));
});

test('catalog resolver normalizes exact names, display names, prefixes, and reports ambiguity', () => {
    assert.equal(normalizeAppName('  CÁMERA App '), 'camera');
    const catalog = { apps: [
        { name: 'Spotify Music', displayName: 'Spotify', aliases: ['spotify'] },
        { name: 'Camera', displayName: 'Camera', aliases: ['camera'] },
        { name: 'Calculator', displayName: 'Calculator', aliases: ['calc'] },
    ] };
    assert.equal(resolveAppInCatalog(catalog, 'Spotify').app.name, 'Spotify Music');
    assert.equal(resolveAppInCatalog(catalog, 'cal').app.name, 'Calculator');
    assert.equal(resolveAppInCatalog(catalog, 'ca').status, 'ambiguous');
});

test('AppX resolution validates launch metadata and launcher uses only fixed Explorer plus AUMID', async () => {
    const result = resolveApp({ apps: [appx] }, 'Example Camera');
    assert.equal(result.status, 'found');
    assert.equal(result.targetType, 'appx');

    const calls = [];
    await launchResolvedApp(appx, 'appx', {
        environment: { SystemRoot: 'C:\\Windows' },
        launchProcess: async (...args) => calls.push(args),
    });
    assert.deepEqual(calls, [[
        'C:\\Windows\\explorer.exe',
        ['shell:AppsFolder\\Example.Camera_123abc!App'],
    ]]);

    const invalid = resolveApp({ apps: [{ ...appx, appUserModelId: 'powershell -Command calc' }] }, 'Example Camera');
    assert.equal(invalid.status, 'invalid_target');
    await assert.rejects(launchResolvedApp({ ...appx, appUserModelId: 'powershell -Command calc' }, 'appx'));
});

test('is_app_running matches AppX manifest process metadata without relying on app name', async () => {
    const result = await isAppRunning({
        args: { app: 'Example Camera' },
        platform: 'win32',
        loadCatalog: async () => ({ apps: [appx] }),
        listProcesses: async () => '"cameraapp.exe","404","Console","1","1,024 K"',
    });
    assert.equal(result.success, true);
    assert.equal(result.running, true);
    assert.deepEqual(result.processes, [{ name: 'cameraapp.exe', pid: 404 }]);
});

test('open_app returns structured ambiguous matches and never launches an arbitrary target', async () => {
    let launched = false;
    const ambiguous = await openApp({
        args: { app: 'camera' },
        platform: 'win32',
        loadCatalog: async () => ({ apps: [
            { ...appx, name: 'Camera Front', displayName: 'Camera Front' },
            { ...appx, name: 'Camera Rear', displayName: 'Camera Rear', appUserModelId: 'Other.Camera_123abc!App' },
        ] }),
        launchProcess: async () => { launched = true; },
    });
    assert.equal(ambiguous.error.code, 'ambiguous_app');
    assert.equal(ambiguous.matches.length, 2);
    assert.equal(launched, false);
});
