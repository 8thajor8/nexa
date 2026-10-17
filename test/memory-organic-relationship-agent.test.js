import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { createOrganicMemoryAuthorization, ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, ORGANIC_RELATIONSHIP_SCOPE,
    parseDirectOwnerPartnerStatement } from '../src/core/organic-memory-authorization.js';
import { SCHEMA_VERSION, validateMemoryStore } from '../src/memory/schema.js';

const toolName = 'propose_organic_memory_facts';
const verifierName = 'verify_organic_relationship_evidence';
const mode = 'memory2-confirmed-write';

function proposal(sourceQuote, preferredName = 'Alex', category = 'partner', label = 'pareja') {
    return { facts: [], relationships: [{ sourceQuote, preferredName, relationshipType: { category, label }, confidence: 'high', certainty: 'explicit', subject: 'owner',
        sensitivity: 'none', ambiguous: false, thirdParty: false, hypothetical: false }] };
}

function functionResponse(args, name = toolName) {
    return { status: 'completed', output: [{ type: 'function_call', name,
        call_id: 'synthetic-relationship-call', arguments: JSON.stringify(args) }], output_text: '' };
}

const VERIFIED = Object.fromEntries(['quoteIsLiteral', 'ownerIsParticipant', 'relationshipIsCurrent', 'relationshipIsExplicit',
    'notHypotheticalOrQuestion', 'notQuotedOrThirdParty', 'personNameSupported', 'relationshipLabelSupported',
    'categorySupported', 'notSensitive', 'unambiguous'].map(key => [key, true]));

function finalResponse(text = 'Entendido.') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

