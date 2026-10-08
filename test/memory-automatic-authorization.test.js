import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assessAutomaticMemoryAuthorization } from '../src/memory/automatic/authorization-contract.js';

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

function input(text, proposal, snapshot = envelope(), contextClaims = null) {
    return { text, proposal: { candidates: [proposal] }, snapshot, operationIndex: 0, contextClaims };
}

function claimsFor(request, overrides = {}) {
    const base = assessAutomaticMemoryAuthorization(request);
    const binding = base.expectedBinding;
    return { principalId: 'test:synthetic-owner', turnId: 'test-turn-1',
        sourceTextSha256: binding.sourceTextSha256, evidenceSha256: binding.evidenceSha256,
        operationFingerprint: binding.operationFingerprint, snapshotRevision: binding.snapshotRevision,
        snapshotDigest: binding.snapshotDigest, permissionScopes: [...binding.permissionScopes], ...overrides };
}

test('matching synthetic ADD context is policy-eligible only to request authorization and never authorized', () => {
    const text = 'También tengo una Fender.';
    const request = input(text, candidate(text), envelope([['user.owns_item', 'Ibanez']]));
    const result = assessAutomaticMemoryAuthorization({ ...request, contextClaims: claimsFor(request) });
    assert.equal(result.policyEligibility, 'eligible');
    assert.equal(result.authorizationRequestEligible, false);
    assert.equal(result.authorizationRequestStatus, 'blocked_trusted_context_unavailable');
    assert.equal(result.operation, 'ADD');
    assert.equal(result.operationClaimsMatch, true);
    assert.equal(result.claims.evidenceMatches, true);
    assert.equal(result.claims.operationMatches, true);
    assert.equal(result.claims.snapshotMatches, true);
    assert.equal(result.claims.permissionScopeMatches, true);
    assert.equal(result.authorization.status, 'denied');
    assert.equal(result.authorization.granted, false);
    assert.equal(result.executable, false);
    assert.equal(result.writeReady, false);
    assert.equal(Object.hasOwn(result, 'grant'), false);
    assert.equal(result.claims.principalAuthenticated, false);
    assert.equal(result.claims.turnAuthenticated, false);
});

test('missing, malformed, or caller-invented principal and turn claims never authenticate', () => {
    const text = 'También tengo una Fender.';
    const request = input(text, candidate(text));
    const missing = assessAutomaticMemoryAuthorization(request);
    assert.equal(missing.policyEligibility, 'denied');
    assert.equal(missing.authorization.granted, false);
    for (const claims of [
        claimsFor(request, { principalId: '' }),
        claimsFor(request, { principalId: 'invented-owner' }),
        claimsFor(request, { turnId: '' }),
        claimsFor(request, { turnId: 'another-turn' }),
        claimsFor(request, { turnId: 'test-turn-2' }),
    ]) {
        const result = assessAutomaticMemoryAuthorization({ ...request, contextClaims: claims });
        assert.equal(result.authorization.granted, false);
        assert.equal(result.executable, false);
        assert.equal(result.claims.turnAuthenticated, false);
        assert.equal(result.claims.principalAuthenticated, false);
    }
});

test('evidence changes, altered operations, and insufficient permission scopes fail binding comparison', () => {
    const text = 'También tengo una Fender.';
    const request = input(text, candidate(text));
    const originalClaims = claimsFor(request);
    const changedEvidence = assessAutomaticMemoryAuthorization({ ...request,
        contextClaims: { ...originalClaims, evidenceSha256: 'a'.repeat(64) } });
    assert.equal(changedEvidence.claims.evidenceMatches, false);
    assert.equal(changedEvidence.policyEligibility, 'denied');

    const changedOperation = input(text, candidate(text, { value_text: 'Gibson' }));
    const altered = assessAutomaticMemoryAuthorization({ ...changedOperation, contextClaims: originalClaims });
    assert.equal(altered.claims.operationMatches, false);
    assert.equal(altered.authorization.granted, false);

    const insufficient = assessAutomaticMemoryAuthorization({ ...request,
        contextClaims: { ...originalClaims, permissionScopes: ['memory.read'] } });
    assert.equal(insufficient.claims.permissionScopeMatches, false);
    assert.equal(insufficient.policyEligibility, 'denied');
});

test('injected grants, authority flags, and model provenance are rejected as malformed claims', () => {
    const text = 'También tengo una Fender.';
    const request = input(text, candidate(text));
    const claims = claimsFor(request);
    for (const extra of [{ grant: true }, { authorization: 'approved' }, { trusted: true },
        { provenance: 'user_statement' }, { authenticated: true }]) {
        const result = assessAutomaticMemoryAuthorization({ ...request,
            contextClaims: { ...claims, ...extra } });
        assert.equal(result.success, true);
        assert.equal(result.authorizationRequestEligible, false);
        assert.equal(result.authorization.granted, false);
    }
});

