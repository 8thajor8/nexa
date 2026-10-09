import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nativeFs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    createExperimentalIdentityDirectory,
    evaluateIdentityDirectoryAcl,
    isWindowsReparsePoint,
} from '../src/core/experimental/secure-identity-directory.js';

const windows = process.platform === 'win32';
const sid = 'S-1-5-21-111111111-222222222-333333333-1001';

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nexa-m1e3-'));
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    return root;
}

function runIcacls(targetPath, args) {
    const executable = path.win32.join(process.env.SystemRoot, 'System32', 'icacls.exe');
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [targetPath, ...args], {
            shell: false,
            windowsHide: true,
            env: { SystemRoot: process.env.SystemRoot, windir: process.env.windir ?? process.env.SystemRoot,
                PATH: process.env.PATH ?? process.env.Path ?? '', PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
                TEMP: process.env.TEMP ?? os.tmpdir(), TMP: process.env.TMP ?? os.tmpdir() },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let errorOutput = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-1_024); });
        const timer = setTimeout(() => { child.kill(); reject(new Error('fixture_acl_timeout')); }, 8_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`fixture_icacls_exit_${code}${errorOutput ? `:${errorOutput.trim()}` : ''}`));
        });
    });
}

function currentUserSid() {
    const executable = path.win32.join(process.env.SystemRoot, 'System32', 'whoami.exe');
    const result = spawnSync(executable, ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8', shell: false, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, windir: process.env.windir ?? process.env.SystemRoot,
            PATH: process.env.PATH ?? process.env.Path ?? '', PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD' },
    });
    if (result.status !== 0) throw new Error('fixture_current_sid_unavailable');
    const match = result.stdout.match(/,"(S-1-[0-9-]+)"\s*$/mu);
    if (!match) throw new Error('fixture_current_sid_invalid');
    return match[1];
}

async function addEveryoneRule(targetPath, rights, access = 'Allow', inherited = false) {
    const rightsMap = { ReadAndExecute: 'RX', FullControl: 'F' };
    const mapped = rightsMap[rights];
    if (!mapped || !['Allow', 'Deny'].includes(access)) throw new Error('fixture_acl_input_invalid');
    const inheritance = inherited ? '(OI)(CI)' : '';
    await runIcacls(targetPath, [access === 'Allow' ? '/grant' : '/deny', `*S-1-1-0:${inheritance}${mapped}`]);
}

async function addCurrentUserDeny(targetPath, rights) {
    const rightsMap = { ReadData: 'RD', CreateFiles: 'WD' };
    const mapped = rightsMap[rights];
    if (!mapped) throw new Error('fixture_acl_input_invalid');
    await runIcacls(targetPath, ['/deny', `*${currentUserSid()}:(${mapped})`]);
}

test('ACL contract is evaluated from trustee, rights, inheritance, owner and allow/deny fields', () => {
    const validDirectory = { userSid: sid, ownerSid: sid, daclProtected: true, rules: [
        { sid, access: 'Allow', rights: 2032127, inheritance: 3, propagation: 0, inherited: false },
    ] };
    assert.equal(evaluateIdentityDirectoryAcl(validDirectory), true);
    assert.equal(evaluateIdentityDirectoryAcl({ ...validDirectory, ownerSid: 'S-1-5-18' }), false);
    assert.equal(evaluateIdentityDirectoryAcl({ ...validDirectory, daclProtected: false }), false);
    for (const untrustedSid of ['S-1-1-0', 'S-1-5-32-545', 'S-1-5-18', 'S-1-5-32-544']) {
        assert.equal(evaluateIdentityDirectoryAcl({ ...validDirectory, rules: [...validDirectory.rules,
            { sid: untrustedSid, access: 'Allow', rights: 1, inheritance: 0, propagation: 0, inherited: false }] }), false);
    }
    assert.equal(evaluateIdentityDirectoryAcl({ ...validDirectory, rules: [{ ...validDirectory.rules[0], access: 'Deny' }] }), false);
    assert.equal(evaluateIdentityDirectoryAcl({ ...validDirectory, rules: [{ ...validDirectory.rules[0], rights: 1 }] }), false);
    assert.equal(evaluateIdentityDirectoryAcl({ ...validDirectory, rules: [{ ...validDirectory.rules[0], inherited: true }] }), false);
    assert.equal(evaluateIdentityDirectoryAcl({ userSid: sid, ownerSid: sid, rules: [
        { sid, access: 'Allow', rights: 2032127, inheritance: 3, propagation: 0, inherited: true },
    ] }, { kind: 'file' }), true);
});

test('reparse detection includes Windows FILE_ATTRIBUTE_REPARSE_POINT even for an unknown tag', () => {
    assert.equal(isWindowsReparsePoint({ attributes: 0x400, isSymbolicLink: () => false }), true);
    assert.equal(isWindowsReparsePoint({ attributes: 0, isSymbolicLink: () => true }), true);
    assert.equal(isWindowsReparsePoint({ attributes: 0, isSymbolicLink: () => false }), false);
});

