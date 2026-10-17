import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { createOrganicMemoryAuthorization, ORGANIC_THIRD_PARTY_SCOPE } from '../src/core/organic-memory-authorization.js';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { SCHEMA_VERSION, validateMemoryStore } from '../src/memory/schema.js';

const now = '2035-02-03T04:05:06.000Z';
const id = prefix => `${prefix}_${randomUUID()}`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixtureEmbeddings = Object.freeze({ model: 'synthetic-third-party-v1',
    async embedMany(texts) { return texts.map(() => [1, 0]); } });
const contextProvider = (h) => createMemoryContextProvider({ repository: h.repository,
    embeddings: fixtureEmbeddings, authorizeSubject: h.authorizeSubject,
    authorizeRelationships: h.authorizeRelationships });
const fact = (quote, name, attribute, value, overrides = {}) => ({ sourceQuote: quote, subjectName: name,
    subjectReference: '', attribute, value, confidence: 'high', certainty: 'explicit', subject: 'third_party',
    temporal: 'current', validity: 'current', priorAssertionId: '', sensitivity: 'none', ambiguous: false, thirdParty: true,
    hypothetical: false, futureIntent: false, ...overrides });
const response = (facts, relationshipTool = false) => ({ status: 'completed', output: [{ type: 'function_call',
    name: 'propose_organic_memory_facts', call_id: 'synthetic',
    arguments: JSON.stringify(relationshipTool ? { facts, relationships: [] } : { facts }) }] });