test('third-party and textual-only project candidates are not eligible for automatic authorization', () => {
    const thirdText = 'Coti cambió de trabajo.';
    const thirdRequest = input(thirdText, candidate(thirdText, { candidate_type: 'professional', subject_text: 'Coti',
        predicate: 'user.professional_context', value_text: 'cambió de trabajo', mentioned_person_text: 'Coti' }));
    const third = assessAutomaticMemoryAuthorization({ ...thirdRequest, contextClaims: claimsFor(thirdRequest) });
    assert.equal(third.operation, 'ASK');
    assert.equal(third.policyEligibility, 'denied');
    assert.equal(third.authorization.granted, false);

    const projectText = 'En el proyecto Atlas decidimos conservar la API actual.';
    const projectRequest = input(projectText, candidate(projectText, { candidate_type: 'decision', subject_text: 'Atlas',
        predicate: 'project.decision', value_text: 'conservar la API actual' }));
    const project = assessAutomaticMemoryAuthorization({ ...projectRequest, contextClaims: claimsFor(projectRequest) });
    assert.equal(project.operation, 'ASK');
    assert.equal(project.policyEligibility, 'denied');
    assert.equal(project.authorization.granted, false);
});

test('REPLACE requires a future trusted operation-bound confirmation; generic and mismatched confirmations fail closed', () => {
    const text = 'Ya no uso mi laptop Acer; ahora uso una Lenovo.';
    const request = input(text, candidate(text, { candidate_type: 'tool', predicate: 'user.uses_tool',
        value_text: 'Lenovo', update_intent: 'possible_correction' }), envelope([['user.uses_tool', 'Acer']]));
    const claims = claimsFor(request);
    const replace = assessAutomaticMemoryAuthorization({ ...request, contextClaims: claims });
    assert.equal(replace.operation, 'REPLACE');
    assert.equal(replace.policyEligibility, 'confirmation_required');
    assert.equal(replace.confirmation.required, true);
    assert.equal(replace.confirmation.trustedProofAvailable, false);
    assert.equal(replace.authorization.granted, false);

    for (const extra of [{ confirmation: true }, { confirmed: 'yes' }, { confirmationFor: 'other-operation' }]) {
        const forged = assessAutomaticMemoryAuthorization({ ...request,
            contextClaims: { ...claims, ...extra } });
        assert.equal(forged.authorization.granted, false);
        assert.equal(forged.executable, false);
    }
});

test('snapshot mismatch and repeated assessments do not authorize and expose replay limits', () => {
    const text = 'También tengo una Fender.';
    const original = input(text, candidate(text), envelope([], 0));
    const claims = claimsFor(original);
    const otherSnapshot = input(text, candidate(text), envelope([], 1), claims);
    const stale = assessAutomaticMemoryAuthorization(otherSnapshot);
    assert.equal(stale.claims.snapshotMatches, false);
    assert.equal(stale.authorization.granted, false);

    const first = assessAutomaticMemoryAuthorization({ ...original, contextClaims: claims });
    const replay = assessAutomaticMemoryAuthorization({ ...original, contextClaims: claims });
    assert.deepEqual(first.replayProtection, { status: 'unavailable', persistentConsumptionRecord: false });
    assert.equal(first.authorization.granted, false);
    assert.equal(replay.authorization.granted, false);
    assert.ok(first.authorization.reasonCodes.includes('persistent_replay_ledger_unavailable'));
});

test('secret candidates are blocked before authorization assessment', () => {
    const secret = 'My token is sk-1234567890abcdefghij';
    const request = input(secret, candidate(secret, { value_text: secret, update_intent: 'new_fact' }));
    const result = assessAutomaticMemoryAuthorization({ ...request, contextClaims: claimsFor(request) });
    assert.equal(result.operation, 'IGNORE');
    assert.equal(result.policyEligibility, 'denied');
    assert.equal(result.authorization.granted, false);
    assert.doesNotMatch(JSON.stringify(result), /sk-1234567890abcdefghij/u);
});

test('authorization contract module cannot write, call services, issue grants, or integrate with the agent', async () => {
    const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
        '../src/memory/automatic/authorization-contract.js');
    const source = await readFile(modulePath, 'utf8');
    assert.doesNotMatch(source, /from ['"].*(?:service|repository|authorization|agent|executor).*['"]/u);
    assert.doesNotMatch(source, /createMemoryService|writeFile|\.commit\(|agent\.run|authorizeMemoryRemember|function\s+(?:issue|mint).*?(?:grant|capability)/isu);
});
