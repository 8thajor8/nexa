import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAutomaticMemoryConsentStore } from '../src/memory/automatic/consent-store.js';
import { createAutomaticMemoryProposalQueue, AUTOMATIC_MEMORY_PROPOSAL_TTL_MS } from '../src/memory/automatic/proposal-queue.js';
import { getAutomaticMemoryLocalPath } from '../src/memory/automatic/local-json-ledger.js';
import { AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION, screenAutomaticMemoryTurn } from '../src/memory/automatic/privacy.js';
import { parseMemoryCommand } from '../src/memory/commands.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-am-c4-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return { directory, consentPath: path.join(directory, 'consent.json'), queuePath: path.join(directory, 'proposals.json') };
}
const proposal = (overrides = {}) => ({ conversationId: id(1), consentId: id(2), turnId: id(3), action: 'ADD',
    category: 'stable_preference', sensitive: false, summary: 'prefiere respuestas concisas', targetSummary: null, ...overrides });

test('C.4 data paths select per-user local application data and consent defaults are no-write', () => {
    assert.equal(getAutomaticMemoryLocalPath('consent.json', { platform: 'win32', localAppData: 'C:\\Users\\Synthetic\\AppData\\Local' }),
        'C:\\Users\\Synthetic\\AppData\\Local\\Nexa\\AutomaticMemory\\consent.json');
    assert.match(getAutomaticMemoryLocalPath('proposals.json', { platform: 'linux', home: '/tmp/synthetic' }),
        /\.local\/share\/nexa\/automatic-memory\/proposals\.json$/u);
    assert.throws(() => getAutomaticMemoryLocalPath('..\\outside.json', { platform: 'win32' }), /storage_path_invalid/u);
});

test('C.4 persistent consent requires grant, survives store recreation, and revocation persists without retaining a challenge', async t => {
    const f = await fixture(t), now = () => new Date('2026-10-08T12:00:00.000Z');
    const first = createAutomaticMemoryConsentStore({ filePath: f.consentPath, now });
    assert.equal(await first.load(), null);
    const accepted = await first.grant();
    assert.equal(accepted.policyVersion, AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION);
    assert.equal(accepted.scope, 'future_direct_user_turns_across_runtime_sessions');
    assert.equal(accepted.grantsMemoryWrite, false);
    const reopened = createAutomaticMemoryConsentStore({ filePath: f.consentPath, now });
    const restored = await reopened.load();
    const { excludedConversations, ...restoredConsent } = restored;
    assert.deepEqual(restoredConsent, accepted);
    assert.deepEqual(excludedConversations, []);
    const bytes = await fs.readFile(f.consentPath, 'utf8');
    assert.doesNotMatch(bytes, /challenge|token|password|turn text/iu);
    await reopened.revoke();
    assert.equal(await createAutomaticMemoryConsentStore({ filePath: f.consentPath, now }).load(), null);
    assert.equal(JSON.parse(await fs.readFile(f.consentPath, 'utf8')).status, 'revoked');
});

test('C.4 conversation exclusions persist with consent and can filter queue entries if queue cleanup fails', async t => {
    const f = await fixture(t), store = createAutomaticMemoryConsentStore({ filePath: f.consentPath });
    const consent = await store.grant();
    assert.deepEqual(await store.excludeConversation(id(1)), { success: true });
    const reopened = await createAutomaticMemoryConsentStore({ filePath: f.consentPath }).load();
    assert.deepEqual(reopened.excludedConversations, [id(1)]);
    const queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    await queue.enqueue(proposal({ consentId: consent.consentId }));
    await queue.enqueue(proposal({ conversationId: id(4), consentId: consent.consentId,
        turnId: id(5), summary: 'prefiere trabajar por la mañana' }));
    const groups = await queue.listGrouped({ consentId: consent.consentId,
        excludedConversationIds: reopened.excludedConversations });
    assert.deepEqual(groups.flatMap(group => group.proposals).map(item => item.summary), ['prefiere trabajar por la mañana']);
});

