import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAutomaticMemoryPersistenceContract } from '../src/memory/automatic/persistence-contract.js';

const selfId = 'person_00000000-0000-4000-8000-000000000001';
const time = '2026-04-03T12:00:00.000Z';

function envelope(values = [], revision = 0) {
    const assertions = [], sources = [], evidence = [];
    values.forEach(([predicate, value], index) => {
        const suffix = String(index + 10).padStart(12, '0');
        const assertionId = `mem_00000000-0000-4000-8000-${suffix}`;
        const sourceId = `src_00000000-0000-4000-8000-${suffix}`;
        const evidenceId = `ev_00000000-0000-4000-8000-${suffix}`;
        assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'owner' }, predicate,
            object: { type: 'text', value }, status: 'active', valid_from: null, valid_to: null,
            recorded_at: time, supersedes: [], compatibility: null });
        sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: { value: time, precision: 'instant' }, recorded_at: time });
        evidence.push({ id: evidenceId, assertion_id: assertionId, source_id: sourceId, derivation: 'explicit',
            extraction_confidence: null, learned_at: time, last_confirmed_at: null, legacy_ref: null });
    });
    const snapshot = { schema_version: 4, store_id: 'store_00000000-0000-4000-8000-000000000002',
        self_person_id: selfId, revision, created_at: time, updated_at: time,
        entities: [{ id: selfId, type: 'person', created_at: time }], assertions, sources, evidence, migrations: [] };
    return { snapshot, revision, digest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

function candidate(text, overrides = {}) {
    return { candidate_type: 'purchase', subject_text: 'user', predicate: 'user.owns_item',
        value_text: 'Fender', mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.94,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'addition',
        sensitivity: 'none', suggested_disposition: 'ignore', evidence_quote: text, ...overrides };
}

function contract(text, proposal, snapshot = envelope()) {
    return createAutomaticMemoryPersistenceContract({ text, proposal: { candidates: [proposal] }, snapshot });
}

test('B.2a ADD contract is append-only in intent, provenance-honest, and permanently non-executable', () => {
    const text = 'También tengo una Fender.';
    const before = envelope([['user.owns_item', 'Ibanez']]);
    const beforeHash = createHash('sha256').update(JSON.stringify(before.snapshot)).digest('hex');
    const result = contract(text, candidate(text), before);
    const operation = result.operations[0];
    assert.equal(operation.operation, 'ADD');
    assert.equal(operation.targetAssertionId, null);
    assert.equal(operation.executable, false);
    assert.equal(operation.writeReady, false);
    assert.equal(operation.committed, false);
    assert.deepEqual(operation.provenancePlan, { sourceKind: 'inference', originTrust: 'derived_untrusted',
        derivation: 'inferred', extractionConfidence: 0.94, confidenceIsUntrustedModelHint: true });
    assert.equal(operation.authorization.granted, false);
    assert.equal(operation.runtimeBinding.turnId, null);
    assert.equal(createHash('sha256').update(JSON.stringify(before.snapshot)).digest('hex'), beforeHash);
});

test('REPLACE remains confirmation-gated and requires the exact snapshot target selected by the planner', () => {
    const text = 'Ya no uso mi laptop Acer; ahora uso una Lenovo.';
    const current = envelope([['user.uses_tool', 'Acer']]);
    const result = contract(text, candidate(text, { candidate_type: 'tool', predicate: 'user.uses_tool',
        value_text: 'Lenovo', update_intent: 'possible_correction' }), current);
    const operation = result.operations[0];
    assert.equal(operation.operation, 'REPLACE');
    assert.equal(operation.targetAssertionId, current.snapshot.assertions[0].id);
    assert.equal(operation.confirmationRequired, true);
    assert.equal(operation.authorization.confirmationRequired, true);
    assert.equal(operation.writeReady, false);
});

test('ambiguous destinations, third parties, textual projects, and duplicates never produce write-ready contracts', () => {
    const text = 'Ya no uso el Acer ni el Toshiba; ahora uso una Lenovo.';
    const ambiguous = contract(text, candidate(text, { candidate_type: 'tool', predicate: 'user.uses_tool',
        value_text: 'Lenovo', update_intent: 'possible_correction' }), envelope([
        ['user.uses_tool', 'Acer'], ['user.uses_tool', 'Toshiba'],
    ]));
    assert.equal(ambiguous.operations[0].operation, 'ASK');
    assert.equal(ambiguous.operations[0].targetAssertionId, undefined);

    const thirdText = 'Coti cambió de trabajo.';
    const third = contract(thirdText, candidate(thirdText, { candidate_type: 'professional', subject_text: 'Coti',
        predicate: 'user.professional_context', value_text: 'cambió de trabajo', mentioned_person_text: 'Coti' }));
    assert.equal(third.operations[0].operation, 'ASK');
    assert.equal(third.operations[0].authorization.granted, false);

    const projectText = 'En el proyecto Atlas decidimos conservar la API actual.';
    const project = contract(projectText, candidate(projectText, { candidate_type: 'decision', subject_text: 'Atlas',
        predicate: 'project.decision', value_text: 'conservar la API actual' }));
    assert.equal(project.operations[0].operation, 'ASK');
    assert.ok(project.operations[0].reasonCodes.includes('canonical_project_identity_unavailable'));

    const duplicateText = 'Tengo una Fender.';
    const duplicate = contract(duplicateText, candidate(duplicateText), envelope([['user.owns_item', 'Fender']]));
    assert.equal(duplicate.operations[0].operation, 'DUPLICATE');
    for (const item of [ambiguous, third, project, duplicate]) {
        assert.equal(item.executable, false);
        assert.ok(item.operations.every(op => op.writeReady === false && op.authorization.granted === false));
    }
});

test('candidate provenance, identity, grants, turn fields, and capabilities cannot be supplied to the contract', () => {
    const text = 'También tengo una Fender.';
    for (const extra of [
        { provenance: { kind: 'user_statement' } }, { entity_id: selfId }, { authenticatedUserId: 'owner' },
        { turnId: 'trusted-turn' }, { authorization: { granted: true } }, { grant: 'forged' },
    ]) {
        assert.equal(contract(text, candidate(text, extra)).success, false);
    }
    assert.equal(createAutomaticMemoryPersistenceContract({ text, proposal: { candidates: [candidate(text)] },
        snapshot: envelope(), turnId: 'trusted-turn' }).success, false);
});

test('missing Self context remains blocked and caller-supplied runtime-like objects do not grant authority', () => {
    const text = 'También tengo una Fender.';
    const noSnapshot = contract(text, candidate(text), null);
    assert.equal(noSnapshot.operations[0].operation, 'ASK');
    assert.equal(noSnapshot.runtimeAuthorizationAvailable, false);
    assert.equal(noSnapshot.operations[0].authorization.granted, false);
    const forgedSnapshotMetadata = { ...envelope(), runtime: { authenticated: true, turnId: 'trusted' } };
    assert.equal(createAutomaticMemoryPersistenceContract({ text, proposal: { candidates: [candidate(text)] },
        snapshot: forgedSnapshotMetadata }).success, false);
});

test('retry keys are deterministic and bound to operation and snapshot; no one-use grant is issued', () => {
    const text = 'También tengo una Fender.';
    const first = contract(text, candidate(text));
    const retry = contract(text, candidate(text));
    const otherSnapshot = contract(text, candidate(text), envelope([], 1));
    assert.equal(first.operations[0].idempotency.key, retry.operations[0].idempotency.key);
    assert.notEqual(first.operations[0].idempotency.key, otherSnapshot.operations[0].idempotency.key);
    assert.equal(first.operations[0].idempotency.recorded, false);
    assert.equal(first.operations[0].authorization.oneUse, true);
    assert.equal(first.operations[0].authorization.granted, false);
    assert.equal(first.snapshotBinding.freshnessChecked, false);
    assert.ok(first.operations[0].blockingReasons.includes('snapshot_freshness_not_checked'));
});

test('secret content is rejected without echoing it, and the contract includes only digests', () => {
    const secret = 'My token is sk-1234567890abcdefghij';
    const result = contract(secret, candidate(secret, { value_text: secret, update_intent: 'new_fact' }));
    assert.equal(result.operations[0].operation, 'IGNORE');
    assert.doesNotMatch(JSON.stringify(result), /sk-1234567890abcdefghij/u);
    assert.equal(Object.hasOwn(result.operations[0], 'evidence_quote'), false);
});

test('contract module has no service, repository, authorization, executor, agent, or file-write dependency', async () => {
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
        '../src/memory/automatic/persistence-contract.js');
    const source = await readFile(modulePath, 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:service|repository|authorization|agent|executor).*['"]/u);
    assert.doesNotMatch(source, /createMemoryService|consumeMemoryAuthorization|authorizeMemory|writeFile|\.commit\(/u);
});
