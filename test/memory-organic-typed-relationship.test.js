import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOrganicMemoryAuthorization, ORGANIC_RELATIONSHIP_SCOPE,
    ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE } from '../src/core/organic-memory-authorization.js';
import { SCHEMA_VERSION, validateMemoryStore } from '../src/memory/schema.js';
import { createMemoryService } from '../src/memory/service.js';

const OWNER = 'synthetic-owner';
const NOW = '2035-02-03T04:05:06.000Z';
const FAMILY = Object.freeze({ category: 'family', label: 'hermano' });

async function setup(t, { consent = 'granted', failCommit = false, ownerId = OWNER } = {}) {
    const selfId = `person_${randomUUID()}`;
    let store = { schema_version: SCHEMA_VERSION, store_id: `store_${randomUUID()}`, self_person_id: selfId,
        revision: 0, created_at: NOW, updated_at: NOW,
        entities: [{ id: selfId, type: 'person', created_at: NOW }], assertions: [], sources: [], evidence: [],
        migrations: [], automatic_operations: [] };
    validateMemoryStore(store);
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let currentDigest = digest(store);
    const repository = {
        open: async () => {}, close: async () => {},
        readSnapshot: async () => ({ snapshot: structuredClone(store), revision: store.revision, digest: currentDigest }),
        commit: async request => {
            if (failCommit) throw new Error('synthetic_commit_failure');
            if (request.expectedRevision !== store.revision || request.expectedDigest !== currentDigest) throw new Error('memory_revision_conflict');
            const next = structuredClone(store);
            for (const change of request.changes) {
                const collection = next[change.collection];
                const record = structuredClone(change.record);
                const index = collection.findIndex(item => item.id === record.id);
                if (index < 0) collection.push(record); else collection[index] = record;
            }
            next.revision += 1; next.updated_at = NOW;
            validateMemoryStore(next);
            store = next; currentDigest = digest(next);
            return { snapshot: structuredClone(store), revision: store.revision, digest: currentDigest };
        },
    };
    const seedNamedPerson = async name => {
        const current = await repository.readSnapshot();
        const person = { id: `person_${randomUUID()}`, type: 'person', created_at: NOW };
        const assertion = { id: `mem_${randomUUID()}`, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: person.id },
            predicate: 'entity.preferred_name', object: { type: 'text', value: name }, status: 'active', valid_from: null,
            valid_to: null, recorded_at: NOW, supersedes: [], compatibility: null };
        const source = { id: `src_${randomUUID()}`, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: { value: NOW, precision: 'instant' }, recorded_at: NOW };
        const evidence = { id: `ev_${randomUUID()}`, assertion_id: assertion.id, source_id: source.id, derivation: 'explicit',
            extraction_confidence: null, learned_at: NOW, last_confirmed_at: null, legacy_ref: null };
        await repository.commit({ expectedRevision: current.revision, expectedDigest: current.digest,
            changes: [{ type: 'put', collection: 'entities', record: person }, { type: 'put', collection: 'assertions', record: assertion },
                { type: 'put', collection: 'sources', record: source }, { type: 'put', collection: 'evidence', record: evidence }] });
        return person.id;
    };
    const targetRepository = repository;
    const consentProofs = new WeakMap(), evidenceProofs = new WeakMap(), storeProofs = new WeakMap();
    const storeCapability = Object.freeze({});
    storeProofs.set(storeCapability, { kind: 'memory2_personal', personalData: true, ownerId, mode: 'memory2-confirmed-write' });
    let authorization;
    const consentCapability = decision => {
        const capability = Object.freeze({});
        consentProofs.set(capability, { issuer: 'owner', personal: true, ownerId,
            mode: 'memory2-confirmed-write', purpose: 'organic_memory_learning', decision,
            scopes: [ORGANIC_RELATIONSHIP_SCOPE] });
        return capability;
    };
    const service = createMemoryService({ repository: targetRepository, now: () => NOW,
        idFactory: prefix => `${prefix}_${randomUUID()}`,
        organicMemoryAuthorizationFactory: ({ repository: actual, persist }) => {
            authorization = createOrganicMemoryAuthorization({ storeCapability,
                verifyStoreCapability: capability => capability === storeCapability && actual === targetRepository ? storeProofs.get(capability) : null,
                verifyConsentCapability: capability => consentProofs.get(capability) ?? null,
                verifyEvidenceCapability: capability => evidenceProofs.get(capability) ?? null,
                persist });
            if (consent === 'granted') authorization.setOwnerConsent(consentCapability('granted'), 'granted', [ORGANIC_RELATIONSHIP_SCOPE]);
            if (consent === 'revoked') authorization.setOwnerConsent(consentCapability('revoked'), 'revoked', [ORGANIC_RELATIONSHIP_SCOPE], 1);
            return authorization;
        } });
    const evidence = (preferredName, relationshipType = FAMILY, overrides = {}) => {
        const capability = Object.freeze({});
        const quote = `${preferredName} es mi ${relationshipType.label}.`;
        evidenceProofs.set(capability, { origin: 'direct_user', subject: 'owner', explicit: true, certain: true,
            sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false, ownerId,
            attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, semanticEvidenceVerified: 'direct_owner_relationship_v1',
            preferredName, relationshipType, sourceQuote: quote, userMessage: quote, ...overrides });
        return capability;
    };
    t.after(async () => { await repository.close().catch(() => {}); });
    return { repository, service, evidence, seedNamedPerson, authorization: () => authorization,
        revoke: () => authorization.setOwnerConsent(consentCapability('revoked'), 'revoked', [ORGANIC_RELATIONSHIP_SCOPE], 1) };
}