test('C.4 persisted consent survives an agent restart but alone cannot activate analysis or saving', async t => {
    const f = await fixture(t), store = createAutomaticMemoryConsentStore({ filePath: f.consentPath });
    await store.grant();
    const code = `
import { createAgent } from './src/core/agent.js';
import { createAutomaticMemoryConsentStore } from './src/memory/automatic/consent-store.js';
const store=createAutomaticMemoryConsentStore({filePath:${JSON.stringify(f.consentPath)}});
const agent=await createAgent({memoryBackend:'memory1',load:async()=>({user:{},preferences:{},facts:[]}),automaticMemoryConsentStore:store,logger:()=>{}});
console.log('__STATE__'+JSON.stringify(agent.automaticMemoryControls)); await agent.close();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value.toString(); });
    child.stderr.on('data', value => { stderr += value.toString(); });
    const exit = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(exit, 0, stderr);
    const controls = JSON.parse(stdout.match(/__STATE__(.+)/u)[1]);
    assert.equal(controls.consentPersisted, true);
    assert.equal(controls.automaticAnalysisEnabled, false);
    assert.equal(controls.automaticSavingEnabled, false);
});

test('C.4 persisted consent only permits the configured synthetic detector on new direct stdin turns', async t => {
    const f = await fixture(t), store = createAutomaticMemoryConsentStore({ filePath: f.consentPath });
    await store.grant();
    const code = `
import { createAgent } from './src/core/agent.js';
import { createAutomaticMemoryConsentStore } from './src/memory/automatic/consent-store.js';
import { closeDirectUserInput } from './src/core/direct-user-input.js';
const detected=[]; let saves=0;
const agent=await createAgent({memoryBackend:'memory1',load:async()=>({user:{},preferences:{},facts:[]}),save:async()=>{saves++},
automaticMemoryConsentStore:createAutomaticMemoryConsentStore({filePath:${JSON.stringify(f.consentPath)}}),
enableAutomaticMemoryAssessment:true,automaticMemoryDetector:{detect:async value=>detected.push({keys:Object.keys(value).sort(),text:value.text})},
ask:async()=>({status:'completed',output_text:'Synthetic response',output:[]}),getTools:()=>[],logger:()=>{}});
const state=agent.automaticMemoryControls; const turn=await agent.readAndRun(); await agent.completePresentedTurn();
console.log('__RESULT__'+JSON.stringify({state,turn:turn.response,detected,saves})); await agent.close(); closeDirectUserInput();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value.toString(); });
    child.stderr.on('data', value => { stderr += value.toString(); });
    const exit = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
        child.stdin.write('Mi preferencia estable sintética es recibir respuestas concisas.\n');
        child.stdin.end();
    });
    assert.equal(exit, 0, stderr + stdout);
    const result = JSON.parse(stdout.match(/__RESULT__(.+)/u)[1]);
    assert.equal(result.state.automaticAnalysisEnabled, true);
    assert.equal(result.detected.length, 1);
    assert.deepEqual(result.detected[0].keys, ['signal', 'text']);
    assert.equal(result.detected[0].text, 'Mi preferencia estable sintética es recibir respuestas concisas.');
    assert.equal(result.saves, 0);
});