async function fixture(callback, { relationshipLearningEnabled = true, revokeBeforePersist = false, verificationResults = new Map(), repeatProposal = false,
    repositoryCommitFailure = false, background = false, verificationDelayMs = 0 } = {}) {
    const now = '2035-02-03T04:05:06.000Z';
    let store = { schema_version: SCHEMA_VERSION, store_id: `store_${randomUUID()}`, self_person_id: `person_${randomUUID()}`,
        revision: 0, created_at: now, updated_at: now,
        entities: [], assertions: [], sources: [], evidence: [], migrations: [], automatic_operations: [] };
    store.entities.push({ id: store.self_person_id, type: 'person', created_at: now });
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let currentDigest = digest(store);
    const repository = {
        open: async () => {}, close: async () => {},
        readSnapshot: async () => ({ snapshot: structuredClone(store), revision: store.revision, digest: currentDigest }),
        commit: async request => {
            if (repositoryCommitFailure) throw Object.assign(new Error('synthetic_write_failure'), { code: 'synthetic_write_failure' });
            if (request.expectedRevision !== store.revision || request.expectedDigest !== currentDigest)
                throw new Error('memory_revision_conflict');
            const next = structuredClone(store);
            for (const change of request.changes) {
                const collection = next[change.collection], record = structuredClone(change.record);
                const index = collection.findIndex(item => item.id === record.id);
                if (index < 0) collection.push(record); else collection[index] = record;
            }
            next.revision++; next.updated_at = now;
            validateMemoryStore(next);
            store = next; currentDigest = digest(next);
            return { snapshot: structuredClone(store), revision: store.revision, digest: currentDigest };
        },
    };
    const targetRepository = repository;
    const consentProofs = new WeakMap();
    const evidenceProofs = new WeakMap();
    const storeProofs = new WeakMap();
    const ownerId = 'synthetic-owner';
    const scopes = ['tool_preferences', 'entertainment_preferences', 'food_activity_preferences', 'interaction_preferences',
        'daily_routines', 'work_patterns', 'recurring_activities', 'active_projects', 'interests', 'goals',
        ...(relationshipLearningEnabled ? [ORGANIC_RELATIONSHIP_SCOPE] : [])];
    let authorization;
    const authorizationFactory = ({ repository: actualRepository, persist }) => {
        const storeCapability = Object.freeze(Object.create(null));
        storeProofs.set(storeCapability, { kind: 'memory2_personal', personalData: true, ownerId, mode });
        authorization = createOrganicMemoryAuthorization({ storeCapability,
            verifyStoreCapability: capability => capability === storeCapability && actualRepository === targetRepository
                ? storeProofs.get(capability) : null,
            verifyConsentCapability: capability => consentProofs.get(capability) ?? null,
            verifyEvidenceCapability: capability => evidenceProofs.get(capability) ?? null,
            persist,
        });
        const grant = Object.freeze(Object.create(null));
        consentProofs.set(grant, { issuer: 'owner', personal: true, ownerId, mode,
            purpose: 'organic_memory_learning', decision: 'granted', scopes });
        authorization.setOwnerConsent(grant, 'granted', scopes);
        return authorization;
    };
    const responsesByText = new Map();
    const consumed = new Set();
    const repeated = new Set();
    const requests = [];
    const agentDiagnostics = [];
    const runtimeDiagnostics = [];
    const memoryContextProvider = createMemoryContextProvider({ repository: targetRepository,
        embeddings: { model: 'synthetic-relationship-v1', embedMany: async texts => texts.map(() => [1, 0]) },
        authorizeSubject: () => true, authorizeRelationships: () => relationshipLearningEnabled });
    const ask = async request => {
        requests.push(request);
        if (request.tools?.some(tool => tool.name === verifierName)) {
            if (verificationDelayMs) await new Promise(resolve => setTimeout(resolve, verificationDelayMs));
            const payload = JSON.parse(request.input[0].content);
            const assessment = verificationResults.get(payload.currentUserMessage) ?? VERIFIED;
            if (assessment === 'throw') throw new Error('synthetic_verifier_unavailable');
            if (assessment === 'timeout') { const error = new Error('synthetic_verifier_timeout'); error.code = 'ETIMEDOUT'; throw error; }
            if (assessment?.rawResponse) return assessment.rawResponse;
            return functionResponse(assessment, verifierName);
        }
        const current = [...request.input].reverse().find(item => item?.role === 'user')?.content ?? '';
        if (request.tools?.some(tool => tool.name === toolName) && responsesByText.has(current)) {
            if (!consumed.has(current)) {
                consumed.add(current);
                return functionResponse(responsesByText.get(current));
            }
            if (repeatProposal && !repeated.has(current)) {
                repeated.add(current);
                return functionResponse(responsesByText.get(current));
            }
        }
        return finalResponse();
    };
    const relationshipEvidenceCapabilityFactory = evidence => {
        if (!relationshipLearningEnabled || evidence.scope !== ORGANIC_RELATIONSHIP_SCOPE
            || evidence.attribute !== ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE || evidence.operation !== 'remember_relationship'
            || evidence.origin !== 'direct_user' || evidence.subject !== 'owner' || evidence.modelOriginated !== false
            || evidence.explicit !== true || evidence.certain !== true || evidence.sensitive !== false
            || evidence.ambiguous !== false || evidence.thirdParty !== false) return null;
        const parsed = evidence.relationshipType?.category === 'partner' ? parseDirectOwnerPartnerStatement(evidence.sourceQuote) : null;
        if (evidence.semanticEvidenceVerified !== 'direct_owner_relationship_v1'
            || !evidence.userMessage.includes(evidence.sourceQuote)
            || (parsed && evidence.preferredName !== parsed.preferredName)) return null;
        const capability = Object.freeze(Object.create(null));
        evidenceProofs.set(capability, { origin: 'direct_user', subject: 'owner', explicit: true, certain: true,
            sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false, ownerId,
            attribute: ORGANIC_TYPED_RELATIONSHIP_ATTRIBUTE, preferredName: evidence.preferredName,
            relationshipType: evidence.relationshipType, semanticEvidenceVerified: evidence.semanticEvidenceVerified,
            sourceQuote: evidence.sourceQuote, userMessage: evidence.userMessage });
        if (revokeBeforePersist) {
            const revoked = Object.freeze(Object.create(null));
            consentProofs.set(revoked, { issuer: 'owner', personal: true, ownerId, mode,
                purpose: 'organic_memory_learning', decision: 'revoked', scopes });
            authorization.revokeOwnerConsent(revoked);
        }
        return capability;
    };
    const runtime = createConversationRuntime({ memoryMode: mode, agentOptions: { deferOrganicMemoryLearning: background },
        diagnostic: event => runtimeDiagnostics.push(event),
        agentFactory: ({ agentOptions, initialConversationHistory }) =>
        createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: targetRepository,
            memoryContextProvider,
            memoryRetrievalEnabled: true, enableConfirmedMemoryWrites: true, enableOrganicMemoryLearning: true,
            operationalMemoryMode: mode, organicMemoryAuthorizationFactory: authorizationFactory,
            organicEvidenceCapabilityFactory: () => null, organicRelationshipEvidenceCapabilityFactory: relationshipEvidenceCapabilityFactory,
            isOrganicRelationshipLearningEnabled: () => relationshipLearningEnabled,
            logger: (event, details) => agentDiagnostics.push({ event, ...details }),
            getTools: () => [], ask, initialConversationHistory }) });
    try {
        await callback({ runtime, repository, requests, responsesByText, verificationResults, agentDiagnostics, runtimeDiagnostics });
    } finally {
        await runtime.close().catch(() => {});
        await repository.close().catch(() => {});
    }
}