test('creates a private temporary directory, verifies its effective current-user access, and cleans it', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const directory = await createExperimentalIdentityDirectory({ testRoot: root });
    assert.equal(directory.status, 'experimental_non_production');
    const result = await directory.verify();
    assert.equal(result.status, 'accepted');
    assert.equal(result.code, 'acl_policy_verified_for_current_user');
    assert.equal(result.executable, false);
    assert.equal(result.authorization, 'DENY');
    assert.equal(result.persistencePerformed, false);
    const cleaned = await directory.cleanup();
    assert.equal(cleaned.status, 'cleaned');
    assert.equal(cleaned.executable, false);
    await assert.rejects(readdir(path.join(root, 'Identity')), { code: 'ENOENT' });
});

test('a broad inherited ACE on the temporary parent is removed by the protected child DACL', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    await addEveryoneRule(root, 'ReadAndExecute', 'Allow', true);
    const directory = await createExperimentalIdentityDirectory({ testRoot: root });
    assert.equal((await directory.verify()).status, 'accepted');
    assert.equal((await directory.cleanup()).status, 'cleaned');
});

test('unexpected Everyone read/write grants are rejected after inspecting real ACEs', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    for (const rights of ['ReadAndExecute', 'FullControl']) {
        const root = await fixture(t);
        const directory = await createExperimentalIdentityDirectory({ testRoot: root });
        await addEveryoneRule(path.join(root, 'Identity'), rights);
        const result = await directory.verify();
        assert.equal(result.status, 'rejected');
        assert.equal(result.code, 'acl_policy_mismatch');
        assert.equal(result.executable, false);
        assert.equal((await directory.cleanup()).status, 'cleaned');
        await rm(root, { recursive: true, force: true });
    }
});

test('unexpected explicit deny ACE is rejected rather than hidden by the broad allow', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const directory = await createExperimentalIdentityDirectory({ testRoot: root });
    await addCurrentUserDeny(path.join(root, 'Identity'), 'ReadData');
    const result = await directory.verify();
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'acl_policy_mismatch');
    assert.equal((await directory.cleanup()).status, 'cleaned');
});

test('actual current-process access probes fail closed when effective directory write is denied', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const fixtureAclProvider = {
        async apply() {},
        async inspect(targetPath) {
            const isFile = targetPath.includes('.m1e3-probe-');
            return { userSid: sid, ownerSid: sid, daclProtected: !isFile, rules: [
                { sid, access: 'Allow', rights: 2032127, inheritance: 3, propagation: 0, inherited: isFile },
            ] };
        },
    };
    const directory = await createExperimentalIdentityDirectory({ testRoot: root, aclProvider: fixtureAclProvider });
    await addCurrentUserDeny(path.join(root, 'Identity'), 'CreateFiles');
    const result = await directory.verify();
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'effective_access_probe_failed');
    assert.equal((await directory.cleanup()).status, 'cleaned');
});

test('wrong owner and ACL-provider failures are rejected and owned empty fixtures are cleaned', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const wrongOwner = await createExperimentalIdentityDirectory({ testRoot: root,
        aclProvider: { async apply() {}, async inspect() { return { userSid: sid, ownerSid: 'S-1-5-18',
            daclProtected: true, rules: [{ sid, access: 'Allow', rights: 2032127, inheritance: 3,
                propagation: 0, inherited: false }] }; } } }).catch(error => error);
    assert.match(wrongOwner.code, /acl_policy_mismatch/u);
    await assert.rejects(readdir(path.join(root, 'Identity')), { code: 'ENOENT' });

    const failed = await createExperimentalIdentityDirectory({ testRoot: root,
        aclProvider: { async apply() { throw new Error('synthetic apply fault'); }, async inspect() { return {}; } } })
        .catch(error => error);
    assert.equal(failed.code, 'directory_setup_failed');
    await assert.rejects(readdir(path.join(root, 'Identity')), { code: 'ENOENT' });
});

