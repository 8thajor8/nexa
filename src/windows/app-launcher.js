import { spawn } from 'node:child_process';
import path from 'node:path';
import { isSafeAppUserModelId } from './appx-discovery.js';

function launchDetached(executable, args, spawnProcess) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnProcess(executable, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                shell: false,
            });
        } catch (error) {
            reject(error);
            return;
        }
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

export async function launchResolvedApp(app, targetType, {
    launchProcess = (executable, args) => launchDetached(executable, args, spawn),
    environment = process.env,
} = {}) {
    if (targetType === 'appx') {
        if (!isSafeAppUserModelId(app?.appUserModelId)) throw new Error('Invalid AppUserModelId');
        const systemRoot = environment.SystemRoot ?? environment.WINDIR ?? 'C:\\Windows';
        const explorer = path.win32.join(systemRoot, 'explorer.exe');
        await launchProcess(explorer, [`shell:AppsFolder\\${app.appUserModelId}`]);
        return;
    }
    if (targetType === 'shortcut' && typeof app?.path === 'string') {
        await launchProcess(app.path, []);
        return;
    }
    throw new Error('Unsupported application target');
}