test('background relationship assessment is independent of the conversational tool choice and recovers in another conversation', async () => {
    await fixture(async ({ runtime, repository, requests, responsesByText }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Martín es mi hermano.';
        responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'hermano'));
        await send(runtime, conversationId, 'background-relation', statement);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].tools.some(tool => tool.name === toolName), false);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'background-relation', text: statement, source: 'typed' }), true);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('background_relationship_timeout')), 1_000);
            const poll = async () => {
                if ((await repository.readSnapshot()).snapshot.assertions.some(item => item.predicate === 'personal_relationship_of')) {
                    clearTimeout(timer); resolve(); return;
                }
                setTimeout(poll, 5);
            };
            void poll();
        });
        const assessment = requests.find(request => request.toolChoice === 'required'
            && request.tools.some(tool => tool.name === toolName));
        assert.ok(assessment);
        assert.equal(assessment.store, false);
        assert.deepEqual(assessment.input, [{ role: 'user', content: statement }]);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of').length, 1);
        const next = runtime.createConversation();
        await send(runtime, next, 'background-recall', '¿Quién es Martín?');
        assert.ok(requests.at(-1).input.some(item => item?.type === 'function_call_output'
            && item.output.includes('personal_relationship_of')));
    }, { background: true });
});

test('a direct first relationship proposal survives a verifier slower than the proposal budget', async () => {
    await fixture(async ({ runtime, repository, requests, responsesByText }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Coti es mi pareja.';
        responsesByText.set(statement, proposal(statement, 'Coti'));
        await send(runtime, conversationId, 'slow-relation', statement);
        const completed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('synthetic_assessment_timeout')), 8_000);
            const unsubscribe = runtime.onEvent(event => {
                if (event.requestId !== 'slow-relation' || event.status !== 'organic_assessment'
                    || !['saved', 'no_memory', 'not_processed'].includes(event.state)) return;
                clearTimeout(timer); unsubscribe(); resolve(event);
            });
        });
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'slow-relation', text: statement, source: 'typed' }), true);
        const outcome = await completed;
        assert.equal(outcome.state, 'saved');
        assert.equal((await repository.readSnapshot()).snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of').length, 1);
        const assessment = requests.find(request => request.toolChoice === 'required'
            && request.tools.some(tool => tool.name === toolName));
        assert.match(assessment.instructions, /interpretá semánticamente el mensaje actual/u);
        assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, 1);
    }, { background: true, verificationDelayMs: 5_200 });
});

test('background relationship assessment respects disabled consent and revocation at write time', async () => {
    const waitForAssessment = async diagnostics => {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (diagnostics.some(item => item.event === 'organic_assessment_completed')) return;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('background_assessment_timeout');
    };
    await fixture(async ({ runtime, repository, requests, responsesByText, runtimeDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Alex es mi pareja.';
        responsesByText.set(statement, proposal(statement));
        await send(runtime, conversationId, 'background-disabled', statement);
        runtime.scheduleOrganicAssessment({ conversationId, requestId: 'background-disabled', text: statement, source: 'typed' });
        await waitForAssessment(runtimeDiagnostics);
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), false);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    }, { background: true, relationshipLearningEnabled: false });
    await fixture(async ({ runtime, repository, responsesByText, runtimeDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Alex es mi pareja.';
        responsesByText.set(statement, proposal(statement));
        await send(runtime, conversationId, 'background-revoked', statement);
        runtime.scheduleOrganicAssessment({ conversationId, requestId: 'background-revoked', text: statement, source: 'typed' });
        await waitForAssessment(runtimeDiagnostics);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    }, { background: true, revokeBeforePersist: true });
});

test('invalid candidates, verifier failures and Memory2 failures stay outside the delivered background response', async () => {
    const statement = 'Alex es mi pareja.';
    const cases = [
        { candidate: { ...proposal(statement).relationships[0], ambiguous: true },
            options: { verificationResults: new Map([[statement, { ...VERIFIED, unambiguous: false }]]) }, verifierCalls: 1 },
        { candidate: proposal(statement).relationships[0], options: { verificationResults: new Map([[statement, 'throw']]) }, verifierCalls: 1 },
        { candidate: proposal(statement).relationships[0], options: { repositoryCommitFailure: true }, verifierCalls: 1 },
    ];
    for (const { candidate, options, verifierCalls } of cases) {
        await fixture(async ({ runtime, repository, requests, responsesByText, runtimeDiagnostics }) => {
            const conversationId = runtime.createConversation();
            responsesByText.set(statement, { facts: [], relationships: [candidate] });
            assert.equal(await send(runtime, conversationId, 'background-failure', statement), 'Entendido.');
            assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'background-failure',
                text: statement, source: 'typed' }), true);
            for (let attempt = 0; attempt < 100; attempt++) {
                if (runtimeDiagnostics.some(item => item.event === 'organic_assessment_completed')) break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.ok(runtimeDiagnostics.some(item => item.event === 'organic_assessment_completed'));
            assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, verifierCalls);
            assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        }, { background: true, ...options });
    }
});

async function send(runtime, conversationId, requestId, text) {
    const result = await runtime.sendMessage({ conversationId, requestId, text, source: 'typed' });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return result.text;
}

