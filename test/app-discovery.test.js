import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverApps, isTrustedAppPath } from '../src/windows/app-discovery.js';
import {
    findAppInCatalog,
    loadAppCatalog,
    normalizeAppName,
} from '../src/windows/app-catalog.js';
import { executeTool, localToolRegistry } from '../src/tools/index.js';
import { defaultPermissionPolicy } from '../src/tools/permissions.js';
import { resolveShortcutTarget } from '../src/windows/shortcut.js';
import { windowsAppWhitelist } from '../src/tools/windows.js';

const environment = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData',
    LOCALAPPDATA: 'C:\\Users\\Jor\\AppData\\Local',
};

function makeShortcut(target) {
    const header = Buffer.alloc(0x4c);
    header.writeUInt32LE(0x4c, 0);
    header.writeUInt32LE(0x00021401, 4);
    header.writeUInt32LE(0x00000002, 20);

    const base = path.win32.dirname(target);
    const suffix = path.win32.basename(target);
    const baseAnsi = Buffer.from(`${base}\0`, 'latin1');
    const suffixAnsi = Buffer.from(`${suffix}\0`, 'latin1');
    const baseUnicode = Buffer.from(`${base}\0`, 'utf16le');
    const suffixUnicode = Buffer.from(`${suffix}\0`, 'utf16le');
    const infoHeaderSize = 0x24;
    const localBaseOffset = infoHeaderSize;
    const commonSuffixOffset = localBaseOffset + baseAnsi.length;
    const unicodeBaseOffset = commonSuffixOffset + suffixAnsi.length;
    const unicodeSuffixOffset = unicodeBaseOffset + baseUnicode.length;
    const infoSize = unicodeSuffixOffset + suffixUnicode.length;
    const info = Buffer.alloc(infoSize);

    info.writeUInt32LE(infoSize, 0);
    info.writeUInt32LE(infoHeaderSize, 4);
    info.writeUInt32LE(1, 8);
    info.writeUInt32LE(localBaseOffset, 16);
    info.writeUInt32LE(commonSuffixOffset, 24);
    info.writeUInt32LE(unicodeBaseOffset, 28);
    info.writeUInt32LE(unicodeSuffixOffset, 32);
    baseAnsi.copy(info, localBaseOffset);
    suffixAnsi.copy(info, commonSuffixOffset);
    baseUnicode.copy(info, unicodeBaseOffset);
    suffixUnicode.copy(info, unicodeSuffixOffset);

    return Buffer.concat([header, info]);
}

function fileEntry(name) {
    return {
        name,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
    };
}

test('shortcut parser resolves the local executable target without launching it', () => {
    const target = 'C:\\Program Files\\Ableton\\Live 12\\Ableton Live 12 Suite.exe';
    assert.equal(resolveShortcutTarget(makeShortcut(target), environment), target);
});

test('discover_apps builds and persists a structured catalogue from Start Menu shortcuts', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'nexa-apps-'));
    const catalogPath = path.join(tempDirectory, 'apps.json');
    const startMenu = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
    const target = 'C:\\Program Files\\Ableton\\Live 12\\Ableton Live 12 Suite.exe';
    const statCalls = [];
    const fileSystem = {
        readdir: async () => [fileEntry('Ableton Live.lnk')],
        readFile: async filePath => {
            assert.equal(filePath, path.win32.join(startMenu, 'Ableton Live.lnk'));
            return makeShortcut(target);
        },
        stat: async filePath => {
            statCalls.push(filePath);
            return { isFile: () => true, size: 1024 };
        },
    };

    try {
        const result = await discoverApps({
            platform: 'win32',
            environment,
            directories: [startMenu],
            fileSystem,
            catalogPath,
            readAppxApps: async () => ({ success: true, apps: [] }),
        });
        const catalog = await loadAppCatalog({ catalogPath, read: readFile });

        assert.deepEqual(result, {
            success: true,
            count: 1,
            newCount: 1,
            updated: true,
        });
        assert.equal(catalog.version, 1);
        assert.equal(typeof catalog.updatedAt, 'string');
        assert.deepEqual(catalog.apps[0], {
            name: 'Ableton Live',
            aliases: ['ableton live'],
            path: target,
            source: 'common_start_menu',
        });
        assert.deepEqual(statCalls, [
            path.win32.join(startMenu, 'Ableton Live.lnk'),
            target,
        ]);
    } finally {
        await rm(tempDirectory, { recursive: true, force: true });
    }
});

