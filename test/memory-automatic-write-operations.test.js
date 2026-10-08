import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalSubject } from '../src/memory/entities.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { MemoryRepositoryError } from '../src/memory/repository.js';
import { validateMemoryRecord } from '../src/memory/schema.js';
import { screenMemorySecret } from '../src/memory/secret-screening.js';
import { planAutomaticMemoryPersistence } from '../src/memory/automatic/planner.js';
import { snapshotFingerprint } from '../src/memory/automatic/policy.js';
import { normalizeAutomaticMemoryProposal } from '../src/memory/automatic/schema.js';
import { createAutomaticMemoryPersistenceContract } from '../src/memory/automatic/persistence-contract.js';
import { assessAutomaticMemoryAuthorization } from '../src/memory/automatic/authorization-contract.js';

// This entire writer and its synthetic capabilities live in the test file.
// Production has no import path to this interface and no authorization bypass.
const testExecutionPermits = new WeakMap();
const testConfirmations = new WeakMap();
const NOW = '2036-02-03T10:20:30.000Z';
const SELF = 'person_00000000-0000-4000-8000-000000000001';
const STORE = 'store_00000000-0000-4000-8000-000000000001';

function emptyStore() {
    return { schema_version: 4, store_id: STORE, self_person_id: SELF, revision: 0,
        created_at: '2036-02-03T10:00:00.000Z', updated_at: '2036-02-03T10:00:00.000Z',
        entities: [{ id: SELF, type: 'person', created_at: '2036-02-03T10:00:00.000Z' }],
        assertions: [], sources: [], evidence: [], migrations: [] };
}
function id(prefix) { return `${prefix}_${randomUUID()}`; }
function source(idValue, kind, now) {
    const inferred = kind === 'inference';
    return { id: idValue, kind, origin_trust: inferred ? 'derived_untrusted' : 'user_asserted',
        authority: 'data_only', locator: null,
        occurred_at: { value: now, precision: 'instant' }, recorded_at: now };
}
function assertionFor(snapshot, candidate, { status = 'active', supersedes = [] } = {}) {
    return { id: id('mem'), kind: 'fact',
        subject: { type: 'entity', entity_type: 'person', id: snapshot.self_person_id },
        predicate: candidate.predicate, object: { type: 'text', value: candidate.value_text },
        status, valid_from: null, valid_to: null, recorded_at: NOW, supersedes, compatibility: null };
}
function candidate(text, overrides = {}) {
    return { candidate_type: 'purchase', subject_text: 'user', predicate: 'user.owns_item',
        value_text: 'Fender', mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.94,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'addition',
        sensitivity: 'none', suggested_disposition: 'auto_save', evidence_quote: text, ...overrides };
}
function proposalFor(text, overrides = {}) { return { candidates: [candidate(text, overrides)] }; }
function fingerprintData(prepared) {
    return JSON.stringify({ operation: prepared.operation, targetAssertionId: prepared.targetAssertionId,
        candidate: prepared.candidate, textSha256: prepared.textSha256,
        revision: prepared.snapshot.revision, digest: prepared.snapshot.digest,
        repositoryDigest: prepared.repositoryDigest });
}
function fingerprint(prepared) { return createHash('sha256').update(fingerprintData(prepared)).digest('hex'); }
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