test('permission gates relationship proposals; explicit owner relation persists once and is available in a new conversation', async () => {
    await fixture(async ({ runtime, repository, requests, responsesByText, agentDiagnostics }) => {
        const firstConversation = runtime.createConversation();
        const statement = 'Alex es mi pareja.';
        responsesByText.set(statement, proposal(statement));
        await send(runtime, firstConversation, 'relationship-first', statement);
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active').length, 1,
            JSON.stringify({ requests: requests.map(request => ({ tools: request.tools?.map(tool => tool.name), input: request.input })), snapshot }));
        assert.equal(snapshot.entities.filter(item => item.type === 'person').length, 2); // Owner plus Alex.
        assert.ok(snapshot.assertions.some(item => item.predicate === 'entity.preferred_name' && item.object.value === 'Alex'));
        assert.equal(requests[0].tools.find(tool => tool.name === toolName).parameters.required.includes('relationships'), true);
        const verificationRequest = requests.find(request => request.tools?.some(tool => tool.name === verifierName));
        assert.ok(verificationRequest);
        assert.equal(verificationRequest.store, false);
        assert.deepEqual(verificationRequest.input.map(item => item.role), ['user']);
        assert.deepEqual(Object.keys(JSON.parse(verificationRequest.input[0].content)).sort(),
            ['currentUserMessage', 'exactEvidenceQuote', 'proposedCategory', 'proposedPersonName', 'proposedRelationshipLabel'].sort());
        assert.equal(JSON.stringify(verificationRequest.input).includes('relationship-first'), false);

        const revision = (await repository.readSnapshot()).revision;
        await send(runtime, firstConversation, 'relationship-duplicate', statement);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.revision, revision);

        const secondConversation = runtime.createConversation();
        await send(runtime, secondConversation, 'relationship-recall', '¿Quién es Alex?');
        const delivered = requests.at(-1).input.filter(item => item?.type === 'function_call_output')
            .flatMap(item => { try { return [JSON.parse(item.output)]; } catch { return []; } });
        assert.ok(delivered.some(payload => payload.relations?.some(relation => relation.predicate === 'personal_relationship_of')));
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'evidence' && item.status === 'issued'));
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'write' && item.status === 'created'));
    });
});

test('disabled relationship consent does not expose or persist relationship candidates', async () => {
    await fixture(async ({ runtime, repository, requests, responsesByText }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Alex es mi pareja.';
        responsesByText.set(statement, proposal(statement));
        await send(runtime, conversationId, 'relationship-disabled', statement);
        assert.equal(requests[0].tools.find(tool => tool.name === toolName).parameters.required.includes('relationships'), false);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    }, { relationshipLearningEnabled: false });
});

test('the direct relationship wording “Mi pareja se llama Alex” is accepted without model-supplied entity IDs', async () => {
    await fixture(async ({ runtime, repository, responsesByText }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Mi pareja se llama Alex.';
        responsesByText.set(statement, proposal(statement));
        await send(runtime, conversationId, 'relationship-name-form', statement);
        const snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active').length, 1);
        assert.ok(snapshot.assertions.some(item => item.predicate === 'entity.preferred_name' && item.object.value === 'Alex'));
        assert.equal(JSON.stringify(snapshot).includes('synthetic'), false);
    });
});

test('semantic extraction handles family, partner and friendship formulations through an isolated verifier request', async () => {
    await fixture(async ({ runtime, repository, responsesByText, requests }) => {
        const conversationId = runtime.createConversation();
        const cases = [
            ['Diego es mi hermano.', 'Diego', 'family', 'hermano'],
            ['Tengo un hermano llamado Diego.', 'Diego', 'family', 'hermano'],
            ['Diego y yo somos hermanos.', 'Diego', 'family', 'hermanos'],
            ['Mi hermana se llama Lucía.', 'Lucía', 'family', 'hermana'],
            ['Martín es mi mejor amigo.', 'Martín', 'friend', 'mejor amigo'],
            ['Sofía es mi prima.', 'Sofía', 'family', 'prima'],
            ['Coti es mi pareja.', 'Coti', 'partner', 'pareja'],
        ];
        for (const [index, [statement, name, category, label]] of cases.entries()) {
            responsesByText.set(statement, proposal(statement, name, category, label));
            await send(runtime, conversationId, `typed-relation-${index}`, statement);
        }
        const snapshot = (await repository.readSnapshot()).snapshot;
        const relations = snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active');
        assert.equal(relations.length, 6); // The two equivalent Diego formulations deduplicate.
        assert.deepEqual(new Set(relations.map(item => `${item.relationship_type.category}:${item.relationship_type.label}`)),
            new Set(cases.map(([, , category, label]) => `${category}:${label}`)));
        const verifierRequests = requests.filter(request => request.tools?.some(tool => tool.name === verifierName));
        assert.equal(verifierRequests.length, cases.length);
        for (const request of verifierRequests) {
            assert.equal(request.store, false);
            assert.equal(request.input.length, 1);
            const payload = JSON.parse(request.input[0].content);
            assert.deepEqual(Object.keys(payload).sort(),
                ['currentUserMessage', 'exactEvidenceQuote', 'proposedPersonName', 'proposedCategory', 'proposedRelationshipLabel'].sort());
            assert.equal(request.tools.length, 1);
            assert.equal(request.tools[0].name, verifierName);
        }
    });
});

