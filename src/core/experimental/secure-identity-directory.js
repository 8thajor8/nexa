import nativeFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const REPARSE_POINT = 0x400;
const FULL_CONTROL = 2032127;
const DIRECTORY_INHERITANCE = 3;
const WINDOWS_SCRIPT_TIMEOUT_MS = 8_000;

const APPLY_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:NEXA_M1E3_PATH
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$acl.SetOwner($user)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $user,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
     [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
'{"applied":true}'
`;

const INSPECT_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:NEXA_M1E3_PATH
$acl = Get-Acl -LiteralPath $p
$sidType = [System.Security.Principal.SecurityIdentifier]
$ownerSid = $acl.GetOwner($sidType).Value
$rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
    [ordered]@{
        sid = $_.IdentityReference.Value
        access = $_.AccessControlType.ToString()
        rights = [int]$_.FileSystemRights
        inheritance = [int]$_.InheritanceFlags
        propagation = [int]$_.PropagationFlags
        inherited = [bool]$_.IsInherited
    }
})
[ordered]@{
    ownerSid = $ownerSid
    userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    daclProtected = [bool]$acl.AreAccessRulesProtected
    rules = $rules
} | ConvertTo-Json -Depth 6 -Compress
`;

export class SecureIdentityDirectoryError extends Error {
    constructor(code, { cause } = {}) {
        super(`Experimental identity directory operation failed (${code}).`, cause === undefined ? undefined : { cause });
        this.name = 'SecureIdentityDirectoryError';
        this.code = code;
    }
}

export function isWindowsReparsePoint(stat) {
    return Boolean(stat?.isSymbolicLink?.() || (Number(stat?.attributes ?? 0) & REPARSE_POINT) !== 0);
}

/**
 * Evaluate a parsed Windows ACL observation, not its SDDL rendering. The exact
 * policy is deliberately narrow: one explicit FullControl allow for the
 * installation user's SID, with no other ACEs. Access is also exercised by
 * filesystem probes before the caller treats the directory as usable.
 */
export function evaluateIdentityDirectoryAcl(observation, { kind = 'directory' } = {}) {
    if (!observation || typeof observation !== 'object' || typeof observation.userSid !== 'string'
        || typeof observation.ownerSid !== 'string' || !Array.isArray(observation.rules)
        || (kind !== 'directory' && kind !== 'file')) return false;
    if (observation.ownerSid !== observation.userSid || observation.rules.length !== 1) return false;
    if (kind === 'directory' && observation.daclProtected !== true) return false;
    const [rule] = observation.rules;
    if (!rule || rule.sid !== observation.userSid || rule.access !== 'Allow'
        || rule.rights !== FULL_CONTROL || rule.propagation !== 0) return false;
    if (kind === 'directory') return rule.inherited === false && rule.inheritance === DIRECTORY_INHERITANCE;
    return rule.inherited === true;
}

function pathWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function fileIdentity(stat) {
    const id = stat?.ino === undefined ? '' : String(stat.ino);
    // On Windows Node may report different `dev` values for handle.stat() and
    // path-based lstat(); the NTFS file index is the stable identity available
    // through these APIs, as used by the existing synthetic identity store.
    return id && id !== '0' ? id : null;
}

async function checkedDirectory(fs, target, expectedIdentity) {
    let info;
    try { info = await fs.lstat(target); }
    catch (cause) { throw new SecureIdentityDirectoryError('directory_unavailable', { cause }); }
    if (!info.isDirectory() || isWindowsReparsePoint(info))
        throw new SecureIdentityDirectoryError('directory_not_regular');
    if (expectedIdentity && fileIdentity(info) !== expectedIdentity)
        throw new SecureIdentityDirectoryError('directory_identity_changed');
    let resolved;
    try { resolved = await fs.realpath(target); }
    catch (cause) { throw new SecureIdentityDirectoryError('directory_unavailable', { cause }); }
    if (path.resolve(resolved) !== path.resolve(target))
        throw new SecureIdentityDirectoryError('directory_redirected');
    return { info, identity: fileIdentity(info) };
}

async function checkedFile(fs, target, expectedIdentity) {
    let info;
    try { info = await fs.lstat(target); }
    catch (cause) { throw new SecureIdentityDirectoryError('probe_unavailable', { cause }); }
    if (!info.isFile() || isWindowsReparsePoint(info))
        throw new SecureIdentityDirectoryError('probe_not_regular');
    if (expectedIdentity && fileIdentity(info) !== expectedIdentity)
        throw new SecureIdentityDirectoryError('probe_identity_changed');
    return info;
}

function powershellPath() {
    if (process.platform !== 'win32') throw new SecureIdentityDirectoryError('windows_only');
    const systemRoot = process.env.SystemRoot;
    if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot))
        throw new SecureIdentityDirectoryError('windows_runtime_unavailable');
    return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function runPowerShell(script, targetPath) {
    const executable = powershellPath();
    return new Promise((resolve, reject) => {
        const systemRoot = process.env.SystemRoot;
        const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
            shell: false,
            windowsHide: true,
            env: {
                SystemRoot: systemRoot,
                windir: process.env.windir ?? systemRoot,
                PATH: process.env.PATH ?? process.env.Path ?? '',
                PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
                TEMP: process.env.TEMP ?? os.tmpdir(),
                TMP: process.env.TMP ?? os.tmpdir(),
                PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
                NEXA_M1E3_PATH: targetPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        let errorOutput = '';
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => {
            child.kill();
            finish(new SecureIdentityDirectoryError('acl_provider_timeout'));
        }, WINDOWS_SCRIPT_TIMEOUT_MS);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-2_048); });
        child.stdout.on('data', chunk => {
            output += chunk;
            if (output.length > 64 * 1024) {
                child.kill();
                finish(new SecureIdentityDirectoryError('acl_provider_output_invalid'));
            }
        });
        child.once('error', cause => finish(new SecureIdentityDirectoryError('acl_provider_unavailable', { cause })));
        child.once('close', code => {
            if (settled) return;
            if (code !== 0) return finish(new SecureIdentityDirectoryError('acl_operation_failed', {
                cause: new Error(`PowerShell exited with code ${code}${errorOutput ? `: ${errorOutput.trim()}` : ''}`),
            }));
            try { finish(null, JSON.parse(output.trim())); }
            catch (cause) { finish(new SecureIdentityDirectoryError('acl_provider_output_invalid', { cause })); }
        });
    });
}