function fixture({ names = ['Coti'], relationship = null, enabled = true, failCommit = false,
    revokeAtEvidence = false, relationshipLearningEnabled = false } = {}) {
    let store = { schema_version: SCHEMA_VERSION, store_id: id('store'), self_person_id: id('person'),
        revision: 0, created_at: now, updated_at: now, entities: [], assertions: [], sources: [],
        evidence: [], migrations: [], automatic_operations: [] };
    store.entities.push({ id: store.self_person_id, type: 'person', created_at: now });
    const people = [];
    for (const name of names) {
        const personId = id('person'), assertionId = id('mem'), sourceId = id('src');
        people.push({ id: personId, name });
        store.entities.push({ id: personId, type: 'person', created_at: now });
        store.assertions.push({ id: assertionId, kind: 'fact', subject: { type: 'entity', entity_type: 'person', id: personId },
            predicate: 'entity.preferred_name', object: { type: 'text', value: name }, status: 'active',
            valid_from: null, valid_to: null, recorded_at: now, supersedes: [], compatibility: null });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: { value: now, precision: 'instant' }, recorded_at: now });
        store.evidence.push({ id: id('ev'), assertion_id: assertionId, source_id: sourceId,
            derivation: 'explicit', extraction_confidence: null, learned_at: now, last_confirmed_at: null, legacy_ref: null });
    }
    for (const relation of (Array.isArray(relationship) ? relationship : relationship ? [relationship] : [])) {
        const person = people.find(item => item.name === relation.name);
        if (!person) throw new Error('missing_synthetic_person');
        const assertionId = id('mem'), sourceId = id('src');
        store.assertions.push({ id: assertionId, kind: 'fact',
            subject: { type: 'entity', entity_type: 'person', id: store.self_person_id },
            predicate: 'personal_relationship_of',
            object: { type: 'entity_reference', entity_type: 'person', id: person.id },
            relationship_type: { category: relation.label === 'pareja' ? 'partner' : 'family', label: relation.label }, status: 'active',
            valid_from: null, valid_to: null, recorded_at: now, supersedes: [], compatibility: null });
        store.sources.push({ id: sourceId, kind: 'user_statement', origin_trust: 'user_asserted', authority: 'data_only',
            locator: null, occurred_at: { value: now, precision: 'instant' }, recorded_at: now });
        store.evidence.push({ id: id('ev'), assertion_id: assertionId, source_id: sourceId,
            derivation: 'explicit', extraction_confidence: null, learned_at: now, last_confirmed_at: null, legacy_ref: null });
    }
    validateMemoryStore(store);
    let currentDigest = digest(store);
    const repository = { open: async () => {}, close: async () => {},
        readSnapshot: async () => ({ snapshot: structuredClone(store), revision: store.revision, digest: currentDigest }),
        commit: async request => {
            if (failCommit) throw new Error('synthetic_failure');
            assert.equal(request.expectedRevision, store.revision);
            assert.equal(request.expectedDigest, currentDigest);
            const next = structuredClone(store);
            for (const change of request.changes) {
                assert.equal(change.type, 'put');
                const collection = next[change.collection];
                const index = collection.findIndex(item => item.id === change.record.id);
                if (index < 0) collection.push(structuredClone(change.record));
                else collection[index] = structuredClone(change.record);
            }
            next.revision++; next.updated_at = now;
            validateMemoryStore(next);
            store = next; currentDigest = digest(next);
            return { snapshot: structuredClone(store), revision: store.revision, digest: currentDigest };
        } };
    const consentProofs = new WeakMap(), evidenceProofs = new WeakMap();
    let authorization;
    let thirdPartyEnabled = enabled;
    const ownerId = 'synthetic-owner';
    const scopes = () => ['tool_preferences', ...(thirdPartyEnabled ? [ORGANIC_THIRD_PARTY_SCOPE] : [])];
    const grant = () => {
        const capability = Object.freeze(Object.create(null));
        consentProofs.set(capability, { issuer: 'owner', personal: true, ownerId,
            mode: 'memory2-confirmed-write', purpose: 'organic_memory_learning', decision: 'granted', scopes: scopes() });
        authorization.setOwnerConsent(capability, 'granted', scopes());
    };
    const authorizationFactory = ({ repository: actual, persist }) => {
        assert.equal(actual, repository);
        const storeCapability = Object.freeze(Object.create(null));
        authorization = createOrganicMemoryAuthorization({ storeCapability,
            verifyStoreCapability: capability => capability === storeCapability
                ? { kind: 'memory2_personal', personalData: true, ownerId, mode: 'memory2-confirmed-write' } : null,
            verifyConsentCapability: capability => consentProofs.get(capability) ?? null,
            verifyEvidenceCapability: capability => evidenceProofs.get(capability) ?? null, persist });
        grant();
        return authorization;
    };
    let candidates = [];
    let lastExtractedCandidates = null;
    const verificationOutcomes = new Map();
    let extractFromRequest = null;
    const requests = [];
    const ask = async request => {
        requests.push(request);
        if (request.tools?.some(tool => tool.name === 'verify_organic_memory_facts')) {
            const input = JSON.parse(request.input[0].content);
            return { status: 'completed', output: [{ type: 'function_call', name: 'verify_organic_memory_facts',
                call_id: 'verify-synthetic', arguments: JSON.stringify({ decisions: input.candidates.map((candidate, candidateIndex) => {
                    const source = (lastExtractedCandidates ?? candidates).find(item => item.sourceQuote === candidate.quote
                        && item.value === candidate.proposedFact && item.attribute === candidate.topicKey);
                    const checks = { supported: Boolean(source), explicit: source?.certainty === 'explicit',
                        subjectMatches: source?.subject === input.candidates[candidateIndex].subject,
                        temporalMatches: Boolean(source), nonSensitive: source?.sensitivity === 'none',
                        unambiguous: source?.ambiguous === false,
                        ...(verificationOutcomes.get(candidate.quote) ?? {}) };
                    return { candidateIndex, decision: Object.values(checks).every(Boolean) ? 'approved' : 'rejected', ...checks,
                        correctedValue: '', correctedAttribute: '', correctedTemporal: source?.temporal ?? 'current',
                        correctedValidity: source?.validity ?? 'current' };
                }) }) }] };
        }
        if (request.toolChoice === 'required') {
            assert.ok(request.input.length === 1 || request.input.length === 2);
            assert.equal(request.input.at(-1).role, 'user');
            if (request.input.length === 2) {
                const hintItem = request.input.find(item => item?.role === 'user'
                    && typeof item.content === 'string' && item.content.includes('['));
                const hints = JSON.parse(hintItem.content.match(/(\[[\s\S]*\])\s*$/u)[1]);
                assert.ok(hints.length <= 12);
                assert.ok(hints.every(item => Object.keys(item).join(',') === 'assertionId,attribute,statement'));
            }
            const hintItem = request.input.find(item => item?.role === 'user'
                && typeof item.content === 'string' && item.content.includes('['));
            let activeHints = [];
            try { activeHints = hintItem ? JSON.parse(hintItem.content.match(/(\[[\s\S]*\])\s*$/u)?.[1] ?? '[]') : []; }
            catch { activeHints = []; }
            const extracted = (extractFromRequest ? extractFromRequest(request) : candidates).map(item => item.priorStatement
                && !item.priorAssertionId ? { ...item, priorAssertionId: activeHints.find(hint => hint.statement === item.priorStatement)?.assertionId ?? '' }
                : item);
            lastExtractedCandidates = extracted;
            return response(extracted,
                request.tools[0].name === 'propose_organic_memory_facts' && request.tools[0].parameters.required.includes('relationships'));
        }
        return { status: 'completed', output_text: 'Entendido.', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'Entendido.' }] }] };
    };
    const thirdPartyEvidence = evidence => {
        const capability = Object.freeze(Object.create(null));
        evidenceProofs.set(capability, { ...evidence, ownerId });
        if (revokeAtEvidence) { thirdPartyEnabled = false; grant(); }
        return capability;
    };
    const diagnostics = [];
    const create = ({ initialConversationHistory = [] } = {}) => createAgent({ memoryBackend: 'memory2', memory2Repository: repository,
        memoryContextProvider: createMemoryContextProvider({ repository, embeddings: fixtureEmbeddings,
            authorizeSubject: subjectId => thirdPartyEnabled && people.some(person => person.id === subjectId),
            authorizeRelationships: () => relationshipLearningEnabled }),
        operationalMemoryMode: 'memory2-confirmed-write', enableConfirmedMemoryWrites: true,
        enableOrganicMemoryLearning: true, deferOrganicMemoryLearning: true,
        organicMemoryAuthorizationFactory: authorizationFactory,
        organicEvidenceCapabilityFactory: () => null,
        organicThirdPartyEvidenceCapabilityFactory: thirdPartyEvidence,
        isOrganicThirdPartyLearningEnabled: () => thirdPartyEnabled,
        organicRelationshipEvidenceCapabilityFactory: () => null,
        isOrganicRelationshipLearningEnabled: () => relationshipLearningEnabled,
        logger: (event, details) => diagnostics.push({ event, ...details }),
        getTools: () => [], execute: async () => { throw new Error('external_tool_forbidden'); }, ask,
        initialConversationHistory });
    return { create, people, repository, requests, setCandidates: value => { candidates = value; },
        setExtractor: value => { extractFromRequest = value; },
        setVerificationOutcome: (quote, decision) => { verificationOutcomes.set(quote, decision); },
        setEnabled: value => { thirdPartyEnabled = value; grant(); },
        authorizeSubject: subjectId => thirdPartyEnabled && people.some(person => person.id === subjectId),
        authorizeRelationships: () => relationshipLearningEnabled,
        diagnostics, getStore: () => structuredClone(store) };
}