test('schema-valid relationship labels normalize case and can differ from the sentence inflection', async () => {
    await fixture(async ({ runtime, repository, responsesByText, requests }) => {
        const conversationId = runtime.createConversation();
        const cases = [
            ['Diego y yo somos hermanos.', 'Diego', 'family', 'Hermano'],
            ['Martín y yo somos mejores amigos.', 'Martín', 'friend', 'mejor amigo'],
            ['Alex es mi pareja.', 'Alex', 'partner', ' Pareja '],
        ];
        for (const [index, [statement, name, category, label]] of cases.entries()) {
            responsesByText.set(statement, proposal(statement, name, category, label));
            await send(runtime, conversationId, `relationship-label-variant-${index}`, statement);
        }
        const snapshot = (await repository.readSnapshot()).snapshot;
        const relations = snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active');
        assert.equal(relations.length, cases.length);
        assert.deepEqual(new Set(relations.map(item => item.relationship_type.label)), new Set(['hermano', 'mejor amigo', 'pareja']));
        assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, cases.length);
    });
});

test('malformed evidence is rejected locally and third-party meaning is rejected by the semantic verifier', async () => {
    const statement = 'Martín es mi hermano.';
    const base = proposal(statement, 'Martín', 'family', 'hermano').relationships[0];
    const { hypothetical: omitted, ...missingField } = base;
    const cases = [
        ['missing_field', statement, missingField, 'candidate_shape_invalid'],
        ['low_confidence', statement, { ...base, confidence: 'medium' }, 'eligibility_flags_invalid'],
        ['quote_missing', statement, { ...base, sourceQuote: '' }, 'source_quote_invalid'],
        ['name_missing', statement, { ...base, preferredName: '' }, 'person_name_invalid'],
        ['excluded_category', statement, { ...base, relationshipType: { category: 'professional', label: 'jefe' } }, 'category_invalid'],
        ['different_sentence', statement, { ...base, sourceQuote: 'Diego es mi hermano.', preferredName: 'Diego' }, 'quote_not_literal'],
        ['invalid_type', statement, { ...base, relationshipType: { category: 'family', label: 'mi hermano' } }, 'relationship_type_invalid'],
        ['different_person', statement, { ...base, preferredName: 'Diego' }, 'person_not_in_quote'],
    ];
    for (const [caseName, message, candidate, code] of cases) {
        await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
            const conversationId = runtime.createConversation();
            responsesByText.set(message, { facts: [], relationships: [candidate] });
            await send(runtime, conversationId, `candidate-${caseName}`, message);
            assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0, caseName);
            assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), false, caseName);
            assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
                && item.stage === 'local_validation' && item.status === 'rejected' && item.code === code), caseName);
        });
    }
    const thirdPartyMessage = 'Martín es hermano de Diego.';
    await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        responsesByText.set(thirdPartyMessage, { facts: [], relationships: [{ ...base, sourceQuote: thirdPartyMessage }] });
        await send(runtime, conversationId, 'candidate-third-party', thirdPartyMessage);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), true);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'verification' && item.status === 'rejected'));
    }, { verificationResults: new Map([[thirdPartyMessage, { ...VERIFIED,
        ownerIsParticipant: false, notQuotedOrThirdParty: false }]]) });
});

test('question, hypothesis, quotation and past relationship meaning reach the verifier and fail closed semantically', async () => {
    const examples = [
        ['¿Martín es mi hermano?', '¿Martín es mi hermano?', { relationshipIsExplicit: false, notHypotheticalOrQuestion: false }],
        ['Creo que Martín podría ser mi hermano.', 'Martín podría ser mi hermano.', { relationshipIsExplicit: false, notHypotheticalOrQuestion: false }],
        ['Martín dijo: «Alex es mi hermano».', 'Alex es mi hermano', { ownerIsParticipant: false, notQuotedOrThirdParty: false }],
        ['Martín era mi hermano.', 'Martín era mi hermano.', { relationshipIsCurrent: false }],
    ];
    for (const [message, quote, negativeFields] of examples) {
        const negative = { ...VERIFIED, ...Object.fromEntries(Object.keys(negativeFields).map(key => [key, false])) };
        await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
            const conversationId = runtime.createConversation();
            const name = quote.includes('Alex') ? 'Alex' : 'Martín';
            responsesByText.set(message, proposal(quote, name, 'family', 'hermano'));
            await send(runtime, conversationId, 'semantic-meaning-reject', message);
            assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, 1,
                `${message}; calls=${JSON.stringify(requests.map(request => request.tools?.map(tool => tool.name)))}; trace=${JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_relationship_trace'))}`);
            const verification = JSON.parse(requests.find(request => request.tools?.some(tool => tool.name === verifierName))
                .input[0].content);
            assert.equal(verification.currentUserMessage, message);
            assert.equal(verification.exactEvidenceQuote, quote);
            assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
            assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
                && item.stage === 'verification' && item.status === 'rejected'));
        }, { verificationResults: new Map([[message, negative]]) });
    }
});

