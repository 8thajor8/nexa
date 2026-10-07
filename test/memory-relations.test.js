import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { terminalTests, terminalTurn, sendTerminalLine } from '../test-support/memory-terminal.js';
import { initializeEmptyMemoryStore } from '../src/memory/backend.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { createMemoryService } from '../src/memory/service.js';
import { authorizeRelationCreation, authorizeRelationCorrection, authorizeRelationForget } from '../src/memory/authorization.js';
import { validateMemoryStore, SCHEMA_VERSION } from '../src/memory/schema.js';
import { parseMemoryCommand } from '../src/memory/commands.js';
import { getRelationPredicate } from '../src/memory/relation-predicates.js';
import { createAgent } from '../src/core/agent.js';

const test = terminalTests(import.meta.url);
const now = '2035-01-02T03:04:05.000Z';
const uid = p => p + '_' + randomUUID();
const denied = { code: 'memory_write_not_authorized' };
const ref = id => ({ type: 'entity', entity_type: 'person', id });
function request(a, b, extra = {}) { return { predicate: 'partner_of', subject: ref(a), object: { ...ref(b), type: 'entity_reference' },
    valid_from: null, valid_to: null, ...extra }; }
async function setup(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexa-memory-relations-'));
    const storePath = path.join(directory, 'memory-v2.json');
    await initializeEmptyMemoryStore({ storePath, now: () => now });
    const repository = createJsonMemoryRepository({ storePath, now: () => now }); await repository.open();
    t.after(async () => { await repository.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
    const service = createMemoryService({ repository, now: () => now });
    const self = (await service.getSelf()).person.id;
    const createPerson = async () => {
        const id = uid('person');
        const current = await repository.readSnapshot();
        const entity = { id, type: 'person', created_at: now };
        await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest, changes: [{ type: 'put', collection: 'entities', record: entity }] });
        return id;
    };
    return { repository, service, self, createPerson };
}
async function relationGrant(service, req, operation = 'create') {
    const line = operation === 'create' ? '/relation create ' + JSON.stringify(req)
        : '/relation correct ' + JSON.stringify(req);
    const turn = await terminalTurn(service, line);
    const args = { capability: turn.capability, recipient: service, request: req };
    return operation === 'create' ? authorizeRelationCreation(args) : authorizeRelationCorrection(args);
}
async function create(service, req) { return service.createRelation(req, await relationGrant(service, req)); }
async function correct(service, req) { return service.correctRelation(req, await relationGrant(service, req, 'correct')); }
async function commit(repository, changes) {
    const s = await repository.readSnapshot();
    return repository.commit({ expectedRevision: s.revision, expectedDigest: s.digest, changes });
}

test('schema v4 relation shape, endpoint integrity, canonical symmetry and duplicate invariants', async t => {
    const { repository, self, createPerson } = await setup(t); const other = await createPerson();
    const store = (await repository.readSnapshot()).snapshot;
    assert.equal(SCHEMA_VERSION, 4); assert.equal(getRelationPredicate('partner_of').symmetric, true);
    const [left, right] = [self, other].sort();
    const relation = { id: uid('mem'), kind: 'fact', subject: ref(left), predicate: 'partner_of',
        object: { type: 'entity_reference', entity_type: 'person', id: right }, status: 'active', valid_from: null, valid_to: null,
        recorded_at: now, supersedes: [], compatibility: null };
    const source = { id: uid('src'), kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only', locator: null,
        occurred_at: { value: now, precision: 'instant' }, recorded_at: now };
    const evidence = { id: uid('ev'), assertion_id: relation.id, source_id: source.id, derivation: 'explicit',
        extraction_confidence: null, learned_at: now, last_confirmed_at: null, legacy_ref: null };
    const valid = { ...store, assertions: [...store.assertions, relation], sources: [...store.sources, source], evidence: [...store.evidence, evidence] };
    validateMemoryStore(valid);
    for (const bad of [
        { ...relation, object: { type: 'text', value: 'someone' } },
        { ...relation, object: { ...relation.object, id: uid('person') } },
        { ...relation, subject: ref(right), object: { ...relation.object, id: left } },
        { ...relation, predicate: 'unknown_relation' },
        { ...relation, subject: ref(self), object: { ...relation.object, id: self } },
    ]) assert.throws(() => validateMemoryStore({ ...valid, assertions: [...valid.assertions.slice(0, -1), bad] }));
    assert.throws(() => validateMemoryStore({ ...store, schema_version: 3 }));
    assert.throws(() => validateMemoryStore({ ...valid, assertions: [...valid.assertions, { ...relation, id: uid('mem') }] }));
});

