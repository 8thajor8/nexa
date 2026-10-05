import { execFile } from 'node:child_process';
import path from 'node:path';

const commandTimeoutMs = 20_000;
const commandMaxBuffer = 2 * 1024 * 1024;

// This fixed inventory script receives no model-controlled input. It joins
// Start Apps entries to installed package manifests so Nexa can retain the
// app identity used for launch and, when available, the process executable.
const appxInventoryScript = `
$ErrorActionPreference = 'Stop'
$metadataByAppId = @{}
foreach ($package in @(Get-AppxPackage)) {
    try {
        $manifest = Get-AppxPackageManifest -Package $package
        foreach ($application in @($manifest.Package.Applications.Application)) {
            $appUserModelId = "$($package.PackageFamilyName)!$($application.Id)"
            $metadataByAppId[$appUserModelId] = [pscustomobject]@{
                PackageName = $package.Name
                Executable = $application.Executable
            }
        }
    } catch {
        continue
    }
}
$results = @(
    foreach ($startApp in @(Get-StartApps)) {
        $metadata = $metadataByAppId[$startApp.AppID]
        if ($metadata) {
            [pscustomobject]@{
                DisplayName = $startApp.Name
                AppUserModelId = $startApp.AppID
                PackageName = $metadata.PackageName
                Executable = $metadata.Executable
            }
        }
    }
)
ConvertTo-Json -InputObject $results -Compress
`;

export function isSafeAppUserModelId(value) {
    return typeof value === 'string' &&
        value.length <= 256 &&
        /^[a-z0-9._-]+![a-z0-9._-]+$/iu.test(value);
}

function getPowerShellPath(environment) {
    const systemRoot = environment.SystemRoot ?? environment.WINDIR ?? 'C:\\Windows';
    return path.win32.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    );
}

export function runAppxInventory({
    environment = process.env,
    executeFile = execFile,
} = {}) {
    return new Promise((resolve, reject) => {
        executeFile(
            getPowerShellPath(environment),
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', appxInventoryScript],
            {
                encoding: 'utf8',
                timeout: commandTimeoutMs,
                maxBuffer: commandMaxBuffer,
                windowsHide: true,
                shell: false,
            },
            (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            }
        );
    });
}

function normalizeInventoryEntry(entry) {
    const displayName = typeof entry?.DisplayName === 'string'
        ? entry.DisplayName.trim()
        : '';
    const appUserModelId = typeof entry?.AppUserModelId === 'string'
        ? entry.AppUserModelId.trim()
        : '';
    const packageName = typeof entry?.PackageName === 'string'
        ? entry.PackageName.trim()
        : '';

    if (!displayName || displayName.length > 200 || !isSafeAppUserModelId(appUserModelId)) {
        return null;
    }

    const executable = typeof entry.Executable === 'string'
        ? entry.Executable.trim()
        : '';
    const executableName = path.win32.basename(executable);
    const blockedProcessNames = new Set([
        'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe', 'cscript.exe',
        'mshta.exe', 'rundll32.exe', 'regsvr32.exe', 'bash.exe', 'wsl.exe',
        'node.exe', 'python.exe', 'pythonw.exe', 'java.exe',
    ]);
    const processNames = /^[^\\/:]+\.exe$/iu.test(executableName) &&
        !blockedProcessNames.has(executableName.toLowerCase())
        ? [executableName.toLowerCase()]
        : [];

    return {
        name: displayName,
        displayName,
        aliases: packageName ? [displayName, packageName] : [displayName],
        source: 'appx',
        packageName: packageName || null,
        appUserModelId,
        executable: executable || null,
        processNames,
        launchable: true,
    };
}

export function normalizeAppxInventory(value) {
    let entries = value;
    if (typeof value === 'string') {
        try {
            entries = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(entries)) entries = entries ? [entries] : [];

    const byAppUserModelId = new Map();
    for (const entry of entries) {
        const app = normalizeInventoryEntry(entry);
        if (!app) continue;
        const key = app.appUserModelId.toLowerCase();
        const existing = byAppUserModelId.get(key);
        if (existing) {
            existing.aliases = [...new Set([...existing.aliases, ...app.aliases])];
            existing.processNames = [...new Set([...existing.processNames, ...app.processNames])];
        } else {
            byAppUserModelId.set(key, app);
        }
    }
    return [...byAppUserModelId.values()].sort((left, right) =>
        left.displayName.localeCompare(right.displayName)
    );
}

export async function discoverAppxApps({
    platform = process.platform,
    environment = process.env,
    readInventory = runAppxInventory,
} = {}) {
    if (platform !== 'win32') {
        return {
            success: false,
            error: {
                code: 'unsupported_platform',
                message: 'El descubrimiento AppX solo está disponible en Windows.',
            },
        };
    }

    try {
        const apps = normalizeAppxInventory(await readInventory({ environment }));
        if (!apps) throw new Error('Invalid AppX inventory output');
        return { success: true, apps };
    } catch {
        return {
            success: false,
            error: {
                code: 'appx_discovery_failed',
                message: 'No se pudieron consultar las aplicaciones AppX/MSIX de Windows.',
            },
        };
    }
}