test('a literal relationship evidence span need not be a standalone sentence', async () => {
    await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const message = 'Como te decía, Martín es mi hermano y nos vemos el domingo.';
        responsesByText.set(message, proposal('Martín es mi hermano', 'Martín', 'family', 'hermano'));
        await send(runtime, conversationId, 'relationship-literal-span', message);
        assert.equal((await repository.readSnapshot()).snapshot.assertions
            .filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active').length, 1,
            JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_relationship_trace')));
        const verifier = requests.find(request => request.tools?.some(tool => tool.name === verifierName));
        const payload = JSON.parse(verifier.input[0].content);
        assert.equal(payload.currentUserMessage, message);
        assert.equal(payload.exactEvidenceQuote, 'Martín es mi hermano');
    });
});

test('a label absent from the sentence still requires semantic verifier agreement before writing', async () => {
    const statement = 'Martín es mi hermano.';
    await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'primo'));
        await send(runtime, conversationId, 'candidate-semantic-disagreement', statement);
        assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, 1);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'verification' && item.status === 'rejected' && item.code === 'assessment_negative'));
    }, { verificationResults: new Map([[statement, { ...VERIFIED, relationshipLabelSupported: false }]]) });
});

test('verifier disagreement, malformed response, error and timeout all fail closed', async () => {
    const disagreement = { ...VERIFIED, personNameSupported: false };
    await fixture(async ({ runtime, repository, responsesByText, requests }) => {
        const conversationId = runtime.createConversation();
        const statements = ['Diego es mi hermano.', 'Martín es mi mejor amigo.', 'Sofía es mi prima.', 'Coti es mi pareja.'];
        responsesByText.set(statements[0], proposal(statements[0], 'Diego', 'family', 'hermano'));
        responsesByText.set(statements[1], proposal(statements[1], 'Martín', 'friend', 'mejor amigo'));
        responsesByText.set(statements[2], proposal(statements[2], 'Sofía', 'family', 'prima'));
        responsesByText.set(statements[3], proposal(statements[3], 'Coti', 'partner', 'pareja'));
        for (const [index, statement] of statements.entries()) {
            // Set per-statement behavior on the already injected verifier map via the fixture's input map.
            await send(runtime, conversationId, `verifier-fail-${index}`, statement);
        }
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, 4);
    }, { verificationResults: new Map([
        ['Diego es mi hermano.', disagreement],
        ['Martín es mi mejor amigo.', {}],
        ['Sofía es mi prima.', 'throw'],
        ['Coti es mi pareja.', 'timeout'],
    ]) });
});

test('structured verifier response writes atomically and malformed subcauses stay categorical and fail closed', async () => {
    const statement = 'Martín es mi hermano.';
    const verifierResponse = values => ({ status: 'completed', output: [{ type: 'function_call',
        name: verifierName, call_id: 'synthetic-verifier-call', arguments: JSON.stringify(values) }], output_text: '' });
    await fixture(async ({ runtime, repository, responsesByText, verificationResults, agentDiagnostics, requests }) => {
        const conversationId = runtime.createConversation();
        responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'hermano'));
        verificationResults.set(statement, { rawResponse: verifierResponse(VERIFIED) });
        await send(runtime, conversationId, 'verifier-structured-approved', statement);
        const snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active').length, 1);
        const verificationRequest = requests.find(request => request.tools?.some(tool => tool.name === verifierName));
        assert.equal(verificationRequest.maxOutputTokens, 512);
        assert.equal(verificationRequest.toolChoice, 'required');
        assert.equal(verificationRequest.tools.length, 1);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'verification' && item.status === 'approved'));
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'write' && item.status === 'created'));
    });

    const cases = [
        ['incomplete', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'response_incomplete'],
        ['truncated_arguments', { status: 'completed', output: [{ type: 'function_call', name: verifierName,
            arguments: '{"quoteIsLiteral":true' }] }, 'arguments_invalid_json'],
        ['missing_fields', verifierResponse({ quoteIsLiteral: true }), 'assessment_shape_invalid'],
        ['unexpected_output', { status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(VERIFIED) }] }] }, 'tool_call_missing'],
        ['missing_status', { output: [] }, 'response_status_missing'],
        ['api_failure', 'throw', 'api_error'],
        ['timeout', 'timeout', 'request_timeout'],
    ];
    for (const [caseName, rawResponse, expectedCode] of cases) {
        await fixture(async ({ runtime, repository, responsesByText, verificationResults, agentDiagnostics }) => {
            const conversationId = runtime.createConversation();
            responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'hermano'));
            verificationResults.set(statement, rawResponse === 'throw' || rawResponse === 'timeout'
                ? rawResponse : { rawResponse });
            await send(runtime, conversationId, `verifier-${caseName}`, statement);
            const snapshot = (await repository.readSnapshot()).snapshot;
            assert.equal(snapshot.assertions.length, 0, caseName);
            assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
                && item.stage === 'verification' && item.status === (expectedCode === 'request_timeout' ? 'timeout'
                    : expectedCode === 'api_error' ? 'error' : 'malformed') && item.code === expectedCode), caseName);
            const trace = JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_relationship_trace'));
            assert.doesNotMatch(trace, /Martín|hermano|sourceQuote|currentUserStatement/u);
        });
    }
});