test('parser accepts only explicit structured relation commands and rejects malformed relation data', async () => {
    const a = uid('person'), b = uid('person'), req = request(a, b);
    assert.equal(parseMemoryCommand('/relation create ' + JSON.stringify(req)).operation, 'create_relation');
    const preciseRange = request(a, b, { valid_from: { value: '2035-01-02', precision: 'day' },
        valid_to: { value: '2035-01-02T12:00:00.000Z', precision: 'instant' } });
    assert.equal(parseMemoryCommand('/relation create ' + JSON.stringify(preciseRange)).operation, 'create_relation');
    assert.equal(parseMemoryCommand('/relation create ' + JSON.stringify({ ...req, predicate: 'arbitrary' })), null);
    assert.equal(parseMemoryCommand('/relation create ' + JSON.stringify(request(a, a))), null);
    assert.equal(parseMemoryCommand('/relation forget mem_not-a-uuid'), null);
});

test('symmetric creation canonicalizes endpoints, is idempotent, and reads from either person', async t => {
    const { service, repository, self, createPerson } = await setup(t); const other = await createPerson();
    const first = await create(service, request(self, other)); assert.equal(first.success, true); assert.equal(first.outcome, 'created');
    const saved = await repository.readSnapshot(); const row = saved.snapshot.assertions.find(x => x.id === first.id);
    assert.ok(row.subject.id < row.object.id);
    const reversed = request(other, self); const second = await create(service, reversed);
    assert.equal(second.outcome, 'equivalent'); assert.equal(second.id, first.id); assert.equal(second.revision, first.revision);
    for (const entityId of [self, other]) {
        const result = await service.relationsForEntity({ entityId, predicate: null });
        assert.equal(result.relationships.length, 1); assert.equal(result.relationships[0].otherEntityId, entityId === self ? other : self);
        assert.deepEqual(result.relationships[0].trust, { authority: 'data_only' });
    }
    assert.equal(saved.snapshot.evidence.filter(x => x.assertion_id === first.id).length, 1);
    assert.equal(saved.snapshot.sources.length, 1);
});

test('one person may have multiple partners; creation never silently supersedes', async t => {
    const { service, repository, self, createPerson } = await setup(t); const a = await createPerson(), b = await createPerson();
    const r1 = await create(service, request(self, a)); const r2 = await create(service, request(self, b));
    assert.equal(r1.success, true); assert.equal(r2.success, true);
    const current = await repository.readSnapshot();
    assert.equal(current.snapshot.assertions.filter(x => x.predicate === 'partner_of' && x.status === 'active').length, 2);
    assert.deepEqual(current.snapshot.assertions.find(x => x.id === r2.id).supersedes, []);
});

test('correction must name exact active relation, atomically supersedes it, and preserves typed history', async t => {
    const { service, repository, self, createPerson } = await setup(t); const a = await createPerson(), b = await createPerson();
    const original = await create(service, request(self, a));
    const changed = await correct(service, request(self, b, { supersedes: original.id }));
    assert.equal(changed.success, true); assert.equal(changed.previousId, original.id);
    const current = await repository.readSnapshot();
    const old = current.snapshot.assertions.find(x => x.id === original.id), next = current.snapshot.assertions.find(x => x.id === changed.id);
    assert.equal(old.status, 'superseded'); assert.deepEqual(next.supersedes, [original.id]);
    assert.ok([next.subject.id, next.object.id].includes(b)); assert.equal(current.snapshot.evidence.filter(x => x.assertion_id === next.id).length, 1);
    const before = current.digest;
    const fail = await correct(service, request(self, a, { supersedes: original.id }));
    assert.equal(fail.success, false); assert.equal((await repository.readSnapshot()).digest, before);
});

