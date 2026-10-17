import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createOrganicMemoryAuthorization, ORGANIC_RELATIONSHIP_ATTRIBUTE, ORGANIC_RELATIONSHIP_SCOPE,
    parseDirectOwnerPartnerStatement } from '../src/core/organic-memory-authorization.js';
import { initializeEmptyMemoryStore } from '../src/memory/backend.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { createMemoryService } from '../src/memory/service.js';

const quote = 'Alex es mi pareja.';
const ownerId = 'synthetic-owner';

async function setup({ consent = 'granted', failCommit = false } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-organic-relation-'));
    const storePath = path.join(directory, 'memory-v2.json');
    await initializeEmptyMemoryStore({ storePath });
    const repository = createJsonMemoryRepository({ storePath });
    await repository.open();
    const repositoryForService = failCommit ? { ...repository, commit: async () => { throw new Error('synthetic_commit_failure'); } } : repository;
    const consentProofs = new WeakMap(), evidenceProofs = new WeakMap(), storeProofs = new WeakMap();
    const storeCapability = Object.freeze({});
    storeProofs.set(storeCapability, { kind: 'memory2_personal', personalData: true, ownerId, mode: 'memory2-confirmed-write' });
    let authorization;
    const consentScopes = [ORGANIC_RELATIONSHIP_SCOPE];
    const factory = ({ repository: target, persist }) => {
        const auth = createOrganicMemoryAuthorization({ storeCapability,
            verifyStoreCapability: cap => cap === storeCapability && target === repositoryForService
                ? storeProofs.get(cap) : null,
            verifyConsentCapability: cap => consentProofs.get(cap) ?? null,
            verifyEvidenceCapability: cap => evidenceProofs.get(cap) ?? null,
            persist,
        });
        authorization = auth;
        const grant = Object.freeze({});
        consentProofs.set(grant, { issuer: 'owner', personal: true, ownerId, mode: 'memory2-confirmed-write',
            purpose: 'organic_memory_learning', decision: 'granted', scopes: consentScopes });
        if (consent === 'granted') auth.setOwnerConsent(grant, 'granted', consentScopes);
        if (consent === 'revoked') {
            const revoked = Object.freeze({});
            consentProofs.set(revoked, { issuer: 'owner', personal: true, ownerId, mode: 'memory2-confirmed-write',
                purpose: 'organic_memory_learning', decision: 'revoked', scopes: consentScopes });
            auth.setOwnerConsent(revoked, 'revoked', consentScopes, 1);
        }
        return auth;
    };
    const service = createMemoryService({ repository: repositoryForService, now: () => '2034-02-03T04:05:06.000Z',
        idFactory: prefix => `${prefix}_${randomUUID()}`, organicMemoryAuthorizationFactory: factory });
    const evidence = (sourceQuote = quote, overrides = {}) => {
        const capability = Object.freeze({});
        evidenceProofs.set(capability, { origin: 'direct_user', subject: 'owner', explicit: true, certain: true,
            sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false, ownerId,
            attribute: ORGANIC_RELATIONSHIP_ATTRIBUTE, preferredName: 'Alex', sourceQuote,
            userMessage: `Remember this: ${sourceQuote}`, ...overrides });
        return capability;
    };
    return { directory, repository, service, evidence, getAuthorization: () => authorization,
        close: async () => { await repository.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); } };
}

test('direct owner-partner statement parser rejects inference and third-party statements', () => {
    assert.deepEqual(parseDirectOwnerPartnerStatement('Alex es mi pareja.'), { preferredName: 'Alex' });
    assert.deepEqual(parseDirectOwnerPartnerStatement('Mi pareja se llama Alex'), { preferredName: 'Alex' });
    assert.equal(parseDirectOwnerPartnerStatement('Alex es la pareja de Sam'), null);
    assert.equal(parseDirectOwnerPartnerStatement('Creo que Alex podría ser mi pareja'), null);
    assert.equal(parseDirectOwnerPartnerStatement('Alex es mi pareja y le gusta el verde'), null);
});

test('persists a self relationship and a new person in one commit without storing the quote', async t => {
    const h = await setup(); t.after(h.close);
    const result = await h.service.rememberOrganicRelationship(h.evidence());
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'created');
    const snapshot = await h.repository.readSnapshot();
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.snapshot.entities.length, 2);
    assert.equal(snapshot.snapshot.assertions.length, 2);
    assert.equal(snapshot.snapshot.assertions.find(item => item.predicate === 'partner_of').predicate, 'partner_of');
    assert.equal(snapshot.snapshot.evidence.every(item => item.derivation === 'explicit'), true);
    assert.equal(snapshot.snapshot.sources.length, 1);
    assert.equal(snapshot.snapshot.sources[0].locator, null);
    assert.equal(JSON.stringify(snapshot.snapshot).includes(quote), false);
});

test('equivalent relationship is idempotent and active different partner requires clarification without orphan creation', async t => {
    const h = await setup(); t.after(h.close);
    const first = await h.service.rememberOrganicRelationship(h.evidence());
    const revision = (await h.repository.readSnapshot()).revision;
    const duplicate = await h.service.rememberOrganicRelationship(h.evidence());
    assert.equal(duplicate.outcome, 'equivalent');
    assert.equal((await h.repository.readSnapshot()).revision, revision);
    const conflict = await h.service.rememberOrganicRelationship(h.evidence('Sam es mi pareja.', { preferredName: 'Sam' }));
    assert.equal(conflict.outcome, 'needs_clarification');
    assert.equal(conflict.error.code, 'memory_relationship_conflict');
    const snapshot = (await h.repository.readSnapshot()).snapshot;
    assert.equal(snapshot.entities.length, 2);
    assert.equal(snapshot.assertions.filter(item => item.predicate === 'partner_of' && item.status === 'active').length, 1);
    assert.equal(first.success, true);
});

test('missing or revoked permission and non-verifiable or third-party evidence fail closed', async t => {
    for (const consent of ['absent', 'revoked']) {
        const h = await setup({ consent }); t.after(h.close);
        assert.equal((await h.service.rememberOrganicRelationship(h.evidence())).error.code, 'memory_write_not_authorized');
    }
    const h = await setup(); t.after(h.close);
    assert.equal((await h.service.rememberOrganicRelationship(h.evidence('Maybe Alex is my partner.'))).error.code, 'memory_invalid_input');
    assert.equal((await h.service.rememberOrganicRelationship(h.evidence(quote, { thirdParty: true }))).error.code, 'memory_write_not_authorized');
    assert.equal((await h.service.rememberOrganicRelationship(h.evidence(quote, { userMessage: 'Different message' }))).error.code, 'memory_write_not_authorized');
});

test('commit failure leaves no person, assertion, source, or evidence records', async t => {
    const h = await setup({ failCommit: true }); t.after(h.close);
    const before = await h.repository.readSnapshot();
    const result = await h.service.rememberOrganicRelationship(h.evidence());
    assert.equal(result.success, false);
    const after = await h.repository.readSnapshot();
    assert.equal(after.revision, before.revision);
    assert.equal(after.snapshot.entities.length, 1);
    assert.equal(after.snapshot.assertions.length, 0);
    assert.equal(after.snapshot.sources.length, 0);
    assert.equal(after.snapshot.evidence.length, 0);
});

test('evidence capability issued for another owner/service is rejected', async t => {
    const a = await setup(); const b = await setup(); t.after(a.close); t.after(b.close);
    assert.equal((await a.service.rememberOrganicRelationship(b.evidence())).error.code, 'memory_write_not_authorized');
});