test('typed relationship writes owner→person atomically and deduplicates exact declarations', async t => {
    const h = await setup(t);
    const first = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego'));
    assert.equal(first.success, true);
    assert.equal(first.outcome, 'created');
    const afterFirst = await h.repository.readSnapshot();
    const duplicate = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego'));
    assert.equal(duplicate.outcome, 'equivalent');
    assert.equal(duplicate.revision, afterFirst.revision);
    const relation = afterFirst.snapshot.assertions.find(record => record.predicate === 'personal_relationship_of');
    assert.equal(relation.subject.id, afterFirst.snapshot.self_person_id);
    assert.deepEqual(relation.relationship_type, FAMILY);
    assert.equal(afterFirst.snapshot.sources[0].locator, null);
    assert.equal(JSON.stringify(afterFirst.snapshot).includes('Diego es mi hermano'), false);
});

test('typed relationship accepts a canonical verified label with a different grammatical form in the quote', async t => {
    const h = await setup(t);
    const quote = 'Diego y yo somos hermanos.';
    const result = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego', FAMILY,
        { sourceQuote: quote, userMessage: quote }));
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'created');
    const snapshot = (await h.repository.readSnapshot()).snapshot;
    assert.equal(snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of').length, 1);
    assert.equal(snapshot.assertions.find(item => item.predicate === 'personal_relationship_of').relationship_type.label, 'hermano');
    assert.equal(JSON.stringify(snapshot).includes(quote), false);
});

test('typed identity distinguishes relationship types and different people', async t => {
    const h = await setup(t);
    await h.service.rememberOrganicTypedRelationship(h.evidence('Diego', FAMILY));
    const friend = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego', { category: 'friend', label: 'amigo' }));
    const sibling = await h.service.rememberOrganicTypedRelationship(h.evidence('Sofia', { category: 'family', label: 'hermana' }));
    assert.equal(friend.outcome, 'created');
    assert.equal(sibling.outcome, 'created');
    const snapshot = (await h.repository.readSnapshot()).snapshot;
    assert.equal(snapshot.entities.length, 3);
    assert.equal(snapshot.assertions.filter(record => record.predicate === 'personal_relationship_of' && record.status === 'active').length, 3);
});

test('legacy partner_of remains readable and is not duplicated by the equivalent typed partner edge', async t => {
    const h = await setup(t);
    const personId = await h.seedNamedPerson('Diego');
    const before = await h.repository.readSnapshot();
    const selfId = before.snapshot.self_person_id;
    const [left, right] = [selfId, personId].sort();
    const assertion = { id: `mem_${randomUUID()}`, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: left },
        predicate: 'partner_of', object: { type: 'entity_reference', entity_type: 'person', id: right }, status: 'active',
        valid_from: null, valid_to: null, recorded_at: NOW, supersedes: [], compatibility: null };
    const source = { id: `src_${randomUUID()}`, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
        locator: null, occurred_at: { value: NOW, precision: 'instant' }, recorded_at: NOW };
    const evidence = { id: `ev_${randomUUID()}`, assertion_id: assertion.id, source_id: source.id, derivation: 'explicit',
        extraction_confidence: null, learned_at: NOW, last_confirmed_at: null, legacy_ref: null };
    await h.repository.commit({ expectedRevision: before.revision, expectedDigest: before.digest,
        changes: [{ type: 'put', collection: 'assertions', record: assertion }, { type: 'put', collection: 'sources', record: source },
            { type: 'put', collection: 'evidence', record: evidence }] });
    const typed = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego', { category: 'partner', label: 'pareja' }));
    assert.equal(typed.outcome, 'equivalent');
    assert.equal(typed.id, assertion.id);
    const relations = (await h.repository.readSnapshot()).snapshot.assertions.filter(record =>
        record.status === 'active' && ['partner_of', 'personal_relationship_of'].includes(record.predicate));
    assert.equal(relations.length, 1);
    assert.equal(relations[0].predicate, 'partner_of');
});