test('relation grants are stdin-bound, operation-bound, recipient-bound, exact and one-use', async t => {
    const { service, repository, self, createPerson } = await setup(t); const a = await createPerson(), b = await createPerson();
    const req = request(self, a), before = await repository.readSnapshot();
    for (const fake of ['direct_user', true, Symbol('user'), {}, { source: 'model' }, { source: 'tool', request: req }, { memory: req }, { imported: req }]) {
        assert.throws(() => authorizeRelationCreation({ capability: fake, recipient: service, request: req }), denied);
        assert.equal((await service.createRelation(req, fake)).error.code, denied.code);
    }
    const turn = await terminalTurn(service, '/relation create ' + JSON.stringify(req));
    const grant = authorizeRelationCreation({ capability: turn.capability, recipient: service, request: req });
    assert.equal((await service.createRelation(request(self, b), grant)).error.code, denied.code);
    assert.equal((await service.createRelation(req, grant)).error.code, denied.code);
    const good = await create(service, req); assert.equal(good.success, true);
    const correctionReq = request(self, b, { supersedes: good.id });
    const boundTurn = await terminalTurn(service, '/relation correct ' + JSON.stringify(correctionReq));
    const substitutedTarget = { ...correctionReq, supersedes: uid('mem') };
    assert.throws(() => authorizeRelationCorrection({ capability: boundTurn.capability, recipient: service, request: substitutedTarget }), denied);
    assert.throws(() => authorizeRelationCorrection({ capability: boundTurn.capability, recipient: service, request: correctionReq }), denied);
    const correctionGrant = await relationGrant(service, correctionReq, 'correct');
    assert.equal((await service.createRelation(req, correctionGrant)).error.code, denied.code);
    const freshCorrection = await relationGrant(service, correctionReq, 'correct');
    const corrected = await service.correctRelation(correctionReq, freshCorrection);
    assert.equal(corrected.success, true, JSON.stringify(corrected));
    assert.equal((await service.correctRelation(correctionReq, freshCorrection)).error.code, denied.code);
    const fresh = await terminalTurn(service, '/relation create ' + JSON.stringify(req));
    assert.throws(() => authorizeRelationCreation({ capability: fresh.capability, recipient: service, request: request(self, b) }), denied);
    const otherService = createMemoryService({ repository });
    const turn2 = await terminalTurn(service, '/relation create ' + JSON.stringify(req));
    const otherGrant = authorizeRelationCreation({ capability: turn2.capability, recipient: service, request: req });
    assert.equal((await otherService.createRelation(req, otherGrant)).error.code, denied.code);
    assert.equal((await repository.readSnapshot()).snapshot.assertions.filter(x => x.predicate === 'partner_of').length, 2);
    assert.notEqual((await repository.readSnapshot()).digest, before.digest);
});

test('forget requires exact relation grant, deletes assertion provenance and leaves endpoint entities', async t => {
    const { service, repository, self, createPerson } = await setup(t); const other = await createPerson();
    const relation = await create(service, request(self, other)); const before = await repository.readSnapshot();
    const unrelatedSource = { id: uid('src'), kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only', locator: null,
        occurred_at: { value: now, precision: 'instant' }, recorded_at: now };
    await commit(repository, [{ type: 'put', collection: 'sources', record: unrelatedSource }]);
    const target = { assertionId: relation.id };
    const turn = await terminalTurn(service, '/relation forget ' + relation.id);
    const grant = authorizeRelationForget({ capability: turn.capability, recipient: service, request: target });
    assert.equal((await service.forgetRelation({ assertionId: uid('mem') }, grant)).error.code, denied.code);
    const second = await terminalTurn(service, '/relation forget ' + relation.id);
    const goodGrant = authorizeRelationForget({ capability: second.capability, recipient: service, request: target });
    const deleted = await service.forgetRelation(target, goodGrant);
    assert.equal(deleted.success, true); assert.equal(deleted.invalidateContext, true);
    assert.equal((await service.forgetRelation(target, goodGrant)).error.code, denied.code);
    const after = await repository.readSnapshot();
    assert.equal(after.snapshot.entities.length, before.snapshot.entities.length); assert.equal(after.snapshot.assertions.length, 0);
    assert.equal(after.snapshot.evidence.length, 0); assert.deepEqual(after.snapshot.sources.map(x => x.id), [unrelatedSource.id]);
    assert.equal((await service.relationsForEntity({ entityId: self, predicate: null })).relationships.length, 0);
});