test('discovery excludes targets outside trusted install locations and command interpreters', () => {
    assert.equal(
        isTrustedAppPath('C:\\Users\\Jor\\Downloads\\unknown.exe', environment),
        false
    );
    assert.equal(
        isTrustedAppPath('C:\\Program Files\\Tools\\powershell.exe', environment),
        false
    );
    assert.equal(
        isTrustedAppPath('C:\\Program Files\\Ableton\\Ableton.exe', environment),
        true
    );
});

test('app names normalize accents, case, spacing and a trailing app label', () => {
    assert.equal(normalizeAppName('  SPOTÍFY   app  '), 'spotify');
    const ableton = { name: 'Ableton Live 12 Suite', aliases: [], path: 'x' };
    assert.equal(findAppInCatalog({ apps: [ableton] }, 'Ableton'), ableton);
    assert.equal(
        findAppInCatalog({
            apps: [ableton, { name: 'Ableton Live Lite', aliases: [], path: 'y' }],
        }, 'Ableton'),
        null
    );
});

test('open_app resolves a discovered app by its human name and launches only its stored executable', async () => {
    const calls = [];
    const target = 'C:\\Program Files\\Ableton\\Live 12\\Ableton Live 12 Suite.exe';
    const result = await executeTool('open_app', { app: 'Ableton' }, {
        platform: 'win32',
        environment,
        loadCatalog: async () => ({
            version: 1,
            apps: [{
                name: 'Ableton Live 12 Suite',
                aliases: ['ableton'],
                path: target,
                source: 'common_start_menu',
            }],
        }),
        launchProcess: async (...args) => calls.push(args),
    });

    assert.equal(result.success, true);
    assert.equal(result.app, 'Ableton Live 12 Suite');
    assert.deepEqual(calls, [[target, []]]);
});

test('open_app rejects executable paths and returns app_not_found for unknown apps', async () => {
    for (const app of [
        'C:\\Program Files\\Ableton\\Ableton.exe',
        'powershell.exe',
        'Definitely Not Installed',
    ]) {
        let launched = false;
        const result = await executeTool('open_app', { app }, {
            platform: 'win32',
            launchProcess: async () => { launched = true; },
            loadCatalog: async () => ({ version: 1, apps: [] }),
        });

        assert.equal(result.success, false);
        assert.equal(result.error.code, 'app_not_found');
        assert.equal(launched, false);
    }
});

test('open_app keeps the explicit whitelist fallback and respects action permissions', async () => {
    const calls = [];
    const launched = await executeTool('open_app', { app: 'notepad' }, {
        platform: 'win32',
        loadCatalog: async () => ({ version: 1, apps: [] }),
        launchProcess: async (...args) => calls.push(args),
    });
    assert.equal(launched.success, true);
    assert.deepEqual(calls, [[windowsAppWhitelist.notepad[0].executable, []]]);

    const blocked = await executeTool('open_app', { app: 'notepad' }, {
        platform: 'win32',
        launchProcess: async () => assert.fail('A denied action must not launch.'),
        permissionPolicy: { ...defaultPermissionPolicy, action: false },
    });
    assert.equal(blocked.success, false);
    assert.equal(blocked.error.code, 'permission_denied');
});

test('discover_apps is a registered read capability and existing Windows tools remain registered', () => {
    assert.equal(localToolRegistry.get('discover_apps').permission, 'read');
    for (const toolName of ['open_app', 'open_url', 'get_open_apps']) {
        assert(localToolRegistry.has(toolName));
    }
});