test('C.4 a revocation from another local session is rechecked before assessment', async t => {
    const f = await fixture(t), initialStore = createAutomaticMemoryConsentStore({ filePath: f.consentPath });
    await initialStore.grant();
    const code = `
import { createAgent } from './src/core/agent.js';
import { createAutomaticMemoryConsentStore } from './src/memory/automatic/consent-store.js';
import { closeDirectUserInput } from './src/core/direct-user-input.js';
const path=${JSON.stringify(f.consentPath)}; let detected=0;
const store=createAutomaticMemoryConsentStore({filePath:path});
const agent=await createAgent({memoryBackend:'memory1',load:async()=>({user:{},preferences:{},facts:[]}),
automaticMemoryConsentStore:store,enableAutomaticMemoryAssessment:true,
automaticMemoryDetector:{detect:async()=>{detected++}},
ask:async()=>({status:'completed',output_text:'Synthetic response',output:[]}),getTools:()=>[],logger:()=>{}});
await createAutomaticMemoryConsentStore({filePath:path}).revoke();
const turn=await agent.readAndRun(); await agent.completePresentedTurn();
console.log('__RESULT__'+JSON.stringify({turn:turn.response,detected,controls:agent.automaticMemoryControls}));
await agent.close(); closeDirectUserInput();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value.toString(); });
    child.stderr.on('data', value => { stderr += value.toString(); });
    const exit = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`revocation worker timed out: ${stderr}${stdout}`)); }, 8000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(stderr + stdout)); });
        child.stdin.end('Synthetic direct assertion for local revocation check.\n');
    });
    assert.equal(exit, undefined);
    const result = JSON.parse(stdout.match(/__RESULT__(.+)/u)[1]);
    assert.equal(result.detected, 0);
    assert.equal(result.controls.automaticAnalysisEnabled, false);
});

test('C.4 a direct-user message opt-out skips only that turn before synthetic assessment', async t => {
    assert.equal(screenAutomaticMemoryTurn('Nexa, no aprendas de este mensaje: Mi preferencia estable es respuestas concisas.').reason,
        'excluded_user_requested_message_exclusion');
    const f = await fixture(t), store = createAutomaticMemoryConsentStore({ filePath: f.consentPath });
    await store.grant();
    const code = `
import { createAgent } from './src/core/agent.js';
import { createAutomaticMemoryConsentStore } from './src/memory/automatic/consent-store.js';
import { closeDirectUserInput } from './src/core/direct-user-input.js';
const detected=[];
const agent=await createAgent({memoryBackend:'memory1',load:async()=>({user:{},preferences:{},facts:[]}),
automaticMemoryConsentStore:createAutomaticMemoryConsentStore({filePath:${JSON.stringify(f.consentPath)}}),
enableAutomaticMemoryAssessment:true,automaticMemoryDetector:{detect:async value=>{detected.push(value.text)}},
ask:async()=>({status:'completed',output_text:'Synthetic response',output:[]}),getTools:()=>[],logger:()=>{}});
const first=await agent.readAndRun(); await agent.completePresentedTurn();
const second=await agent.readAndRun(); await agent.completePresentedTurn();
console.log('__RESULT__'+JSON.stringify({first:first.response,second:second.response,detected}));
await agent.close(); closeDirectUserInput();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value.toString(); });
    child.stderr.on('data', value => { stderr += value.toString(); });
    const exit = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`message opt-out worker timed out: ${stderr}${stdout}`)); }, 8000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(stderr + stdout)); });
        child.stdin.end('Nexa, no aprendas de este mensaje: Mi preferencia estable es respuestas concisas.\nMi preferencia estable es respuestas concisas.\n');
    });
    assert.equal(exit, undefined);
    const result = JSON.parse(stdout.match(/__RESULT__(.+)/u)[1]);
    assert.match(result.first, /Synthetic response/u);
    assert.match(result.second, /Synthetic response/u);
    assert.deepEqual(result.detected, ['Mi preferencia estable es respuestas concisas.']);
});

test('C.4 unsupported consent policy versions fail closed and corrupt consent is never treated as active', async t => {
    const f = await fixture(t), store = createAutomaticMemoryConsentStore({ filePath: f.consentPath });
    await store.grant();
    const stale = JSON.parse(await fs.readFile(f.consentPath, 'utf8'));
    stale.consent.policyVersion = 'future-unknown';
    await fs.writeFile(f.consentPath, JSON.stringify(stale));
    assert.equal(await store.load(), null);
    await fs.writeFile(f.consentPath, '{ broken');
    await assert.rejects(store.load(), /automatic_memory_storage_corrupt/u);
    await store.revoke();
    assert.equal(await store.load(), null);
});