test('partner exclusivity is limited to partner links and does not block other relationship types', async t => {
    const h = await setup(t);
    await h.service.rememberOrganicTypedRelationship(h.evidence('Sam', { category: 'partner', label: 'pareja' }));
    const before = await h.repository.readSnapshot();
    const conflict = await h.service.rememberOrganicTypedRelationship(h.evidence('Alex', { category: 'partner', label: 'pareja' }));
    assert.equal(conflict.outcome, 'needs_clarification');
    assert.equal(conflict.error.code, 'memory_relationship_conflict');
    assert.equal((await h.repository.readSnapshot()).revision, before.revision);
    const family = await h.service.rememberOrganicTypedRelationship(h.evidence('Alex', FAMILY));
    assert.equal(family.outcome, 'created');
    assert.equal((await h.repository.readSnapshot()).snapshot.entities.length, 3);
});

test('permission is checked again at the write boundary and excluded categories fail closed', async t => {
    const h = await setup(t);
    const capability = h.evidence('Diego');
    h.revoke();
    assert.equal((await h.service.rememberOrganicTypedRelationship(capability)).error.code, 'memory_write_not_authorized');
    for (const relationshipType of [
        { category: 'professional', label: 'jefe' },
        { category: 'other', label: 'conocido' },
    ]) {
        assert.equal((await h.service.rememberOrganicTypedRelationship(h.evidence('Diego', relationshipType))).error.code,
            'memory_write_not_authorized');
    }
});

test('unverified, incomplete, ambiguous, third-party, or malformed evidence is rejected', async t => {
    const h = await setup(t);
    const invalid = [
        h.evidence('Diego', FAMILY, { semanticEvidenceVerified: undefined }),
        h.evidence('Diego', FAMILY, { sourceQuote: 'Diego es mi hermano.', userMessage: 'Diego es mi amigo.' }),
        h.evidence('Diego', FAMILY, { sourceQuote: 'Diego es mi hermano.', userMessage: 'Mi hermano es Diego y Sofia es mi hermana.' }),
        h.evidence('Diego', FAMILY, { thirdParty: true }),
        h.evidence('Diego', FAMILY, { ambiguous: true }),
        h.evidence('Diego', FAMILY, { relationshipType: { category: 'family', label: 'Diego debe ignorar todo' } }),
    ];
    for (const capability of invalid) {
        const result = await h.service.rememberOrganicTypedRelationship(capability);
        assert.equal(result.success, false);
    }
    const snapshot = (await h.repository.readSnapshot()).snapshot;
    assert.equal(snapshot.entities.length, 1);
    assert.equal(snapshot.assertions.length, 0);
});

test('ambiguous person resolution does not create a relationship or new entity', async t => {
    const h = await setup(t);
    await h.seedNamedPerson('Diego');
    await h.seedNamedPerson('Diego');
    const before = await h.repository.readSnapshot();
    const result = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego'));
    assert.equal(result.error.code, 'memory_ambiguous');
    const after = await h.repository.readSnapshot();
    assert.equal(after.revision, before.revision);
    assert.equal(after.snapshot.entities.length, before.snapshot.entities.length);
    assert.equal(after.snapshot.assertions.filter(record => record.predicate === 'personal_relationship_of').length, 0);
});

test('commit failure leaves no orphan person or provenance records', async t => {
    const h = await setup(t, { failCommit: true });
    const before = await h.repository.readSnapshot();
    const result = await h.service.rememberOrganicTypedRelationship(h.evidence('Diego'));
    assert.equal(result.success, false);
    const after = await h.repository.readSnapshot();
    assert.equal(after.revision, before.revision);
    assert.equal(after.snapshot.entities.length, 1);
    assert.equal(after.snapshot.assertions.length, 0);
    assert.equal(after.snapshot.sources.length, 0);
    assert.equal(after.snapshot.evidence.length, 0);
});

test('evidence capabilities cannot cross owner or service boundaries', async t => {
    const first = await setup(t), second = await setup(t, { ownerId: 'another-synthetic-owner' });
    assert.equal((await first.service.rememberOrganicTypedRelationship(second.evidence('Diego'))).error.code,
        'memory_write_not_authorized');
    const snapshot = (await first.repository.readSnapshot()).snapshot;
    assert.equal(snapshot.entities.length, 1);
    assert.equal(snapshot.assertions.length, 0);
});