async function assess(h, message, candidates) {
    h.setCandidates(candidates);
    const agent = await h.create();
    try { return await agent.assessOrganicMessage(message); }
    finally { await agent.close(); }
}

test('known third-party fact is attributed to the existing person and recovered by name', async () => {
    const h = fixture({ relationship: { name: 'Coti', label: 'pareja' } });
    const quote = 'Coti es arquitecta.';
    const result = await assess(h, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    assert.equal(result.persistedCount, 1);
    const verificationDiagnostic = h.diagnostics.find(item => item.event === 'organic_memory_fact_verification');
    assert.equal(verificationDiagnostic.thirdPartyCandidateCount, 1);
    assert.equal(verificationDiagnostic.thirdPartyLearningEnabled, true);
    assert.equal(h.diagnostics.find(item => item.event === 'organic_memory_evaluation')
        .thirdPartyLearningEnabledAtCandidateValidation, true);
    assert.doesNotMatch(JSON.stringify(verificationDiagnostic), /Coti|arquitecta/u);
    const assessment = h.requests.find(request => request.toolChoice === 'required');
    assert.match(assessment.instructions, /Runtime comprobará que exista una única identidad/u);
    assert.match(assessment.instructions, /hechos cotidianos no sensibles de cualquier tema/u);
    assert.deepEqual(assessment.input, [{ role: 'user', content: quote }]);
    const record = h.getStore().assertions.find(item => item.compatibility?.key === 'biography.occupation');
    assert.equal(record.subject.id, h.people[0].id);
    assert.notEqual(record.subject.id, h.getStore().self_person_id);
    const provider = contextProvider(h);
    const context = await provider.read({ message: '¿A qué se dedica Coti?' });
    assert.ok(context.items.some(item => item.output?.includes('arquitecta')));
});

test('organic diagnostics report third-party permission state without personal payloads', async () => {
    const quote = 'Coti es arquitecta.';
    const enabled = fixture({ relationship: { name: 'Coti', label: 'pareja' } });
    await assess(enabled, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    const verification = enabled.diagnostics.find(item => item.event === 'organic_memory_fact_verification');
    assert.equal(verification?.thirdPartyLearningEnabled, true);
    assert.equal(verification?.thirdPartyCandidateCount, 1);
    assert.doesNotMatch(JSON.stringify(verification), /Coti|arquitecta/u);

    const disabled = fixture({ relationship: { name: 'Coti', label: 'pareja' }, enabled: false });
    await assess(disabled, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    const evaluation = disabled.diagnostics.find(item => item.event === 'organic_memory_evaluation');
    assert.equal(evaluation?.thirdPartyLearningEnabledAtCandidateValidation, false);
    assert.equal(evaluation?.rejectionCodes.third_party_ineligible, 1);
    assert.doesNotMatch(JSON.stringify(evaluation), /Coti|arquitecta/u);
});

test('a new everyday fact about a uniquely known person uses the existing third-party permission', async () => {
    const h = fixture({ relationship: { name: 'Coti', label: 'pareja' }, relationshipLearningEnabled: true });
    const quote = 'Coti utiliza AutoCAD para trabajar.';
    const result = await assess(h, quote, [fact(quote, 'Coti', 'general.work_tool', 'utiliza AutoCAD para trabajar')]);
    assert.equal(result.persistedCount, 1);
    const record = h.getStore().assertions.find(item => item.compatibility?.key === 'general.work_tool');
    assert.equal(record.subject.id, h.people[0].id);
    assert.equal(record.object.value, 'utiliza AutoCAD para trabajar');
    const context = await contextProvider(h)
        .read({ message: '¿Qué utiliza Coti para trabajar?' });
    assert.ok(context.items.some(item => item.output?.includes('utiliza AutoCAD para trabajar')));
    const indirect = await contextProvider(h)
        .read({ message: 'Quiero regalarle algo relacionado con su trabajo.' });
    assert.equal(indirect.items.length, 0,
        'the deterministic pre-response read path does not infer a third-party identity from a pronoun');
    const semanticallySearched = await contextProvider(h).search({ query: '¿Qué programa usa en su ocupación?',
        subjectId: h.people[0].id });
    assert.ok(semanticallySearched.assertions.some(item => item.object?.value === 'utiliza AutoCAD para trabajar'));

    const disabled = fixture({ relationship: { name: 'Coti', label: 'pareja' }, enabled: false });
    const denied = await assess(disabled, quote, [fact(quote, 'Coti', 'general.work_tool', 'utiliza AutoCAD para trabajar')]);
    assert.equal(denied.persistedCount, 0);
    assert.equal(disabled.diagnostics.find(item => item.event === 'organic_memory_evaluation')
        .thirdPartyLearningEnabledAtCandidateValidation, false);
    assert.equal(disabled.getStore().assertions.some(item => item.compatibility?.key === 'general.work_tool'), false);
});

test('known person selects one focused extractor request after the general extractor would return no candidates', async () => {
    const h = fixture({ relationship: { name: 'Coti', label: 'pareja' }, relationshipLearningEnabled: true });
    const quote = 'Coti es arquitecta.';
    const candidate = fact(quote, 'Coti', 'biography.occupation', 'arquitecta');
    h.setExtractor(request => request.tools[0].description.startsWith('Extract explicit current facts')
        ? [candidate] : []);
    const result = await assess(h, quote, []);
    assert.equal(result.proposedCount, 1, JSON.stringify({
        result,
        requestCount: h.requests.length,
        requestKind: h.requests[0]?.tools?.[0]?.description.startsWith('Extract explicit current facts')
            ? 'focused_third_party' : 'general',
        events: h.diagnostics.map(item => ({ event: item.event, stage: item.stage, status: item.status,
            outcome: item.outcome, code: item.code, reason: item.reason,
            proposedCount: item.proposedCount, rejectedCount: item.rejectedCount })),
    }));
    assert.equal(result.persistedCount, 1);
    assert.equal(h.requests.filter(request => request.tools?.some(tool => tool.name === 'propose_organic_memory_facts')).length,
        1, 'the existing extractor makes one proposal request');
    assert.equal(h.requests.filter(request => request.tools?.some(tool => tool.name === 'verify_organic_memory_facts')).length,
        1, 'the separate semantic verifier is still required');
    assert.match(h.requests[0].tools[0].parameters.properties.facts.description,
        /For a direct non-sensitive statement about the known named person/u);
    assert.ok(h.requests[0].tools[0].parameters.required.includes('relationships'));
    assert.deepEqual(h.requests[0].input, [{ role: 'user', content: quote }]);
    const record = h.getStore().assertions.find(item => item.compatibility?.key === 'biography.occupation');
    assert.equal(record.subject.id, h.people[0].id);
    assert.notEqual(record.subject.id, h.getStore().self_person_id);
    const freshConversationContext = await contextProvider(h)
        .read({ message: '¿A qué se dedica Coti?' });
    assert.ok(freshConversationContext.items.some(item => item.output?.includes('arquitecta')));
    const repeat = await assess(h, quote, []);
    assert.equal(repeat.unchangedCount, 1);
    assert.equal(h.getStore().assertions.filter(item => item.compatibility?.key === 'biography.occupation').length, 1);
});

for (const [label, names] of [['unknown', ['Alex']], ['ambiguous', ['Coti', 'Coti']]])
    test(`${label} person does not select the focused extraction contract`, async () => {
        const h = fixture({ names });
        const quote = 'Coti es arquitecta.';
        h.setExtractor(request => request.tools[0].description.startsWith('Extract explicit current facts')
            ? [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')] : []);
        const result = await assess(h, quote, []);
        assert.equal(result.proposedCount, 0);
        assert.equal(result.persistedCount, 0);
        assert.equal(h.requests.length, 1);
        assert.equal(h.requests[0].tools[0].description.startsWith('Extract explicit current facts'), false);
    });

test('disabled third-party permission never selects the focused extraction contract', async () => {
    const h = fixture({ enabled: false });
    const quote = 'Coti es arquitecta.';
    h.setExtractor(request => request.tools[0].description.startsWith('Extract explicit current facts')
        ? [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')] : []);
    const result = await assess(h, quote, []);
    assert.equal(result.persistedCount, 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].tools[0].description.startsWith('Extract explicit current facts'), false);
});

test('focused extraction keeps an empty proposal empty and never treats it as write authorization', async () => {
    const h = fixture({ relationship: { name: 'Coti', label: 'pareja' } });
    const quote = 'Coti llegó temprano.';
    h.setExtractor(() => []);
    const result = await assess(h, quote, []);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].tools[0].description.startsWith('Extract explicit current facts'), true);
    assert.equal(result.proposedCount, 0);
    assert.equal(result.persistedCount, 0);
    assert.equal(h.getStore().assertions.filter(item => item.compatibility).length, 0);
});

for (const quote of ['Creo que Coti podría ser arquitecta.', '¿Coti es arquitecta?'])
    test(`non-assertion ${quote} never persists a third-party profession`, async () => {
        const h = fixture({ relationship: { name: 'Coti', label: 'pareja' } });
        h.setVerificationOutcome(quote, { explicit: false });
        h.setExtractor(() => [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
        const result = await assess(h, quote, []);
        assert.equal(result.persistedCount ?? 0, 0);
        assert.equal(h.getStore().assertions.filter(item => item.compatibility).length, 0);
    });

for (const [label, names, quote, name, value] of [
    ['unknown name', ['Coti'], 'Martín toca la guitarra.', 'Martín', 'la guitarra'],
    ['homonym', ['Martín', 'Martín'], 'Martín toca la guitarra.', 'Martín', 'la guitarra'],
]) test(`${label} abstains without creating a person`, async () => {
    const h = fixture({ names });
    const before = h.getStore().entities.length;
    const result = await assess(h, quote, [fact(quote, name, 'hobby.instrument_guitar', value)]);
    assert.equal(result.persistedCount ?? 0, 0);
    assert.equal(h.getStore().entities.length, before);
});

test('relationship reference writes only when one existing related person is identified and is searchable after resolution', async () => {
    const h = fixture({ names: ['Alex'], relationship: { name: 'Alex', label: 'hermano' }, relationshipLearningEnabled: true });
    const quote = 'Mi hermano estudia ingeniería.';
    const result = await assess(h, quote, [fact(quote, '', 'biography.studies', 'ingeniería',
        { subjectReference: 'hermano' })]);
    assert.equal(result.persistedCount, 1);
    assert.equal(h.getStore().assertions.find(item => item.compatibility?.key === 'biography.studies').subject.id, h.people[0].id);
    const searched = await contextProvider(h).search({ query: '¿Qué formación cursa?', subjectId: h.people[0].id });
    assert.ok(searched.assertions.some(item => item.object?.value === 'ingeniería'));
});

test('an existing unique partner keeps semantic search scoped to the resolved person', async () => {
    const h = fixture({ names: ['Coti', 'Martín'], relationship: { name: 'Coti', label: 'pareja' }, relationshipLearningEnabled: true });
    const quote = 'Coti trabaja en un estudio de arquitectura.';
    assert.equal((await assess(h, quote, [fact(quote, 'Coti', 'biography.workplace', 'un estudio de arquitectura')])).persistedCount, 1);
    const searched = await contextProvider(h).search({ query: '¿Cuál es su ámbito laboral?', subjectId: h.people[0].id });
    assert.ok(searched.assertions.some(item => item.object?.value === 'un estudio de arquitectura'));
    assert.ok(!searched.assertions.some(item => item.object?.value === 'ingeniero'));
});

test('a relational reference without an existing edge abstains', async () => {
    const h = fixture({ names: ['Coti'] });
    const quote = 'Mi hermano estudia ingeniería.';
    const result = await assess(h, quote, [fact(quote, '', 'biography.studies', 'ingeniería',
        { subjectReference: 'hermano' })]);
    assert.equal(result.persistedCount ?? 0, 0);
});

test('two matching relatives cannot resolve a relational reference or leak either person into indirect context', async () => {
    const h = fixture({ names: ['Alex', 'Martín'], relationship: [
        { name: 'Alex', label: 'hermano' }, { name: 'Martín', label: 'hermano' }] });
    const quote = 'Mi hermano estudia ingeniería.';
    const result = await assess(h, quote, [fact(quote, '', 'biography.studies', 'ingeniería',
        { subjectReference: 'hermano' })]);
    assert.equal(result.persistedCount ?? 0, 0);
    const provider = contextProvider(h);
    const context = await provider.read({ message: '¿Qué estudia mi hermano?' });
    assert.equal(context.items.length, 0);
});

test('third-party facts remain isolated across people and attributes', async () => {
    const h = fixture({ names: ['Coti', 'Martín'] });
    const cases = [
        ['Coti es arquitecta.', 'Coti', 'biography.occupation', 'arquitecta'],
        ['Martín es ingeniero.', 'Martín', 'biography.occupation', 'ingeniero'],
        ['Coti toca el piano.', 'Coti', 'hobby.instrument_piano', 'el piano'],
    ];
    for (const [quote, name, attribute, value] of cases) {
        assert.equal((await assess(h, quote, [fact(quote, name, attribute, value)])).persistedCount, 1);
        if (name === 'Martín') {
            const input = h.requests.filter(request => request.toolChoice === 'required').at(-1).input;
            assert.equal(input.length, 1, 'another person’s memories are not sent as comparison hints');
        }
    }
    const cotiCorrection = 'Coti es diseñadora.';
    const correctionResult = await assess(h, cotiCorrection, [fact(cotiCorrection, 'Coti', 'biography.occupation', 'diseñadora',
        { priorStatement: 'arquitecta' })]);
    assert.equal(correctionResult.persistedCount, 1, JSON.stringify(h.diagnostics));
    const rows = h.getStore().assertions.filter(item => item.compatibility);
    assert.equal(rows.filter(item => item.status === 'active').length, 3);
    assert.equal(rows.find(item => item.object.value === 'ingeniero').status, 'active');
    assert.equal(rows.find(item => item.object.value === 'el piano').status, 'active');
    assert.equal(rows.find(item => item.object.value === 'arquitecta').status, 'superseded');
    const provider = contextProvider(h);
    const current = await provider.read({ message: '¿A qué se dedica Coti?' });
    assert.ok(current.items.some(item => item.output?.includes('diseñadora')));
    assert.ok(!current.items.some(item => item.output?.includes('arquitecta')));
    const historical = await provider.search({ query: '¿Cuál era su ocupación anterior?', temporal: 'history',
        subjectId: h.people[0].id });
    assert.ok(historical.assertions.some(item => item.object?.value === 'arquitecta'));
});

test('two people can receive the same attribute in one turn without deduplication across subjects', async () => {
    const h = fixture({ names: ['Coti', 'Martín'] });
    const first = 'Coti es arquitecta.', second = 'Martín es ingeniero.';
    const result = await assess(h, `${first} ${second}`, [
        fact(first, 'Coti', 'biography.occupation', 'arquitecta'),
        fact(second, 'Martín', 'biography.occupation', 'ingeniero'),
    ]);
    assert.equal(result.persistedCount, 2);
    const rows = h.getStore().assertions.filter(item => item.compatibility?.key === 'biography.occupation');
    assert.deepEqual(new Set(rows.map(item => item.subject.id)), new Set(h.people.map(item => item.id)));
});

test('a partial name cannot identify a person even if it has one prefix match', async () => {
    const h = fixture({ names: ['Coti Azul'] });
    const quote = 'Coti es arquitecta.';
    const result = await assess(h, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    assert.equal(result.persistedCount ?? 0, 0);
    assert.equal(h.getStore().assertions.filter(item => item.compatibility).length, 0);
});

test('revocation before writing prevents a third-party fact', async () => {
    const h = fixture({ revokeAtEvidence: true });
    const quote = 'Coti es arquitecta.';
    const result = await assess(h, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    assert.equal(result.persistedCount ?? 0, 0);
    assert.equal(h.getStore().assertions.filter(item => item.compatibility?.key === 'biography.occupation').length, 0);
});

test('third-party permission off blocks proposal while relationship records remain readable', async () => {
    const h = fixture({ enabled: false, relationship: { name: 'Coti', label: 'hermana' } });
    const quote = 'Coti es arquitecta.';
    const result = await assess(h, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    assert.equal(result.persistedCount, 0);
    assert.equal(h.getStore().assertions.filter(item => item.predicate === 'personal_relationship_of').length, 1);
});

test('duplicate fact is idempotent and correction stays on the same person and attribute', async () => {
    const h = fixture({ names: ['Coti', 'Martín'] });
    const first = 'Coti trabaja en un estudio de arquitectura.';
    const initial = fact(first, 'Coti', 'biography.workplace', 'un estudio de arquitectura');
    assert.equal((await assess(h, first, [initial])).persistedCount, 1);
    assert.equal((await assess(h, first, [initial])).unchangedCount, 1);
    const second = 'Coti ya no trabaja en ese estudio.';
    const update = fact(second, 'Coti', 'biography.workplace', 'ese estudio', { temporal: 'past',
        priorStatement: 'un estudio de arquitectura' });
    const updateResult = await assess(h, second, [update]);
    assert.equal(updateResult.persistedCount, 1, JSON.stringify(h.diagnostics));
    const rows = h.getStore().assertions.filter(item => item.compatibility?.key === 'biography.workplace');
    assert.equal(rows.length, 2);
    assert.equal(rows.find(item => item.status === 'active').subject.id, h.people[0].id);
    assert.equal(rows.find(item => item.status === 'superseded').subject.id, h.people[0].id);
    assert.equal(h.getStore().assertions.filter(item => item.subject?.id === h.people[1].id).length, 1);
});

for (const [label, candidate, rejectedCheck] of [
    ['sensitive', fact('Coti tiene una enfermedad.', 'Coti', 'biography.health', 'una enfermedad'), { nonSensitive: false }],
    ['uncertain', fact('Quizás Coti sea arquitecta.', 'Coti', 'biography.occupation', 'arquitecta', { certainty: 'uncertain' }), { explicit: false }],
    ['question', fact('¿Coti es arquitecta?', 'Coti', 'biography.occupation', 'arquitecta', { certainty: 'uncertain' }), { explicit: false }],
    ['third-party quote', fact('Coti dijo que Martín toca la guitarra.', 'Coti', 'hobby.instrument_guitar', 'la guitarra'), { explicit: false }],
    ['wrong subject', fact('Martín es arquitecto.', 'Coti', 'biography.occupation', 'arquitecto'), { subjectMatches: false }],
    ['model-supplied ID', { ...fact('Coti es arquitecta.', 'Coti', 'biography.occupation', 'arquitecta'), personId: id('person') }, null],
    ['future plan misclassified as current occupation', fact('Coti quiere aprender arquitectura.', 'Coti', 'biography.occupation', 'arquitectura', { temporal: 'future' }), { supported: false }],
    ['hypothesis', fact('Coti podría ser arquitecta.', 'Coti', 'biography.occupation', 'arquitecta', { hypothetical: true }), { explicit: false }],
    ['value absent from quote', fact('Coti es arquitecta.', 'Coti', 'biography.occupation', 'ingeniera'), { supported: false }],
]) test(`${label} cannot create a third-party assertion`, async () => {
    const h = fixture({ names: ['Coti', 'Martín'] });
    if (rejectedCheck) h.setVerificationOutcome(candidate.sourceQuote, rejectedCheck);
    const result = await assess(h, candidate.sourceQuote, [candidate]);
    assert.equal(result.persistedCount ?? 0, 0);
    assert.equal(h.getStore().assertions.filter(item => item.compatibility).length, 0);
});

test('generic third-party topics are permitted only through the third-party facts scope', async () => {
    const h = fixture({ names: ['Coti', 'Martín'] });
    const quote = 'Coti prefiere el jazz.';
    const candidate = fact(quote, 'Coti', 'music.genre', 'el jazz');
    assert.equal((await assess(h, quote, [candidate])).persistedCount, 1);
    const saved = h.getStore().assertions.find(item => item.compatibility?.key === 'music.genre');
    assert.equal(saved.subject.id, h.people[0].id);
    assert.equal(saved.object.value, 'el jazz');
    const disabled = fixture({ names: ['Coti'], enabled: false });
    assert.equal((await assess(disabled, quote, [candidate])).persistedCount, 0);
});

test('an independently asserted past third-party event remains historical', async () => {
    const h = fixture({ names: ['Coti'] });
    const quote = 'Coti trabajaba en un estudio.';
    const candidate = fact(quote, 'Coti', 'biography.workplace', 'un estudio', { temporal: 'past' });
    assert.equal((await assess(h, quote, [candidate])).persistedCount, 1);
    assert.equal(h.getStore().assertions.find(item => item.compatibility?.key === 'biography.workplace').object.value, quote);
});

test('a failed transaction leaves no partial third-party assertion', async () => {
    const h = fixture({ failCommit: true });
    const before = h.getStore();
    const quote = 'Coti es arquitecta.';
    const result = await assess(h, quote, [fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    assert.equal(result.persistedCount, 0);
    assert.deepEqual(h.getStore(), before);
});

test('third-party assessment runs after the conversational response is delivered', async () => {
    const h = fixture();
    const quote = 'Coti es arquitecta.';
    h.setCandidates([fact(quote, 'Coti', 'biography.occupation', 'arquitecta')]);
    const runtime = createConversationRuntime({ memoryMode: 'memory2-confirmed-write',
        agentOptions: { deferOrganicMemoryLearning: true },
        agentFactory: ({ initialConversationHistory }) => h.create({ initialConversationHistory }) });
    try {
        const conversationId = runtime.createConversation();
        const result = await runtime.sendMessage({ conversationId, requestId: 'third-party-background',
            text: quote, source: 'typed' });
        assert.equal(result.status, 'completed');
        assert.equal(result.text, 'Entendido.');
        assert.equal(h.getStore().assertions.filter(item => item.compatibility).length, 0);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'third-party-background',
            text: quote, source: 'typed' }), true);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (h.getStore().assertions.some(item => item.compatibility)) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(h.getStore().assertions.filter(item => item.compatibility).length, 1);
    } finally { await runtime.close(); }
});