test('C.4 queue groups review, deduplicates pending proposals, and individual approval remains non-executable', async t => {
    const f = await fixture(t), queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    const first = await queue.enqueue(proposal());
    const duplicate = await queue.enqueue(proposal());
    assert.equal(first.status, 'pending');
    assert.deepEqual(duplicate, { status: 'duplicate', proposalId: first.proposalId });
    const sensitive = await queue.enqueue(proposal({ turnId: id(4), action: 'REPLACE', category: 'health_sensitive',
        sensitive: true, summary: 'tratamiento de salud por revisar', targetSummary: 'dato anterior de salud' }));
    assert.equal(sensitive.status, 'pending');
    const groups = await queue.listGrouped();
    assert.equal(groups.length, 2);
    assert.equal(groups.find(group => group.sensitive).proposals.length, 1);
    assert.equal((await queue.review(sensitive.proposalId)).sensitive, true);
    assert.deepEqual(await queue.approve(sensitive.proposalId, 'f'.repeat(64)), { success: false, code: 'proposal_stale_or_missing' });
    const item = await queue.review(sensitive.proposalId);
    const result = await queue.approve(sensitive.proposalId, item.fingerprint);
    assert.deepEqual(result, { success: true, status: 'approved', proposalId: sensitive.proposalId });
    assert.deepEqual(await queue.enqueue(proposal({ turnId: id(10), action: 'REPLACE', category: 'health_sensitive',
        sensitive: true, summary: 'tratamiento de salud por revisar', targetSummary: 'dato anterior de salud' })),
    { status: 'duplicate', proposalId: sensitive.proposalId });
    assert.equal((await queue.review(sensitive.proposalId)), null);
    const disk = JSON.parse(await fs.readFile(f.queuePath, 'utf8'));
    assert.equal(disk.items.find(entry => entry.proposalId === sensitive.proposalId).status, 'approved');
    assert.equal(disk.items.find(entry => entry.proposalId === sensitive.proposalId).summary, 'tratamiento de salud por revisar');
    assert.equal(disk.items.some(entry => 'assertion' in entry || 'writeReady' in entry || 'authorization' in entry), false);
});

test('C.4 proposals expire after seven days on access and sensitive/rejected content is scrubbed', async t => {
    const f = await fixture(t); let current = new Date('2026-10-01T00:00:00.000Z');
    const queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath, now: () => new Date(current) });
    const added = await queue.enqueue(proposal({ category: 'finance_sensitive', sensitive: true,
        summary: 'deuda personal para revisar' }));
    assert.equal(Date.parse((await queue.review(added.proposalId)).expiresAt) - current.getTime(), AUTOMATIC_MEMORY_PROPOSAL_TTL_MS);
    const item = await queue.review(added.proposalId);
    assert.deepEqual(await queue.reject(item.proposalId, item.fingerprint), { success: true, status: 'rejected' });
    const rejected = JSON.parse(await fs.readFile(f.queuePath, 'utf8')).items[0];
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.summary, null);

    const pending = await queue.enqueue(proposal({ turnId: id(5), summary: 'prefiere música instrumental' }));
    current = new Date(current.getTime() + AUTOMATIC_MEMORY_PROPOSAL_TTL_MS + 1);
    assert.deepEqual(await queue.listGrouped(), []);
    const expired = JSON.parse(await fs.readFile(f.queuePath, 'utf8')).items.find(entry => entry.proposalId === pending.proposalId);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.summary, null);
});

test('C.4 prohibited secrets, identifiers, extra fields, and full-turn-sized content are rejected', async t => {
    const f = await fixture(t), queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    for (const summary of ['password: synthetic-secret', 'owner@example.invalid', 'DNI 12345678X', '\u001b[2Jsynthetic terminal control', '1 '.repeat(100)])
        await assert.rejects(queue.enqueue(proposal({ summary })), /automatic_memory_queue_content_rejected/u);
    await assert.rejects(queue.enqueue({ ...proposal(), originalText: 'never persist source text' }), /proposal_invalid/u);
    await assert.rejects(queue.enqueue(proposal({ category: 'health_sensitive', sensitive: false })), /proposal_invalid/u);
    assert.equal(await fs.access(f.queuePath).then(() => true, () => false), false);
});

