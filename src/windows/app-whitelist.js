import path from 'node:path';

const programFiles = process.env.ProgramFiles;
const programFilesX86 = process.env['ProgramFiles(x86)'];
const localAppData = process.env.LOCALAPPDATA;
const roamingAppData = process.env.APPDATA;
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';

const windowsPath = (root, ...parts) => root
    ? path.win32.join(root, ...parts)
    : null;

const target = (executable, args = []) => Object.freeze({
    executable,
    args: Object.freeze(args),
});

const fixedTargets = (...executables) => Object.freeze(
    executables
        .filter(Boolean)
        .map(executable => target(executable))
);

export const windowsAppWhitelist = Object.freeze({
    chrome: fixedTargets(
        windowsPath(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        windowsPath(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        windowsPath(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ),
    edge: fixedTargets(
        windowsPath(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        windowsPath(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ),
    notepad: fixedTargets(windowsPath(systemRoot, 'System32', 'notepad.exe')),
    calculator: fixedTargets(windowsPath(systemRoot, 'System32', 'calc.exe')),
    explorer: fixedTargets(windowsPath(systemRoot, 'explorer.exe')),
    spotify: fixedTargets(
        windowsPath(localAppData, 'Programs', 'Spotify', 'Spotify.exe'),
        windowsPath(roamingAppData, 'Spotify', 'Spotify.exe'),
        windowsPath(programFiles, 'Spotify', 'Spotify.exe')
    ),
    discord: Object.freeze([
        ...(windowsPath(localAppData, 'Discord', 'Update.exe')
            ? [target(
                windowsPath(localAppData, 'Discord', 'Update.exe'),
                ['--processStart', 'Discord.exe']
            )]
            : []),
    ]),
});