test('repeated identical relationship candidate in one turn is semantically verified only once', async () => {
    await fixture(async ({ runtime, repository, responsesByText, requests }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Alex es mi pareja.';
        responsesByText.set(statement, proposal(statement, 'Alex', 'partner', 'pareja'));
        await send(runtime, conversationId, 'relationship-repeat', statement);
        assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, 1);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.filter(item =>
            item.predicate === 'personal_relationship_of' && item.status === 'active').length, 1);
    }, { repeatProposal: true });
});

test('professional relationship proposals are rejected before the semantic verification call', async () => {
    await fixture(async ({ runtime, repository, responsesByText, requests }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Laura es mi jefa.';
        responsesByText.set(statement, proposal(statement, 'Laura', 'professional', 'jefa'));
        await send(runtime, conversationId, 'professional-relation', statement);
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), false);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    });
});

test('questions, hypotheses, quotes, third-party attribution and ambiguity fail semantic verification; mismatched evidence fails locally', async () => {
    const semanticRejects = [
        ['Creo que Alex podría ser mi pareja.', 'Alex podría ser mi pareja.', { relationshipIsExplicit: false, notHypotheticalOrQuestion: false }],
        ['¿Alex es mi pareja?', '¿Alex es mi pareja?', { relationshipIsExplicit: false, notHypotheticalOrQuestion: false }],
        ['Alex dijo: «Alex es mi pareja».', 'Alex es mi pareja', { ownerIsParticipant: false, notQuotedOrThirdParty: false }],
        ['Alex y Sam son mis parejas.', 'Alex y Sam son mis parejas.', { unambiguous: false }],
    ];
    for (const [message, quote, negativeFields] of semanticRejects) {
        const result = { ...VERIFIED, ...Object.fromEntries(Object.keys(negativeFields).map(key => [key, false])) };
        await fixture(async ({ runtime, repository, responsesByText, requests }) => {
            const conversationId = runtime.createConversation();
            const name = quote.includes('Sam') ? 'Alex' : 'Alex';
            responsesByText.set(message, proposal(quote, name));
            await send(runtime, conversationId, 'relationship-semantic-reject', message);
            assert.equal(requests.filter(request => request.tools?.some(tool => tool.name === verifierName)).length, 1);
            assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        }, { verificationResults: new Map([[message, result]]) });
    }
    for (const [message, quote, code] of [
        ['Álex es mi pareja.', 'Alex es mi pareja.', 'quote_not_literal'],
    ]) {
        await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
            const conversationId = runtime.createConversation();
            responsesByText.set(message, proposal(quote, 'Alex'));
            await send(runtime, conversationId, 'relationship-local-reject', message);
            assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), false);
            assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
            assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
                && item.stage === 'local_validation' && item.code === code));
        });
    }
    const thirdPartyMessage = 'Alex es la pareja de Sam.';
    await fixture(async ({ runtime, repository, responsesByText, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        responsesByText.set(thirdPartyMessage, proposal(thirdPartyMessage, 'Alex'));
        await send(runtime, conversationId, 'relationship-third-party', thirdPartyMessage);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), true);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'verification' && item.status === 'rejected'));
    }, { verificationResults: new Map([[thirdPartyMessage, { ...VERIFIED,
        ownerIsParticipant: false, notQuotedOrThirdParty: false }]]) });
});

test('consent revoked after evidence issuance is rechecked before persistence', async () => {
    await fixture(async ({ runtime, repository, responsesByText }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Alex es mi pareja.';
        responsesByText.set(statement, proposal(statement));
        await send(runtime, conversationId, 'relationship-revoked', statement);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    }, { revokeBeforePersist: true });
});