test('C.4 a forged future expiry is rejected without rewriting the proposal file', async t => {
    const f = await fixture(t), queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    await queue.enqueue(proposal());
    const corrupted = JSON.parse(await fs.readFile(f.queuePath, 'utf8'));
    corrupted.items[0].expiresAt = '2099-01-01T00:00:00.000Z';
    await fs.writeFile(f.queuePath, JSON.stringify(corrupted));
    const before = await fs.readFile(f.queuePath, 'utf8');
    await assert.rejects(queue.listGrouped(), /automatic_memory_queue_corrupt/u);
    assert.equal(await fs.readFile(f.queuePath, 'utf8'), before);
});

test('C.4 excluding one conversation or revoking its consent invalidates pending and late proposals only in that scope', async t => {
    const f = await fixture(t), queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    const current = await queue.enqueue(proposal());
    await queue.excludeConversation(id(1));
    assert.deepEqual(await queue.enqueue(proposal({ turnId: id(6), summary: 'otro candidato tardío' })),
        { status: 'discarded', reason: 'scope_invalidated' });
    assert.equal(await queue.review(current.proposalId), null);
    const other = await queue.enqueue(proposal({ conversationId: id(7), turnId: id(7), summary: 'proyecto de otra conversación' }));
    assert.equal(other.status, 'pending');
    await queue.revokeConsent(id(2));
    assert.deepEqual(await queue.enqueue(proposal({ conversationId: id(7), turnId: id(8) })),
        { status: 'discarded', reason: 'scope_invalidated' });
    assert.equal(await queue.review(other.proposalId), null);

    const approved = await queue.enqueue(proposal({ conversationId: id(9), consentId: id(10), turnId: id(11),
        summary: 'prefiere caminar al mediodía' }));
    const approvedItem = await queue.review(approved.proposalId);
    await queue.approve(approved.proposalId, approvedItem.fingerprint);
    await queue.revokeConsent(id(10));
    assert.equal(await queue.review(approved.proposalId), null);
});

test('C.4 two queue instances serialize concurrent updates and corrupted files fail closed', async t => {
    const f = await fixture(t);
    const left = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    const right = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    const results = await Promise.all([
        left.enqueue(proposal({ summary: 'prefiere café por la mañana' })),
        right.enqueue(proposal({ turnId: id(9), summary: 'prefiere infusiones por la tarde' })),
    ]);
    assert.equal(results.filter(result => result.status === 'pending').length, 2);
    assert.equal((await left.listGrouped()).reduce((sum, group) => sum + group.proposals.length, 0), 2);
    await fs.writeFile(f.queuePath, '{corrupt');
    await assert.rejects(right.listGrouped(), /automatic_memory_storage_corrupt/u);
    assert.equal(await fs.readFile(f.queuePath, 'utf8'), '{corrupt');
});

test('C.4 separate Node processes serialize updates through the cooperative file lock', async t => {
    const f = await fixture(t);
    const entries = [
        { conversationId: id(21), consentId: id(22), turnId: id(23), summary: 'prefiere leer por la mañana' },
        { conversationId: id(24), consentId: id(25), turnId: id(26), summary: 'prefiere paseos tranquilos' },
    ];
    const results = await Promise.all(entries.map(entry => new Promise((resolve, reject) => {
        const input = proposal(entry);
        const code = `import { createAutomaticMemoryProposalQueue } from './src/memory/automatic/proposal-queue.js'; const q=createAutomaticMemoryProposalQueue({filePath:${JSON.stringify(f.queuePath)}}); console.log(JSON.stringify(await q.enqueue(${JSON.stringify(input)})));`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', value => { stdout += value.toString(); });
        child.stderr.on('data', value => { stderr += value.toString(); });
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`queue child timed out: ${stderr}${stdout}`)); }, 8000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => {
            clearTimeout(timeout);
            if (code !== 0) reject(new Error(stderr + stdout));
            else { try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); } }
        });
    })));
    assert.equal(results.filter(result => result.status === 'pending').length, 2);
    const queue = createAutomaticMemoryProposalQueue({ filePath: f.queuePath });
    assert.equal((await queue.listGrouped()).reduce((total, group) => total + group.proposals.length, 0), 2);
});

