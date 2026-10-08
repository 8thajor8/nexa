import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const SID = /\b(S-1-(?:\d+-)+\d+)\b/iu;

/** Read the current process-token account SID. This identifies the Windows
 * account only; it does not prove who is at the keyboard or that Hello ran.
 */
export function createWindowsPrincipalProvider({ platform = process.platform,
    systemRoot = process.env.SystemRoot, execute = execFileAsync } = {}) {
    return Object.freeze({
        async getCurrentPrincipal() {
            if (platform !== 'win32' || typeof systemRoot !== 'string'
                || !path.win32.isAbsolute(systemRoot) || typeof execute !== 'function') return null;
            const executable = path.win32.resolve(systemRoot, 'System32', 'whoami.exe');
            if (!executable.toLocaleLowerCase('en-US').startsWith(
                path.win32.resolve(systemRoot).toLocaleLowerCase('en-US') + path.win32.sep.toLocaleLowerCase('en-US')))
                return null;
            try {
                const result = await execute(executable, ['/user', '/fo', 'csv', '/nh'], {
                    windowsHide: true, shell: false, timeout: 1500, maxBuffer: 4096, encoding: 'utf8',
                });
                const match = typeof result?.stdout === 'string' ? result.stdout.match(SID) : null;
                if (!match) return null;
                return Object.freeze({ id: `windows-sid:${match[1].toUpperCase()}`,
                    kind: 'windows_account_sid', authenticationState: 'os_account_session_unverified',
                    method: 'windows_process_token' });
            } catch { return null; }
        },
    });
}