test('an active different partner causes a clarification result without creating an orphan entity', async () => {
    await fixture(async ({ runtime, repository, requests, responsesByText, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        responsesByText.set('Alex es mi pareja.', proposal('Alex es mi pareja.', 'Alex'));
        await send(runtime, conversationId, 'relationship-alex', 'Alex es mi pareja.');
        responsesByText.set('Sam es mi pareja.', proposal('Sam es mi pareja.', 'Sam'));
        await send(runtime, conversationId, 'relationship-sam', 'Sam es mi pareja.');
        const snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.entities.filter(item => item.type === 'person').length, 2);
        assert.equal(snapshot.assertions.filter(item => item.predicate === 'personal_relationship_of' && item.status === 'active').length, 1);
        const outputs = requests.flatMap(request => request.input).filter(item => item?.type === 'function_call_output')
            .flatMap(item => { try { return [JSON.parse(item.output)]; } catch { return []; } });
        assert.ok(outputs.some(result => result.relationshipNeedsClarificationCount === 1));
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'write' && item.status === 'conflict'));
    });
});

test('an explicit permanent-save request remains on the existing explicit memory path', async () => {
    await fixture(async ({ runtime, requests }) => {
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'relationship-explicit-save', 'Alex es mi pareja, guardalo permanentemente.');
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === toolName)), false);
    });
});

test('relationship trace distinguishes permission gates and a proposal the model did not invoke', async () => {
    await fixture(async ({ runtime, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'trace-no-invocation', 'Martín es mi hermano.');
        const offer = agentDiagnostics.find(item => item.event === 'organic_relationship_trace' && item.stage === 'tool_offer');
        const proposalEvent = agentDiagnostics.find(item => item.event === 'organic_relationship_trace'
            && item.stage === 'proposal' && item.status === 'not_invoked');
        assert.equal(offer?.status, 'offered');
        assert.equal(offer?.permissionEnabled, true);
        assert.ok(proposalEvent);
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), false);
    });
    await fixture(async ({ runtime, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'trace-disabled', 'Martín es mi hermano.');
        const offer = agentDiagnostics.find(item => item.event === 'organic_relationship_trace' && item.stage === 'tool_offer');
        assert.equal(offer?.status, 'not_offered');
        assert.equal(offer?.permissionEnabled, false);
        assert.equal(agentDiagnostics.some(item => item.event === 'organic_relationship_trace' && item.stage === 'verification'), false);
        assert.equal(requests.some(request => request.tools?.some(tool => tool.name === verifierName)), false);
    }, { relationshipLearningEnabled: false });
});

test('relationship trace reports local rejection, verifier outcomes and persistence outcomes without user content', async () => {
    const failedVerification = { ...VERIFIED, relationshipLabelSupported: false };
    await fixture(async ({ runtime, responsesByText, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Martín es mi hermano.';
        responsesByText.set(statement, proposal('Diego es mi hermano.', 'Diego', 'family', 'hermano'));
        await send(runtime, conversationId, 'trace-local-reject', statement);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'local_validation' && item.status === 'rejected' && item.code === 'quote_not_literal'));
    });
    await fixture(async ({ runtime, responsesByText, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Martín es mi hermano.';
        responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'hermano'));
        await send(runtime, conversationId, 'trace-verifier-reject', statement);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'verification' && item.status === 'rejected'));
    }, { verificationResults: new Map([['Martín es mi hermano.', { ...VERIFIED, personNameSupported: false }]]) });
    for (const [requestId, result, expected] of [
        ['trace-verifier-negative', failedVerification, 'rejected'],
        ['trace-verifier-timeout', 'timeout', 'timeout'],
    ]) {
        await fixture(async ({ runtime, responsesByText, agentDiagnostics }) => {
            const conversationId = runtime.createConversation();
            const statement = 'Martín es mi hermano.';
            responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'hermano'));
            await send(runtime, conversationId, requestId, statement);
            assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
                && item.stage === 'verification' && item.status === expected));
            assert.equal(agentDiagnostics.some(item => item.event === 'organic_relationship_trace' && item.stage === 'write'), false);
        }, { verificationResults: new Map([['Martín es mi hermano.', result]]) });
    }
    await fixture(async ({ runtime, responsesByText, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Martín es mi hermano.';
        responsesByText.set(statement, proposal(statement, 'Martín', 'family', 'hermano'));
        await send(runtime, conversationId, 'trace-write-error', statement);
        assert.ok(agentDiagnostics.some(item => item.event === 'organic_relationship_trace'
            && item.stage === 'write' && item.status === 'error' && item.code === 'write_failed'));
        const serialized = JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_relationship_trace'));
        assert.doesNotMatch(serialized, /Martín|hermano|synthetic-owner|sourceQuote|currentUserStatement/u);
    }, { repositoryCommitFailure: true });
});