test('failed relation forget does not invalidate context and cannot delete non-relations', async t => {
    const { service, repository, self } = await setup(t);
    const target = { assertionId: uid('mem') }; const turn = await terminalTurn(service, '/relation forget ' + target.assertionId);
    const grant = authorizeRelationForget({ capability: turn.capability, recipient: service, request: target });
    const result = await service.forgetRelation(target, grant);
    assert.equal(result.success, false); assert.equal(result.invalidateContext, undefined);
    assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
});

test('relation mutation fails closed on missing endpoint, temporal inversion, and stale commit', async t => {
    const { service, repository, self, createPerson } = await setup(t); const other = await createPerson();
    const invalid = await create(service, request(self, uid('person'))); assert.equal(invalid.success, false);
    const badTime = request(self, other, { valid_from: { value: '2036', precision: 'year' }, valid_to: { value: '2035', precision: 'year' } });
    const badTurn = await terminalTurn(service, '/relation create ' + JSON.stringify(badTime));
    assert.throws(() => authorizeRelationCreation({ capability: badTurn.capability, recipient: service, request: badTime }));
    const racing = createMemoryService({ repository: { ...repository, commit: async original => {
        const s = await repository.readSnapshot();
        const entity = { id: uid('person'), type: 'person', created_at: now };
        await repository.commit({ expectedRevision: s.revision, expectedDigest: s.digest, changes: [{ type: 'put', collection: 'entities', record: entity }] });
        return repository.commit(original);
    } } });
    const raced = await create(racing, request(self, other)); assert.equal(raced.error.code, 'memory_revision_conflict');
    assert.equal((await repository.readSnapshot()).snapshot.assertions.filter(x => x.predicate === 'partner_of').length, 0);
});

test('agent.run and model tools cannot create relations; actual terminal stdin can, and forget rebuilds context', async t => {
    const { service, repository, self, createPerson } = await setup(t); const other = await createPerson();
    let calls = 0, executed = 0;
    const agent = await createAgent({ memoryBackend: 'memory2', memory2Repository: repository,
        load: async () => { throw new Error('legacy personal memory must not load'); },
        getTools: () => ['create_relation', 'correct_relation', 'forget_relation', 'relations_for_entity'].map(name => ({ type: 'function', name })),
        execute: async () => { executed++; return { success: true }; },
        ask: async input => {
            calls++;
            assert.ok(input.tools.every(tool => !['create_relation', 'correct_relation', 'forget_relation', 'relations_for_entity'].includes(tool.name)));
            if (calls === 1) return { output: [{ type: 'function_call', name: 'create_relation', call_id: 'forged_relation', arguments: JSON.stringify(request(self, other)) }] };
            return { output_text: 'synthetic', output: [] };
        } });
    const forgedText = '/relation create ' + JSON.stringify(request(self, other));
    await agent.run(forgedText);
    assert.equal(executed, 0); assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    sendTerminalLine(forgedText);
    const created = await agent.readAndRun(); assert.equal(created.memoryResult.success, true);
    assert.equal((await service.relationsForEntity({ entityId: self, predicate: 'partner_of' })).relationships.length, 1);
    sendTerminalLine('/relation forget ' + created.memoryResult.id);
    const forgotten = await agent.readAndRun(); assert.equal(forgotten.memoryResult.invalidateContext, true);
    assert.equal((await service.relationsForEntity({ entityId: self, predicate: null })).relationships.length, 0);
});