test('C.4 local commands are parsed only as direct terminal inputs, with one-by-one proposal confirmation', async () => {
    assert.equal(parseMemoryCommand('Nexa, no recuerdes esta conversación').operation, 'automatic_memory_exclude_conversation');
    assert.equal(parseMemoryCommand('/automatic-memory proposals').operation, 'automatic_memory_proposals_list');
    assert.equal(parseMemoryCommand('/automatic-memory review prop_00000000-0000-4000-8000-000000000001').operation,
        'automatic_memory_proposal_review');
    assert.equal(parseMemoryCommand('/automatic-memory confirm-proposal prop_00000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000002').operation,
        'automatic_memory_proposal_confirm');
});

test('C.4 sensitive proposals require a separate exact stdin confirmation and approval does not write', async () => {
    const valid = await spawnWorker('proposal');
    assert.match(valid.stdout, /Es sensible y exige esta confirmación individual/u);
    assert.match(valid.stdout, /Aceptar no escribe ni autoriza una escritura/u);
    assert.match(valid.stdout, /Propuesta aprobada individualmente/u);
    assert.match(valid.stdout, /proposal-approved:/u);
    assert.match(valid.stdout, /"saved":0/u);
    const wrong = await spawnWorker('proposal', 'wrong');
    assert.doesNotMatch(wrong.stdout, /proposal-approved:/u);
    assert.match(wrong.stdout, /no se escribió ningún recuerdo/u);
});

async function spawnWorker(mode, confirm = '') {
    const code = `
import { createAgent } from './src/core/agent.js';
import { closeDirectUserInput } from './src/core/direct-user-input.js';
const events=[]; let saved=0;
const policyVersion=${JSON.stringify(AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION)};
const storedConsent={consentId:'00000000-0000-4000-8000-000000000002',grantedAt:new Date().toISOString(),policyVersion,purpose:'assess_future_direct_user_turns_for_possible_memory_candidates',scope:'future_direct_user_turns_across_runtime_sessions',grantsMemoryWrite:false};
const store={load:async()=>storedConsent,grant:async()=>storedConsent,revoke:async()=>({success:true})};
const item={proposalId:'prop_00000000-0000-4000-8000-000000000002',conversationId:'00000000-0000-4000-8000-000000000001',consentId:'00000000-0000-4000-8000-000000000002',fingerprint:'a'.repeat(64),action:'ADD',category:'health_sensitive',sensitive:true,summary:'Seguimiento de salud personal',targetSummary:null};
const queue={listGrouped:async()=>[],review:async id=>id===item.proposalId?item:null,approve:async(id,fp)=>{events.push('proposal-approved:'+id+':'+fp);return {success:id===item.proposalId&&fp===item.fingerprint}},reject:async()=>({success:false}),discard:async()=>({success:false}),excludeConversation:async()=>({success:true}),revokeConsent:async()=>({success:true})};
const agent=await createAgent({memoryBackend:'memory1',load:async()=>({user:{},preferences:{},facts:[]}),save:async()=>{saved++},ask:async()=>({status:'completed',output_text:'Synthetic reply',output:[]}),getTools:()=>[],automaticMemoryConsentStore:store,automaticMemoryProposalQueue:queue,logger:()=>{}});
const review=await agent.readAndRun(); console.log('__PREVIEW__'+review.response);
const confirm=await agent.readAndRun(); console.log('__CONFIRM__'+confirm.response);
console.log('__RESULT__'+JSON.stringify({events,saved,controls:agent.automaticMemoryControls})); await agent.close(); closeDirectUserInput();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`synthetic queue worker timed out: ${stderr}${stdout}`)); }, 8000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(stderr + stdout)); });
        child.stdin.write('/automatic-memory review prop_00000000-0000-4000-8000-000000000002\n');
        const spin = setInterval(() => {
            const match = /confirm-proposal (prop_00000000-0000-4000-8000-000000000002) ([0-9a-f-]{36})/u.exec(stdout);
            if (!match) return;
            clearInterval(spin);
            const value = confirm === 'wrong' ? id(99) : match[2];
            child.stdin.write(`/automatic-memory confirm-proposal ${match[1]} ${value}\n`);
            child.stdin.end();
        }, 10);
    });
    return { stdout, stderr };
}