const defaultAclProvider = Object.freeze({
    apply: targetPath => runPowerShell(APPLY_ACL_SCRIPT, targetPath),
    inspect: targetPath => runPowerShell(INSPECT_ACL_SCRIPT, targetPath),
});

/**
 * Experimental Windows-only ACL prototype. It can only create a child named
 * `Identity` under a caller-supplied `nexa-m1e3-*` directory inside the OS temp
 * root. It is not imported by the runtime and cannot touch the production
 * LocalAppData identity path.
 */
export async function createExperimentalIdentityDirectory({
    testRoot,
    fileSystem = nativeFs,
    aclProvider = defaultAclProvider,
    afterPathValidation,
} = {}) {
    if (process.platform !== 'win32') throw new SecureIdentityDirectoryError('windows_only');
    if (typeof testRoot !== 'string' || !path.win32.isAbsolute(testRoot)
        || !aclProvider || typeof aclProvider.apply !== 'function' || typeof aclProvider.inspect !== 'function')
        throw new SecureIdentityDirectoryError('input_invalid');

    const root = path.win32.resolve(testRoot);
    const temporaryRoot = path.win32.resolve(await fileSystem.realpath(os.tmpdir()));
    if (!pathWithin(temporaryRoot, root) || !/^nexa-m1e3-[^\\/]+$/iu.test(path.win32.basename(root)))
        throw new SecureIdentityDirectoryError('fixture_root_outside_temp');
    const rootStat = await checkedDirectory(fileSystem, root);
    const rootRealPath = await fileSystem.realpath(root);
    if (path.win32.resolve(rootRealPath) !== root || !rootStat.identity)
        throw new SecureIdentityDirectoryError('fixture_root_untrusted');

    const directoryPath = path.win32.join(root, 'Identity');
    if (!pathWithin(root, directoryPath)) throw new SecureIdentityDirectoryError('directory_path_invalid');
    const rootIdentity = rootStat.identity;
    const checkRoot = () => checkedDirectory(fileSystem, root, rootIdentity);
    await checkRoot();
    try { await fileSystem.mkdir(directoryPath); }
    catch (cause) { throw new SecureIdentityDirectoryError(cause?.code === 'EEXIST'
        ? 'directory_already_exists' : 'directory_create_failed', { cause }); }

    let directoryIdentity;
    let closed = false;
    try {
        const created = await checkedDirectory(fileSystem, directoryPath);
        directoryIdentity = created.identity;
        if (!directoryIdentity) throw new SecureIdentityDirectoryError('file_identity_unavailable');
        if (typeof afterPathValidation === 'function') await afterPathValidation(directoryPath);
        await checkRoot();
        await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
        await aclProvider.apply(directoryPath);
        await checkRoot();
        await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
        const verification = await verify();
        if (verification.status !== 'accepted') throw new SecureIdentityDirectoryError(verification.code);
    } catch (error) {
        try { await removeOwnedDirectory(); }
        catch (cleanupError) {
            if (error && typeof error === 'object') {
                error.cleanupCode = cleanupError.code ?? 'cleanup_failed';
                error.residueMayRemain = true;
            }
        }
        throw error instanceof SecureIdentityDirectoryError ? error
            : new SecureIdentityDirectoryError('directory_setup_failed', { cause: error });
    }

    async function verify() {
        if (closed) throw new SecureIdentityDirectoryError('directory_closed');
        try {
            await checkRoot();
            await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
            const observation = await aclProvider.inspect(directoryPath);
            if (!evaluateIdentityDirectoryAcl(observation, { kind: 'directory' }))
                return Object.freeze({ status: 'rejected', code: 'acl_policy_mismatch', executable: false,
                    authorization: 'DENY', persistencePerformed: false });
            await probeEffectiveAccess();
            await checkRoot();
            await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
            return Object.freeze({ status: 'accepted', code: 'acl_policy_verified_for_current_user',
                executable: false, authorization: 'DENY', persistencePerformed: false });
        } catch (error) {
            return Object.freeze({ status: 'rejected', code: error.code ?? 'acl_verification_failed',
                ...(error.cleanupCode ? { cleanupCode: error.cleanupCode } : {}),
                ...(error.residueMayRemain ? { residueMayRemain: true } : {}),
                executable: false, authorization: 'DENY', persistencePerformed: false });
        }
    }

    async function probeEffectiveAccess() {
        await checkRoot();
        await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
        const probePath = path.win32.join(directoryPath, `.m1e3-probe-${randomUUID()}`);
        const renamedPath = `${probePath}.renamed`;
        let handle;
        let probeIdentity;
        let operationError;
        const cleanupErrors = [];
        try {
            handle = await fileSystem.open(probePath, 'wx', 0o600);
            probeIdentity = fileIdentity(await handle.stat());
            if (!probeIdentity) throw new SecureIdentityDirectoryError('file_identity_unavailable');
            await handle.writeFile('synthetic-acl-probe');
            await handle.sync();
            await handle.close();
            handle = undefined;
            await checkRoot();
            await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
            await checkedFile(fileSystem, probePath, probeIdentity);
            const childObservation = await aclProvider.inspect(probePath);
            if (!evaluateIdentityDirectoryAcl(childObservation, { kind: 'file' }))
                throw new SecureIdentityDirectoryError('file_acl_policy_mismatch');
            await checkedFile(fileSystem, probePath, probeIdentity);
            const bytes = await fileSystem.readFile(probePath, 'utf8');
            if (bytes !== 'synthetic-acl-probe') throw new SecureIdentityDirectoryError('effective_access_probe_failed');
            await checkedFile(fileSystem, probePath, probeIdentity);
            await fileSystem.rename(probePath, renamedPath);
            await removeOwnedFile(renamedPath, probeIdentity);
        } catch (cause) {
            operationError = cause instanceof SecureIdentityDirectoryError ? cause
                : new SecureIdentityDirectoryError('effective_access_probe_failed', { cause });
        } finally {
            if (handle) {
                try { await handle.close(); }
                catch (error) { cleanupErrors.push(error); }
            }
            for (const candidatePath of [probePath, renamedPath]) {
                try {
                    let info;
                    try { info = await fileSystem.lstat(candidatePath); }
                    catch (error) {
                        if (error?.code === 'ENOENT') continue;
                        throw error;
                    }
                    if (!info.isFile() || isWindowsReparsePoint(info)
                        || !probeIdentity || fileIdentity(info) !== probeIdentity)
                        throw new SecureIdentityDirectoryError('probe_identity_changed');
                    await fileSystem.unlink(candidatePath);
                } catch (error) { cleanupErrors.push(error); }
            }
        }
        if (cleanupErrors.length) {
            const cleanupError = cleanupErrors[0];
            if (operationError) {
                operationError.cleanupCode = cleanupError.code ?? 'cleanup_failed';
                operationError.residueMayRemain = true;
            } else {
                operationError = new SecureIdentityDirectoryError('probe_cleanup_failed', { cause: cleanupError });
                operationError.cleanupCode = cleanupError.code ?? 'cleanup_failed';
                operationError.residueMayRemain = true;
            }
        }
        if (operationError) throw operationError;
    }

    async function removeOwnedFile(filePath, expectedIdentity) {
        if (!expectedIdentity) return;
        await checkedFile(fileSystem, filePath, expectedIdentity);
        await fileSystem.unlink(filePath);
    }

    async function removeOwnedDirectory() {
        if (!directoryIdentity) return;
        await checkRoot();
        await checkedDirectory(fileSystem, directoryPath, directoryIdentity);
        await fileSystem.rmdir(directoryPath);
        closed = true;
    }

    async function cleanup() {
        if (closed) return Object.freeze({ status: 'cleaned', executable: false, persistencePerformed: false });
        try {
            await removeOwnedDirectory();
            return Object.freeze({ status: 'cleaned', executable: false, persistencePerformed: false });
        } catch (error) {
            return Object.freeze({ status: 'residue', code: error.code ?? 'cleanup_failed',
                executable: false, persistencePerformed: false });
        }
    }

    return Object.freeze({ verify, cleanup, get status() { return 'experimental_non_production'; } });
}