async function setup(t, { store = emptyStore(), fileSystem = {} } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-auto-write-'));
    const storePath = path.join(directory, 'memory-v2.json');
    await fs.writeFile(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    const repository = createJsonMemoryRepository({ storePath, fileSystem, now: () => NOW });
    await repository.open();
    t.after(async () => {
        await repository.close().catch(() => {});
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { directory, storePath, repository };
}

function prepareTestOperation({ text, proposal, snapshot, repositoryDigest }) {
    const normalized = normalizeAutomaticMemoryProposal(proposal);
    if (!normalized.success || normalized.proposal.candidates.length !== 1) throw coded('automatic_candidate_invalid');
    const planned = planAutomaticMemoryPersistence({ text, proposal, snapshot });
    if (!planned.success || planned.operations.length !== 1) throw coded('automatic_plan_invalid');
    const operation = planned.operations[0];
    if (!['ADD', 'REPLACE'].includes(operation.operation)) throw coded('automatic_operation_not_writable_in_test');
    const prepared = { text, proposal: structuredClone(proposal), snapshot: structuredClone(snapshot),
        operation: operation.operation, targetAssertionId: operation.targetAssertionId ?? null,
        candidate: structuredClone(normalized.proposal.candidates[0]), textSha256: createHash('sha256').update(text).digest('hex'),
        repositoryDigest };
    prepared.fingerprint = fingerprint(prepared);
    return deepFreeze(prepared);
}

function coded(code) { return Object.assign(new Error(code), { code }); }

// Synthetic test-only execution authorization: an opaque one-use token bound
// to a specific temporary repository and prepared operation. It is not a
// runtime proof, MemoryService grant, or reusable public skipAuthorization flag.
function issueTestExecutionPermit(repository, prepared) {
    const permit = Object.freeze(Object.create(null));
    testExecutionPermits.set(permit, { repository, fingerprint: fingerprint(prepared), used: false });
    return permit;
}
function issueSyntheticConfirmation(repository, prepared) {
    const confirmation = Object.freeze(Object.create(null));
    testConfirmations.set(confirmation, { repository, fingerprint: fingerprint(prepared),
        targetAssertionId: prepared.targetAssertionId, consumed: false });
    return confirmation;
}

async function writePreparedOperationForTest(repository, prepared, permit, confirmation = null) {
    const grant = permit && typeof permit === 'object' ? testExecutionPermits.get(permit) : null;
    if (grant) { grant.used = true; testExecutionPermits.delete(permit); }
    if (!grant || grant.used !== true || grant.repository !== repository
        || grant.fingerprint !== fingerprint(prepared) || prepared.fingerprint !== fingerprint(prepared)) {
        throw coded('test_execution_permit_invalid');
    }
    let confirmationState = null;
    if (prepared.operation === 'REPLACE') {
        confirmationState = confirmation && typeof confirmation === 'object' ? testConfirmations.get(confirmation) : null;
        if (confirmationState) { confirmationState.consumed = true; testConfirmations.delete(confirmation); }
        if (!confirmationState || confirmationState.consumed !== true || confirmationState.repository !== repository
            || confirmationState.fingerprint !== fingerprint(prepared)
            || confirmationState.targetAssertionId !== prepared.targetAssertionId) throw coded('test_confirmation_invalid');
    }

    // Recompute the dry-run plan from its frozen inputs. The plan is a selector,
    // never authorization; only the separate private test permit enables this
    // test-file-local writer.
    const recalculated = planAutomaticMemoryPersistence({ text: prepared.text,
        proposal: prepared.proposal, snapshot: prepared.snapshot });
    if (!recalculated.success || recalculated.operations.length !== 1
        || recalculated.operations[0].operation !== prepared.operation
        || (recalculated.operations[0].targetAssertionId ?? null) !== prepared.targetAssertionId) {
        throw coded('automatic_plan_changed');
    }
    const current = await repository.readSnapshot();
    if (current.revision !== prepared.snapshot.revision || current.digest !== prepared.repositoryDigest) {
        throw new MemoryRepositoryError('memory_revision_conflict');
    }
    const normalized = normalizeAutomaticMemoryProposal(prepared.proposal);
    const value = normalized.proposal.candidates[0].value_text;
    if (!screenMemorySecret(value).safe) throw coded('memory_secret_suspected');
    const record = assertionFor(current.snapshot, prepared.candidate, {
        supersedes: prepared.operation === 'REPLACE' ? [prepared.targetAssertionId] : [],
    });
    if (prepared.operation === 'ADD' && record.supersedes.length !== 0) throw coded('add_must_be_append_only');

    const changes = [];
    if (prepared.operation === 'REPLACE') {
        const target = current.snapshot.assertions.find(item => item.id === prepared.targetAssertionId);
        if (!target || target.status !== 'active'
            || target.predicate !== record.predicate
            || canonicalSubject(target.subject, current.snapshot).id !== current.snapshot.self_person_id
            || target.object?.type !== 'text'
            || !prepared.candidate.evidence_quote.includes(target.object.value)
            || target.object.value === value) throw coded('replace_target_invalid');
        changes.push({ type: 'put', collection: 'assertions', record: { ...structuredClone(target), status: 'superseded' } });
    } else if (prepared.targetAssertionId !== null) throw coded('add_target_forbidden');

    const inferenceSourceId = id('src'), inferredEvidenceId = id('ev');
    changes.push({ type: 'put', collection: 'assertions', record });
    changes.push({ type: 'put', collection: 'sources', record: source(inferenceSourceId, 'inference', NOW) });
    changes.push({ type: 'put', collection: 'evidence', record: {
        id: inferredEvidenceId, assertion_id: record.id, source_id: inferenceSourceId,
        derivation: 'inferred', extraction_confidence: prepared.candidate.linguistic_confidence,
        learned_at: NOW, last_confirmed_at: null, legacy_ref: null,
    } });
    if (prepared.operation === 'REPLACE') {
        const confirmSourceId = id('src');
        changes.push({ type: 'put', collection: 'sources', record: source(confirmSourceId, 'user_statement', NOW) });
        changes.push({ type: 'put', collection: 'evidence', record: {
            id: id('ev'), assertion_id: record.id, source_id: confirmSourceId,
            derivation: 'explicit', extraction_confidence: null,
            learned_at: NOW, last_confirmed_at: NOW, legacy_ref: null,
        } });
    }
    for (const change of changes) {
        if (change.type === 'put') validateMemoryRecord(change.collection, change.record);
    }
    return repository.commit({ expectedRevision: prepared.snapshot.revision,
        expectedDigest: prepared.repositoryDigest, changes });
}

async function planned(repository, text, proposal) {
    const snapshot = await repository.readSnapshot();
    const envelope = { snapshot: snapshot.snapshot, revision: snapshot.revision,
        digest: snapshotFingerprint({ snapshot: snapshot.snapshot }) };
    return prepareTestOperation({ text, proposal, snapshot: envelope, repositoryDigest: snapshot.digest });
}

function priorAssertion({ value = 'Ibanez', predicate = 'user.owns_item', status = 'active', serial = 10 } = {}) {
    const suffix = String(serial).padStart(12, '0');
    const assertionId = `mem_00000000-0000-4000-8000-${suffix}`;
    const sourceId = `src_00000000-0000-4000-8000-${suffix}`;
    const evidenceId = `ev_00000000-0000-4000-8000-${suffix}`;
    return {
        assertion: { id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: SELF },
            predicate, object: { type: 'text', value }, status, valid_from: null, valid_to: null,
            recorded_at: NOW, supersedes: [], compatibility: null },
        source: source(sourceId, 'user_statement', NOW),
        evidence: { id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: null, learned_at: NOW, last_confirmed_at: null, legacy_ref: null },
    };
}
function storeWithPrior(values) {
    const store = emptyStore();
    for (const [index, value] of values.entries()) {
        const prior = priorAssertion({ ...value, serial: index + 10 });
        store.assertions.push(prior.assertion); store.sources.push(prior.source); store.evidence.push(prior.evidence);
    }
    return store;
}
function toolCandidate(text, value, overrides = {}) {
    return proposalFor(text, { candidate_type: 'tool', predicate: 'uses', value_text: value,
        update_intent: 'possible_correction', suggested_disposition: 'ask', ...overrides });
}

test('ADD appends a distinct assertion and leaves a compatible active assertion unchanged', async t => {
    const f = await setup(t, { store: storeWithPrior([{ value: 'Ibanez' }]) });
    const text = 'También tengo una Fender.';
    const prepared = await planned(f.repository, text, proposalFor(text));
    assert.equal(prepared.operation, 'ADD');
    assert.equal(prepared.targetAssertionId, null);
    const before = await f.repository.readSnapshot();
    const result = await writePreparedOperationForTest(f.repository, prepared, issueTestExecutionPermit(f.repository, prepared));
    assert.equal(result.snapshot.assertions.filter(item => item.status === 'active').length, 2);
    assert.equal(result.snapshot.assertions.find(item => item.object.value === 'Ibanez').status, 'active');
    assert.equal(result.snapshot.assertions.find(item => item.object.value === 'Ibanez').id, before.snapshot.assertions[0].id);
    assert.equal(result.snapshot.assertions.find(item => item.object.value === 'Fender').supersedes.length, 0);
});

test('ADD is append-only, uses inferred provenance, and cannot use a dry-run contract as authorization', async t => {
    const f = await setup(t);
    const text = 'También tengo una Fender.'; const proposal = proposalFor(text);
    const prepared = await planned(f.repository, text, proposal);
    const dryRun = createAutomaticMemoryPersistenceContract({ text, proposal, snapshot: prepared.snapshot });
    assert.equal(dryRun.operations[0].operation, 'ADD');
    assert.equal(dryRun.operations[0].executable, false);
    assert.equal(dryRun.operations[0].writeReady, false);
    await assert.rejects(writePreparedOperationForTest(f.repository, prepared, dryRun), { code: 'test_execution_permit_invalid' });
    const result = await writePreparedOperationForTest(f.repository, prepared, issueTestExecutionPermit(f.repository, prepared));
    const record = result.snapshot.assertions[0];
    const evidence = result.snapshot.evidence.find(item => item.assertion_id === record.id);
    const sourceRecord = result.snapshot.sources.find(item => item.id === evidence.source_id);
    assert.deepEqual(record.supersedes, []);
    assert.equal(sourceRecord.kind, 'inference');
    assert.equal(sourceRecord.origin_trust, 'derived_untrusted');
    assert.equal(evidence.derivation, 'inferred');
    assert.equal(evidence.extraction_confidence, 0.94);
});

test('ADD rejects invalid candidates, unresolved identities, secrets, and partial mutations', async t => {
    const f = await setup(t);
    const before = await f.repository.readSnapshot();
    for (const [text, proposal] of [
        ['Synthetic value.', { candidates: [] }],
        ['Synthetic project decision.', proposalFor('Synthetic project decision.', { candidate_type: 'decision',
            predicate: 'decided', subject_text: 'Project Nebula', value_text: 'pause', update_intent: 'new_fact', evidence_quote: 'Decidí pausar Project Nebula.' })],
        ['Con mi compañera Dana tengo una guitarra Fender.', proposalFor('Con mi compañera Dana tengo una guitarra Fender.', {
            subject_text: 'Dana', mentioned_person_text: 'Dana', value_text: 'Fender', evidence_quote: 'tengo una guitarra Fender' })],
        ['Tengo una tarjeta secreta.', proposalFor('Tengo una tarjeta secreta.', { value_text: 'sk_live_1234567890ABCDEF' })],
    ]) {
        const snapshot = await f.repository.readSnapshot();
        const planSnapshot = { snapshot: snapshot.snapshot, revision: snapshot.revision,
            digest: snapshotFingerprint({ snapshot: snapshot.snapshot }) };
        const attempt = () => prepareTestOperation({ text, proposal, snapshot: planSnapshot,
            repositoryDigest: snapshot.digest });
        if (proposal.candidates?.[0]?.value_text?.startsWith('sk_live_')) {
            const invalidPlan = planAutomaticMemoryPersistence({ text, proposal,
                snapshot: planSnapshot });
            assert.equal(invalidPlan.success, true);
            assert.notEqual(invalidPlan.operations[0].operation, 'ADD');
        } else assert.throws(attempt);
    }
    assert.equal((await f.repository.readSnapshot()).digest, before.digest);
    assert.equal((await f.repository.readSnapshot()).snapshot.assertions.length, 0);
});

test('REPLACE supersedes only the exact active target and preserves both inferred and confirmation provenance', async t => {
    const unrelated = priorAssertion({ value: 'Ibanez' });
    const target = priorAssertion({ value: 'Acer', predicate: 'user.uses_tool', serial: 11 });
    const f = await setup(t, { store: storeWithPrior([{ value: 'Ibanez' }, { value: 'Acer', predicate: 'user.uses_tool' }]) });
    const text = 'Ya no uso la Acer; ahora uso una Lenovo.';
    const proposal = toolCandidate(text, 'Lenovo', { evidence_quote: text });
    const prepared = await planned(f.repository, text, proposal);
    assert.equal(prepared.operation, 'REPLACE');
    assert.equal(prepared.targetAssertionId, target.assertion.id);
    const confirm = issueSyntheticConfirmation(f.repository, prepared);
    const result = await writePreparedOperationForTest(f.repository, prepared,
        issueTestExecutionPermit(f.repository, prepared), confirm);
    const old = result.snapshot.assertions.find(item => item.id === target.assertion.id);
    const newRecord = result.snapshot.assertions.find(item => item.object.value === 'Lenovo');
    const untouched = result.snapshot.assertions.find(item => item.id === unrelated.assertion.id);
    assert.equal(old.status, 'superseded');
    assert.deepEqual(newRecord.supersedes, [old.id]);
    assert.equal(untouched.status, 'active');
    assert.deepEqual(untouched.supersedes, []);
    const evidence = result.snapshot.evidence.filter(item => item.assertion_id === newRecord.id);
    assert.deepEqual(evidence.map(item => item.derivation).sort(), ['explicit', 'inferred']);
    const evidenceSources = evidence.map(item => result.snapshot.sources.find(sourceRecord => sourceRecord.id === item.source_id));
    assert.deepEqual(evidenceSources.map(item => item.kind).sort(), ['inference', 'user_statement']);
});

test('REPLACE requires the exact target and one-use operation-bound synthetic confirmation', async t => {
    const f = await setup(t, { store: storeWithPrior([{ value: 'Acer', predicate: 'user.uses_tool' }]) });
    const text = 'Ya no uso la Acer; ahora uso una Lenovo.';
    const prepared = await planned(f.repository, text, toolCandidate(text, 'Lenovo', { evidence_quote: text }));
    const before = await f.repository.readSnapshot();
    await assert.rejects(writePreparedOperationForTest(f.repository, prepared,
        issueTestExecutionPermit(f.repository, prepared)), { code: 'test_confirmation_invalid' });
    const wrongText = 'Ya no uso la Acer; ahora uso una HP.';
    const wrong = await planned(f.repository, wrongText, toolCandidate(wrongText, 'HP', { evidence_quote: wrongText }));
    const mismatchedConfirmation = issueSyntheticConfirmation(f.repository, wrong);
    await assert.rejects(writePreparedOperationForTest(f.repository, prepared,
        issueTestExecutionPermit(f.repository, prepared), mismatchedConfirmation), { code: 'test_confirmation_invalid' });
    assert.equal((await f.repository.readSnapshot()).digest, before.digest);
});

test('REPLACE refuses absent or ambiguous evidence targets and identity conflicts', async t => {
    const absent = await setup(t, { store: emptyStore() });
    const missingText = 'Ya no uso la Acer; ahora uso una Lenovo.';
    const missingPlan = planAutomaticMemoryPersistence({ text: missingText,
        proposal: toolCandidate(missingText, 'Lenovo', { evidence_quote: missingText }),
        snapshot: await envelope(absent.repository) });
    assert.equal(missingPlan.operations[0].operation, 'ASK');

    const ambiguous = await setup(t, { store: storeWithPrior([
        { value: 'Acer', predicate: 'user.uses_tool' }, { value: 'Dell', predicate: 'user.uses_tool' },
    ]) });
    const ambiguousText = 'Ya no uso Acer ni Dell; ahora uso una Lenovo.';
    const ambiguousPlan = planAutomaticMemoryPersistence({ text: ambiguousText,
        proposal: toolCandidate(ambiguousText, 'Lenovo', { evidence_quote: ambiguousText }),
        snapshot: await envelope(ambiguous.repository) });
    assert.equal(ambiguousPlan.operations[0].operation, 'ASK');
    assert.ok(ambiguousPlan.operations[0].reasonCodes.includes('replace_target_ambiguous'));

    const conflictText = 'Dana usa una Lenovo.';
    const conflictProposal = proposalFor(conflictText, { subject_text: 'Dana', mentioned_person_text: 'Dana',
        value_text: 'Lenovo', predicate: 'owns', evidence_quote: conflictText });
    const conflict = planAutomaticMemoryPersistence({ text: conflictText, proposal: conflictProposal,
        snapshot: await envelope(ambiguous.repository) });
    assert.equal(conflict.operations[0].operation, 'ASK');
    assert.equal((await absent.repository.readSnapshot()).snapshot.assertions.length, 0);
});

async function envelope(repository) {
    const current = await repository.readSnapshot();
    return { snapshot: current.snapshot, revision: current.revision,
        digest: snapshotFingerprint({ snapshot: current.snapshot }) };
}

test('repository persistence failure leaves the complete prior file and revision intact', async t => {
    const error = Object.assign(new Error('synthetic persistence failure'), { code: 'EIO' });
    const f = await setup(t, { fileSystem: { rename: async () => { throw error; } } });
    const text = 'También tengo una Fender.';
    const prepared = await planned(f.repository, text, proposalFor(text));
    const beforeBytes = await fs.readFile(f.storePath);
    await assert.rejects(writePreparedOperationForTest(f.repository, prepared,
        issueTestExecutionPermit(f.repository, prepared)), item => item instanceof MemoryRepositoryError
            && item.code === 'memory_persist_failed');
    assert.deepEqual(await fs.readFile(f.storePath), beforeBytes);
    assert.equal((await f.repository.readSnapshot()).revision, 0);
});

test('stale snapshot is rejected without rebasing or partial write', async t => {
    const f = await setup(t);
    const staleText = 'También tengo una Fender.';
    const stale = await planned(f.repository, staleText, proposalFor(staleText));
    const currentText = 'También tengo una Ibanez.';
    const current = await planned(f.repository, currentText, proposalFor(currentText, { value_text: 'Ibanez' }));
    await writePreparedOperationForTest(f.repository, current, issueTestExecutionPermit(f.repository, current));
    const afterCurrent = await f.repository.readSnapshot();
    await assert.rejects(writePreparedOperationForTest(f.repository, stale, issueTestExecutionPermit(f.repository, stale)),
        { code: 'memory_revision_conflict' });
    const afterStale = await f.repository.readSnapshot();
    assert.equal(afterStale.revision, afterCurrent.revision);
    assert.equal(afterStale.snapshot.assertions.length, 1);
    assert.equal(afterStale.snapshot.assertions[0].object.value, 'Ibanez');
});

test('B.2a and B.2b.1 contracts remain dry-run and cannot authorize the test writer', async t => {
    const f = await setup(t);
    const text = 'También tengo una Fender.'; const proposal = proposalFor(text);
    const prepared = await planned(f.repository, text, proposal);
    const contract = createAutomaticMemoryPersistenceContract({ text, proposal, snapshot: prepared.snapshot });
    const assessment = assessAutomaticMemoryAuthorization({ text, proposal, snapshot: prepared.snapshot,
        operationIndex: 0, contextClaims: null });
    assert.equal(contract.executable, false); assert.equal(contract.writeReady, false);
    assert.equal(contract.operations[0].authorization.granted, false);
    assert.equal(assessment.authorization.granted, false); assert.equal(assessment.executable, false);
    await assert.rejects(writePreparedOperationForTest(f.repository, prepared, contract),
        { code: 'test_execution_permit_invalid' });
    assert.equal((await f.repository.readSnapshot()).revision, 0);
});