test('probe cleanup failures remain fail-closed and report the possible residue without hiding the original failure', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    let failWrite = false;
    let failUnlink = false;
    let probePath;
    const fileSystem = new Proxy(nativeFs, { get(target, property) {
        if (property === 'open') return async (...args) => {
            probePath = args[0];
            const handle = await nativeFs.open(...args);
            return {
                stat: (...inner) => handle.stat(...inner),
                writeFile: (...inner) => failWrite
                    ? Promise.reject(Object.assign(new Error('synthetic probe write failure'), { code: 'EIO' }))
                    : handle.writeFile(...inner),
                sync: (...inner) => handle.sync(...inner),
                close: (...inner) => handle.close(...inner),
            };
        };
        if (property === 'unlink') return async targetPath => {
            if (failUnlink) throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
            return nativeFs.unlink(targetPath);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const fixtureAclProvider = {
        async apply() {},
        async inspect(targetPath) {
            const isFile = targetPath.includes('.m1e3-probe-');
            return { userSid: sid, ownerSid: sid, daclProtected: !isFile, rules: [
                { sid, access: 'Allow', rights: 2032127, inheritance: 3, propagation: 0, inherited: isFile },
            ] };
        },
    };
    const directory = await createExperimentalIdentityDirectory({ testRoot: root, fileSystem, aclProvider: fixtureAclProvider });
    failWrite = true;
    failUnlink = true;
    const result = await directory.verify();
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'effective_access_probe_failed');
    assert.equal(result.cleanupCode, 'EACCES');
    assert.equal(result.residueMayRemain, true);
    assert.equal(await nativeFs.readFile(probePath, 'utf8').then(() => true), true);
    failWrite = false;
    failUnlink = false;
    await nativeFs.unlink(probePath);
    assert.equal((await directory.cleanup()).status, 'cleaned');
});

test('a route substitution between validation and ACL application is detected without following the junction', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const victim = path.join(root, 'victim');
    await mkdir(victim);
    const sentinel = path.join(victim, 'sentinel.txt');
    await writeFile(sentinel, 'synthetic-victim');
    let junctionCreated = false;
    const outcome = await createExperimentalIdentityDirectory({ testRoot: root, afterPathValidation: async target => {
        await rmdir(target);
        try { await symlink(victim, target, 'junction'); junctionCreated = true; }
        catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) return t.skip('junction creation unavailable in this test environment');
            throw error;
        }
    } }).catch(error => error);
    assert.equal(outcome.code, 'directory_not_regular');
    assert.equal(await readFile(sentinel, 'utf8'), 'synthetic-victim');
    assert.equal(junctionCreated, true);
    await rmdir(path.join(root, 'Identity'));
});

test('a fixture-root substitution is detected before applying the ACL or following the new route', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const movedRoot = `${root}.moved`;
    const victim = path.join(path.dirname(root), `nexa-m1e3-victim-${randomUUID()}`);
    await mkdir(victim);
    const sentinel = path.join(victim, 'sentinel.txt');
    await writeFile(sentinel, 'synthetic-victim');
    const outcome = await createExperimentalIdentityDirectory({ testRoot: root,
        afterPathValidation: async () => {
            await rename(root, movedRoot);
            await symlink(victim, root, 'junction');
        } }).catch(error => error);
    assert.equal(outcome.code, 'directory_not_regular');
    assert.equal(await readFile(sentinel, 'utf8'), 'synthetic-victim');
    await rmdir(root);
    await rmdir(path.join(movedRoot, 'Identity'));
    await rmdir(movedRoot);
    await rm(victim, { recursive: true, force: true });
});

test('symbolic-link and junction fixture roots are rejected before creating a child', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const target = path.join(root, 'real-target');
    await mkdir(target);
    for (const type of ['dir', 'junction']) await t.test(type, async subtest => {
        const linkPath = path.join(path.dirname(root), `nexa-m1e3-link-${randomUUID()}`);
        try { await symlink(target, linkPath, type); }
        catch (error) {
            if (['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code))
                return subtest.skip(`Windows did not permit creation of a synthetic ${type} link in this environment`);
            throw error;
        }
        subtest.after(async () => { await rmdir(linkPath).catch(() => {}); });
        await assert.rejects(createExperimentalIdentityDirectory({ testRoot: linkPath }),
            { code: 'directory_not_regular' });
        assert.deepEqual(await readdir(target), []);
    });
});

test('missing roots, existing files, and roots outside temp are rejected', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    await assert.rejects(createExperimentalIdentityDirectory({
        testRoot: path.join(os.tmpdir(), `nexa-m1e3-missing-${Date.now()}`),
    }), { code: 'directory_unavailable' });
    await writeFile(path.join(root, 'Identity'), 'synthetic-not-directory');
    await assert.rejects(createExperimentalIdentityDirectory({ testRoot: root }),
        error => error.code === 'directory_already_exists');
    await assert.rejects(createExperimentalIdentityDirectory({ testRoot: path.dirname(root) }),
        { code: 'fixture_root_outside_temp' });
});

test('cleanup refuses to remove a directory whose identity changed or which contains unexpected files', async t => {
    if (!windows) return t.skip('Windows ACL APIs are unavailable on this platform');
    const root = await fixture(t);
    const directory = await createExperimentalIdentityDirectory({ testRoot: root });
    const residue = path.join(root, 'Identity', 'unexpected.txt');
    await writeFile(residue, 'synthetic-residue');
    const result = await directory.cleanup();
    assert.equal(result.status, 'residue');
    assert.equal(result.executable, false);
    assert.equal(await readFile(residue, 'utf8'), 'synthetic-residue');
});

test('production runtime and tools do not import the experimental ACL prototype', async () => {
    const { readFile: readSource } = await import('node:fs/promises');
    for (const file of ['../src/index.js', '../src/core/agent.js', '../src/tools/index.js']) {
        const source = await readSource(new URL(file, import.meta.url), 'utf8');
        assert.equal(source.includes('secure-identity-directory'), false, file);
    }
});
