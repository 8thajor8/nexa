import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgent } from '../src/core/agent.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { createOrganicMemoryAuthorization } from '../src/core/organic-memory-authorization.js';
import { initializeEmptyMemoryStore } from '../src/memory/backend.js';
import { createJsonMemoryRepository } from '../src/memory/json-repository.js';
import { createMemoryContextProvider } from '../src/memory/context-provider.js';
import { screenAutomaticMemoryTurn } from '../src/memory/automatic/privacy.js';

const organicTool = 'propose_organic_memory_facts';
const organicFactVerifierTool = 'verify_organic_memory_facts';
const fixtureEmbeddings = Object.freeze({ model: 'synthetic-test-v1',
    async embedMany(texts) { return texts.map(() => [1, 0]); } });
const mode = 'memory2-organic-synthetic-test';
const runtimeDiagnosticsByRuntime = new WeakMap();

function fact(sourceQuote, attribute, value, overrides = {}) {
    return { sourceQuote, attribute, value, confidence: 'high', certainty: 'explicit', subject: 'owner',
        temporal: 'current', validity: 'current', priorAssertionId: '', sensitivity: 'none', ambiguous: false, thirdParty: false,
        hypothetical: false, futureIntent: false, ...overrides };
}

function toolResponse(facts, extra = {}) {
    return { status: 'completed', output: [{ type: 'function_call', name: organicTool, call_id: `organic-${Math.random()}`,
        arguments: JSON.stringify({ facts, ...extra }) }], output_text: '' };
}

function finalResponse(text = '¿Qué tal te está resultando?') {
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text }] }], output_text: text };
}

async function temporaryStore(callback, { failCommit = false, consentMode = 'granted', personalMode = false, background = false,
    verificationOutcomes = new Map(), verificationResponses = new Map(), embeddings = fixtureEmbeddings } = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexa-organic-memory-synthetic-'));
    const storePath = path.join(directory, 'schema-v5.json');
    let repository;
    let runtime;
    try {
        await initializeEmptyMemoryStore({ storePath });
        repository = createJsonMemoryRepository({ storePath });
        await repository.open();
        const hostRepository = failCommit ? { ...repository, commit: async () => { throw new Error('synthetic_commit_failure'); } } : repository;
        const responses = new Map();
        const requests = [];
        const agentDiagnostics = [];
        const runtimeDiagnostics = [];
        let lastExtractedFacts = [];
        let toolAwaitingFinal = false;
        const ask = async request => {
            requests.push(request);
            const input = Array.isArray(request.input) ? request.input : [];
            const text = [...input].reverse().find(item => item?.role === 'user'
                && typeof item.content === 'string')?.content ?? '';
            if (request.tools?.some(item => item.name === organicFactVerifierTool)) {
                const verificationInputItem = input.find(item => item?.role === 'user'
                    && typeof item.content === 'string' && item.content.startsWith('{'));
                const verificationInput = JSON.parse(verificationInputItem.content);
                const configuredResponse = verificationResponses.get(verificationInput.currentUserMessage);
                if (configuredResponse instanceof Error) throw configuredResponse;
                if (typeof configuredResponse === 'function') return configuredResponse(verificationInput, request);
                if (configuredResponse) return configuredResponse;
                const proposedFacts = lastExtractedFacts.length
                    ? lastExtractedFacts : responses.get(verificationInput.currentUserMessage) ?? [];
                return { status: 'completed', output: [{ type: 'function_call', name: organicFactVerifierTool,
                    call_id: `verify-${Math.random()}`, arguments: JSON.stringify({ decisions:
                        verificationInput.candidates.map((candidate, candidateIndex) => {
                            const source = proposedFacts.find(item => item?.sourceQuote === candidate.quote
                                && item?.value === candidate.proposedFact && item?.attribute === candidate.topicKey);
                            const checks = {
                                supported: Boolean(source && candidate.quote === source.sourceQuote
                                    && candidate.proposedFact === source.value && candidate.topicKey === source.attribute),
                                explicit: source?.certainty === 'explicit' && source?.hypothetical === false,
                                subjectMatches: source?.subject === 'owner' || source?.subject === 'third_party',
                                temporalMatches: ['current', 'past', 'future', 'hypothetical', 'unknown'].includes(source?.temporal),
                                nonSensitive: source?.sensitivity === 'none', unambiguous: source?.ambiguous === false,
                                ...(verificationOutcomes.get(verificationInput.currentUserMessage)?.[candidateIndex] ?? {}),
                            };
                            const accepted = Object.values(checks).every(value => value === true);
                            return { candidateIndex, decision: accepted ? 'approved' : 'rejected', ...checks,
                                correctedValue: '', correctedAttribute: '', correctedTemporal: source?.temporal ?? 'current',
                                correctedValidity: source?.validity ?? 'current' };
                        }) }) }], output_text: '' };
            }
            if (!toolAwaitingFinal && request.tools?.some(item => item.name === organicTool) && responses.has(text)) {
                toolAwaitingFinal = true;
                const hints = input.filter(item => item?.role === 'user' && typeof item.content === 'string')
                    .flatMap(item => {
                        const encoded = item.content.match(/(\[[\s\S]*\])\s*$/u)?.[1];
                        if (!encoded) return [];
                        try { const parsed = JSON.parse(encoded); return Array.isArray(parsed) ? parsed : []; }
                        catch { return []; }
                    });
                for (const item of input) {
                    if (item?.type !== 'function_call_output' || typeof item.output !== 'string') continue;
                    try {
                        const payload = JSON.parse(item.output);
                        if (Array.isArray(payload?.assertions)) hints.push(...payload.assertions
                            .filter(assertion => typeof assertion?.id === 'string'
                                && typeof assertion.compatibility?.key === 'string'
                                && typeof assertion.object?.value === 'string')
                            .map(assertion => ({ assertionId: assertion.id, attribute: assertion.compatibility.key,
                                statement: assertion.object.value, subjectId: assertion.subject?.type === 'entity'
                                    ? assertion.subject.id : null })));
                    } catch { /* A non-Memory2 tool output is not an antecedent source. */ }
                }
                const facts = responses.get(text).map(item => item.priorStatement && !item.priorAssertionId
                    ? { ...item, priorAssertionId: hints.find(hint => hint.statement === item.priorStatement)?.assertionId ?? '' }
                    : item);
                lastExtractedFacts = facts;
                return toolResponse(facts);
            }
            if (toolAwaitingFinal) toolAwaitingFinal = false;
            return finalResponse();
        };
        const authInstances = [];
        const activeMode = personalMode ? 'memory2-confirmed-write' : mode;
        function agentFactory({ agentOptions }) {
            return createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: hostRepository,
                memoryContextProvider: createMemoryContextProvider({ repository: hostRepository, embeddings }),
                memoryRetrievalEnabled: true, enableSyntheticOrganicLearning: !personalMode,
                enableConfirmedMemoryWrites: personalMode, enableOrganicMemoryLearning: personalMode,
                operationalMemoryMode: activeMode, getTools: () => [], execute: async () => { throw new Error('external_tool_forbidden'); },
                ask, logger: (event, details) => agentDiagnostics.push({ event, ...details }),
                organicMemoryAuthorizationFactory: ({ repository: target, persist }) => {
                    const storeCapabilities = new WeakMap(), consentCapabilities = new WeakMap(), evidenceCapabilities = new WeakMap();
                    const persistResults = [];
                    const ownerId = 'synthetic-owner';
                    storeCapabilities.set(target, personalMode
                        ? { kind: 'memory2_personal', personalData: true, ownerId, mode: activeMode }
                        : { kind: 'synthetic_test', isolated: true, personalData: false });
                    const storeCapability = target;
                    const authorization = createOrganicMemoryAuthorization({ storeCapability,
                        verifyStoreCapability: capability => storeCapabilities.get(capability) ?? null,
                        persist: async (...args) => {
                            const result = await persist(...args);
                            persistResults.push(result);
                            if (!result?.success) agentDiagnostics.push({ event: 'synthetic_memory_write_failed',
                                code: typeof result?.error?.code === 'string' ? result.error.code : 'unknown' });
                            return result;
                        },
                        verifyConsentCapability: capability => consentCapabilities.get(capability) ?? null,
                        verifyEvidenceCapability: capability => evidenceCapabilities.get(capability) ?? null });
                    const consentCapability = Object.freeze(Object.create(null));
                    const purpose = consentMode === 'candidate_only' ? 'automatic_memory_assessment' : 'organic_memory_learning';
                    const scopes = consentMode === 'wrong_scope' ? ['daily_preferences']
                        : personalMode ? ['tool_preferences', 'entertainment_preferences', 'food_activity_preferences',
                            'interaction_preferences', 'daily_routines', 'work_patterns', 'recurring_activities',
                            'active_projects', 'interests', 'goals', 'biography', 'hobbies', 'decisions', 'everyday_facts'] : ['tool_preferences'];
                    consentCapabilities.set(consentCapability, { issuer: 'owner', synthetic: !personalMode,
                        personal: personalMode, ownerId, mode: activeMode, purpose, decision: 'granted', scopes });
                    if (consentMode !== 'absent') {
                        if (personalMode) authorization.setOwnerConsent(consentCapability, 'granted', scopes);
                        else authorization.setSyntheticConsent(consentCapability, 'granted', scopes);
                        if (consentMode === 'revoked') {
                            const revoked = Object.freeze(Object.create(null));
                            consentCapabilities.set(revoked, { issuer: 'owner', synthetic: !personalMode, personal: personalMode,
                                ownerId, mode: activeMode, purpose: 'organic_memory_learning', decision: 'revoked', scopes });
                            if (personalMode) authorization.revokeOwnerConsent(revoked);
                            else authorization.revokeSyntheticConsent(revoked);
                        }
                        if (consentMode === 'candidate_only' || consentMode === 'wrong_scope')
                            if (personalMode) authorization.setOwnerConsent(consentCapability, 'granted', scopes);
                            else authorization.setSyntheticConsent(consentCapability, 'granted', scopes);
                    }
                    authInstances.push({ authorization, evidenceCapabilities, persistResults });
                    // The test host issues an opaque capability only after Runtime has
                    // checked a direct-user quote and synthesized an allowlisted proposal.
                    return authorization;
                },
                organicEvidenceCapabilityFactory: evidence => {
                    const instance = authInstances.at(-1);
                    if (!instance || evidence.origin !== 'direct_user' || evidence.subject !== 'owner'
                        || evidence.modelOriginated !== false || typeof evidence.sourceQuote !== 'string') return null;
                    const capability = Object.freeze(Object.create(null));
                    instance.evidenceCapabilities.set(capability, { origin: 'direct_user', subject: 'owner', explicit: true,
                        certain: true, sensitive: false, ambiguous: false, thirdParty: false, modelOriginated: false,
                        ...(personalMode ? { ownerId: 'synthetic-owner' } : {}),
                        attribute: evidence.attribute, extractionConfidence: evidence.extractionConfidence,
                        ...(Object.hasOwn(evidence, 'expectedPriorAssertionId')
                            ? { expectedPriorAssertionId: evidence.expectedPriorAssertionId } : {}),
                        proposal: evidence.proposal });
                    return capability;
                },
            });
        }
        runtime = createConversationRuntime({ memoryMode: activeMode,
            diagnostic: event => runtimeDiagnostics.push(event),
            agentOptions: { deferOrganicMemoryLearning: background }, agentFactory });
        runtimeDiagnosticsByRuntime.set(runtime, { runtimeDiagnostics, agentDiagnostics });
        await callback({ directory, storePath, repository, runtime, responses, requests, authInstances,
            agentDiagnostics, runtimeDiagnostics, embeddings, verificationResponses });
    } finally {
        try { await runtime?.close(); } catch { /* preserve the original test result */ }
        try { await repository?.close(); } catch { /* preserve the original test result */ }
        await rm(directory, { recursive: true, force: true });
    }
}

test('personal organic preferences are assessed after the reply without an optional conversational tool call', async () => {
    await temporaryStore(async ({ runtime, repository, requests, responses, agentDiagnostics, runtimeDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Prefiero respuestas cortas.';
        responses.set(statement, [fact(statement, 'interaction.response_length', 'respuestas cortas')]);
        assert.match(await send(runtime, conversationId, 'background-preference', statement), /Qué tal/u);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].tools.some(tool => tool.name === organicTool), false);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'background-preference',
            text: statement, source: 'typed' }), true);
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await repository.readSnapshot()).snapshot.assertions.length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const assertions = (await repository.readSnapshot()).snapshot.assertions;
        assert.equal(assertions.length, 1, JSON.stringify(agentDiagnostics));
        assert.equal(assertions[0].compatibility.key, 'interaction.response_length');
        const searchEvent = agentDiagnostics.find(item => item.event === 'organic_memory_context_search');
        const extractionEvent = agentDiagnostics.find(item => item.event === 'organic_memory_extraction');
        const evaluationEvent = agentDiagnostics.find(item => item.event === 'organic_memory_evaluation');
        for (const event of [searchEvent, extractionEvent, evaluationEvent]) {
            assert.equal(event?.requestId, 'background-preference');
            assert.equal(event?.conversationId, conversationId);
        }
        assert.equal(searchEvent?.recoveredCount, 0);
        assert.equal(searchEvent?.deliveredCount, 0);
        assert.equal(extractionEvent?.status, 'completed');
        assert.equal(extractionEvent?.factsCount, 1);
        assert.equal(extractionEvent?.relationshipsCount, 0);
        assert.equal(evaluationEvent?.persistedCount, 1);
        assert.doesNotMatch(JSON.stringify([searchEvent, extractionEvent, evaluationEvent]),
            /Prefiero respuestas cortas|respuestas cortas/u);
        const runtimeEvent = runtimeDiagnostics.find(item => item.event === 'organic_assessment_completed');
        assert.equal(runtimeEvent?.conversationId, conversationId);
        assert.equal(runtimeEvent?.requestId, 'background-preference');
        assert.equal(runtimeEvent?.state, 'saved');
        assert.equal(runtimeEvent?.status, 'evaluated');
        const assessment = requests.find(request => request.toolChoice === 'required');
        assert.deepEqual(assessment.input, [{ role: 'user', content: statement }]);
        assert.equal(assessment.store, false);
    }, { personalMode: true, background: true });
});

test('natural response preference is learned after the reply and available in a new conversation', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const statement = 'Quiero que me respondas de manera natural y animada.';
        responses.set(statement, [fact(statement, 'interaction.response_style', 'natural y animada')]);
        const conversationId = runtime.createConversation();
        assert.match(await send(runtime, conversationId, 'natural-style', statement), /Qué tal/u);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'natural-style',
            text: statement, source: 'typed' }), true);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (agentDiagnostics.some(item => item.event === 'organic_memory_evaluation')) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const evaluation = agentDiagnostics.find(item => item.event === 'organic_memory_evaluation');
        assert.equal(evaluation?.proposedCount, 1);
        assert.equal(evaluation?.acceptedCount, 1);
        assert.equal(evaluation?.eligibleCount, 1);
        assert.equal(evaluation?.persistedCount, 1);
        assert.equal(evaluation?.createdCount, 1);
        assert.equal(evaluation?.updatedCount, 0);
        assert.equal(evaluation?.writeFailedCount, 0);
        assert.equal(JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation')).includes(statement), false,
            'organic diagnostics contain counters only, not the statement');
        const assertion = (await repository.readSnapshot()).snapshot.assertions.find(item =>
            item.compatibility?.key === 'interaction.response_style' && item.status === 'active');
        assert.equal(assertion?.object.value, 'natural y animada');
        const secondConversation = runtime.createConversation();
        await send(runtime, secondConversation, 'natural-style-recall', '¿Cómo prefiero que me respondas?');
        const request = requests.find(item => item.input.some(input => input?.type === 'function_call_output'
            && typeof input.output === 'string' && input.output.includes(assertion.object.value)));
        assert.ok(request, 'the new conversation receives the stored preference through Memory2');
    }, { personalMode: true, background: true });
});

test('equivalent response-style wording is eligible for organic Memory2 learning', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const statement = 'Prefiero que me hables de forma más espontánea.';
        responses.set(statement, [fact(statement, 'interaction.response_style', 'más espontánea')]);
        const conversationId = runtime.createConversation();
        await send(runtime, conversationId, 'spontaneous-style', statement);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'spontaneous-style',
            text: statement, source: 'typed' }), true);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (agentDiagnostics.some(item => item.event === 'organic_memory_evaluation')) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(agentDiagnostics.find(item => item.event === 'organic_memory_evaluation')?.persistedCount, 1);
        assert.ok((await repository.readSnapshot()).snapshot.assertions.some(item =>
            item.compatibility?.key === 'interaction.response_style' && item.status === 'active'));
    }, { personalMode: true, background: true });
});

test('one-response and hypothetical instructions cannot become organic response preferences', async () => {
    const cases = [
        ['En esta respuesta, sé muy breve.', 'muy breve', { certainty: 'uncertain', hypothetical: true }],
        ['En esta respuesta prefiero que seas muy breve.', 'muy breve', { certainty: 'uncertain', hypothetical: true }],
        ['Quizás prefiero que me hables de forma espontánea.', 'forma espontánea', { certainty: 'uncertain', hypothetical: true }],
        ['Quiero que me compres algo.', 'compres algo', { certainty: 'uncertain', futureIntent: true, temporal: 'future' }],
    ];
    for (const [statement, value, classification] of cases) {
        await temporaryStore(async ({ repository, runtime, responses, agentDiagnostics }) => {
            responses.set(statement, [fact(statement, 'interaction.response_style', value, classification)]);
            const conversationId = runtime.createConversation();
            await send(runtime, conversationId, 'one-response-style', statement);
            assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'one-response-style',
                text: statement, source: 'typed' }), true);
            for (let attempt = 0; attempt < 100; attempt++) {
                if (agentDiagnostics.some(item => item.event === 'organic_memory_evaluation')) break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(agentDiagnostics.find(item => item.event === 'organic_memory_evaluation')?.eligibleCount, 0);
            assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        }, { personalMode: true, background: true });
    }
});

async function send(runtime, conversationId, id, text) {
    const result = await runtime.sendMessage({ conversationId, requestId: id, text, source: 'typed' });
    const traces = runtimeDiagnosticsByRuntime.get(runtime);
    const failureTrace = result.status === 'completed' ? undefined
        : {
            runtime: traces?.runtimeDiagnostics.filter(item => item.event === 'request_failed'
                && item.requestId === id).at(-1),
            agent: traces?.agentDiagnostics.filter(item => item.event === 'agent_run_failed'
                && item.requestId === id).at(-1),
        };
    assert.equal(result.status, 'completed', JSON.stringify({ result, failureTrace }));
    return result.text;
}

test('favorite beverage persists, changes in the same slot, and remains historically retrievable', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const coffee = 'Mi bebida favorita es el café.';
        const teaChange = 'Cambié de gustos. Ahora mi bebida favorita es el té.';
        const teaQuote = 'Ahora mi bebida favorita es el té.';
        responses.set(coffee, [fact(coffee, 'food.beverage_favorite', 'café')]);
        responses.set(teaChange, [fact(teaQuote, 'food.beverage_favorite', 'té',
            { priorStatement: 'café' })]);
        responses.set(teaQuote, [fact(teaQuote, 'food.beverage_favorite', 'té')]);
        await send(runtime, conversationId, 'beverage-coffee', coffee);
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 1, JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation')));
        assert.equal(snapshot.assertions[0].object.value, 'café');
        assert.equal(agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1).createdCount, 1);

        await send(runtime, conversationId, 'beverage-tea', teaChange);
        snapshot = (await repository.readSnapshot()).snapshot;
        const beverage = snapshot.assertions.filter(item => item.compatibility?.key === 'food.beverage_favorite');
        assert.equal(beverage.length, 2);
        const current = beverage.find(item => item.status === 'active');
        const previous = beverage.find(item => item.status === 'superseded');
        assert.equal(current.object.value, 'té');
        assert.equal(previous.object.value, 'café');
        assert.deepEqual(current.supersedes, [previous.id]);
        await send(runtime, conversationId, 'beverage-duplicate', teaQuote);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 2);
        const duplicateDiagnostics = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(duplicateDiagnostics.unchangedCount, 1);
        assert.equal(duplicateDiagnostics.factWriteOutcomeCounts.equivalent, 1);
        const anotherConversation = runtime.createConversation();
        assert.notEqual(anotherConversation, conversationId);
        await send(runtime, anotherConversation, 'beverage-new-conversation', '¿Cuál es mi bebida favorita?');
        const newConversationRequest = requests.findLast(request => request.input.some(item => item?.role === 'user'
            && item.content === '¿Cuál es mi bebida favorita?'));
        assert.ok(newConversationRequest.input.some(item => item?.type === 'function_call_output'
            && item.output.includes('té')));
        const context = createMemoryContextProvider({ repository, embeddings: fixtureEmbeddings });
        const now = await context.search({ query: 'bebida favorita' });
        assert.equal(now.status, 'found');
        assert.ok(now.assertions.some(item => item.object.value === 'té'));
        assert.deepEqual(now.conflicts, []);
        const history = await context.search({ query: 'bebida favorita', temporal: 'history' });
        assert.ok(history.assertions.some(item => item.object.value === 'café'));

    }, { personalMode: true });
});

test('beverage proposals reject one-off wishes, hypotheticals, questions, and unsupported attributes with safe codes', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const examples = [
            ['Hoy quiero tomar café.', 'café'],
            ['Quizás mi bebida favorita sea el café.', 'café'],
            ['¿Mi bebida favorita es el café?', 'café'],
        ];
        for (const [index, [message, value]] of examples.entries()) {
            responses.set(message, [fact(message, 'food.beverage_favorite', value,
                { certainty: 'uncertain', hypothetical: true })]);
            await send(runtime, conversationId, `beverage-negative-${index}`, message);
            const diagnostic = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
            assert.equal(diagnostic.rejectionCodes.semantic_verification_rejected, 1);
            assert.equal(requests.some(request => request.tools?.some(tool => tool.name === organicFactVerifierTool)), true,
                'the candidate reaches semantic verification instead of a local language filter');
        }
        const unsupported = 'Mi bebida favorita es el café.';
        responses.set(unsupported, [fact(unsupported, 'beverage.favorite', 'café')]);
        await send(runtime, conversationId, 'beverage-unsupported', unsupported);
        const diagnostic = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(diagnostic.createdCount, 1);
        assert.doesNotMatch(JSON.stringify(diagnostic), /café|bebida favorita/u);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 1,
            'a syntactically valid but unfamiliar everyday topic uses the general fact representation');
    }, { personalMode: true });
});

test('verifier diagnostics expose only failed semantic checks and distinguish technical failures', async () => {
    const verificationOutcomes = new Map();
    const verificationResponses = new Map();
    await temporaryStore(async ({ runtime, responses, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const checks = ['supported', 'explicit', 'subjectMatches', 'temporalMatches', 'nonSensitive', 'unambiguous'];
        for (const [index, field] of checks.entries()) {
            const message = `Synthetic direct statement ${index}.`;
            responses.set(message, [fact(message, `general.synthetic_${index}`, `value ${index}`)]);
            verificationOutcomes.set(message, [{ [field]: false }]);
            const result = await send(runtime, conversationId, `verifier-check-${field}`, message);
            assert.match(result, /Qué tal/u);
            const event = agentDiagnostics.filter(item => item.event === 'organic_memory_fact_verification').at(-1);
            assert.equal(event.outcome, 'rejected', JSON.stringify(agentDiagnostics.filter(item =>
                ['organic_memory_fact_verification', 'agent_run_failed'].includes(item.event))));
            assert.equal(event.failureClass, 'semantic_rejection');
            assert.equal(event.rejectedChecks[field], 1);
            assert.equal(Object.entries(event.rejectedChecks).filter(([, count]) => count > 0).length, 1);
            assert.equal(event.thirdPartyCandidateCount, 0);
            assert.equal(event.thirdPartyLearningEnabled, false);
            assert.doesNotMatch(JSON.stringify(event), /Synthetic direct statement|value /u);
        }
        const technicalMessage = 'Synthetic technical failure statement.';
        responses.set(technicalMessage, [fact(technicalMessage, 'general.synthetic_technical', 'synthetic value')]);
        verificationResponses.set(technicalMessage, { status: 'incomplete', output: [] });
        await send(runtime, conversationId, 'verifier-technical-failure', technicalMessage);
        const technicalEvent = agentDiagnostics.filter(item => item.event === 'organic_memory_fact_verification').at(-1);
        assert.equal(technicalEvent.outcome, 'malformed');
        assert.equal(technicalEvent.failureClass, 'technical_failure');
        assert.deepEqual(technicalEvent.rejectedChecks, { supported: 0, explicit: 0, subjectMatches: 0,
            temporalMatches: 0, nonSensitive: 0, unambiguous: 0 });
        assert.doesNotMatch(JSON.stringify(technicalEvent), /Synthetic technical failure|synthetic value/u);
    }, { personalMode: true, verificationOutcomes, verificationResponses });
});

test('one verifier pass can approve a faithful correction and reports outcomes without exposing candidate content', async () => {
    const verificationResponses = new Map();
    await temporaryStore(async ({ runtime, repository, requests, responses, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const approvedMessage = 'Synthetic event statement for correction approval.';
        const rejectedMessage = 'Synthetic event statement for correction rejection.';
        const invalidMessage = 'Synthetic event statement for invalid correction.';
        for (const [message, result] of [[approvedMessage, 'accepted'], [rejectedMessage, 'rejected'], [invalidMessage, 'invalid']]) {
            responses.set(message, [fact(message, 'general.synthetic_event', 'synthetic event', { temporal: 'current' })]);
            verificationResponses.set(message, input => {
                assert.equal(input.candidates.length, 1);
                const checks = { supported: true, explicit: result !== 'rejected', subjectMatches: true,
                    temporalMatches: false, nonSensitive: true, unambiguous: true };
                return { status: 'completed', output: [{ type: 'function_call', name: organicFactVerifierTool,
                    call_id: `verify-diagnostic-${result}`, arguments: JSON.stringify({ decisions: [{ candidateIndex: 0,
                        decision: 'correctable', ...checks, correctedValue: result === 'invalid' ? '' : 'faithful synthetic event',
                        correctedAttribute: result === 'invalid' ? '' : input.candidates[0].topicKey,
                        correctedTemporal: 'current', correctedValidity: 'current' }] }) }], output_text: '' };
            });
        }
        await send(runtime, conversationId, 'correction-approved', approvedMessage);
        await send(runtime, conversationId, 'correction-rejected', rejectedMessage);
        await send(runtime, conversationId, 'correction-invalid', invalidMessage);

        const events = agentDiagnostics.filter(item => item.event === 'organic_memory_fact_verification');
        assert.equal(events.length, 3);
        assert.deepEqual(events[0].correctionCounts, { proposed: 1, accepted: 1, rejected: 0, invalid: 0, technicalFailures: 0 });
        assert.equal(events[0].verificationPass.decisions[0].decision, 'correctable');
        assert.equal(events[0].verificationPass.rejectedChecks.temporalMatches, 1);
        assert.equal(events[0].outcome, 'approved');
        assert.equal(events[0].failureClass, 'none');

        assert.deepEqual(events[1].correctionCounts, { proposed: 1, accepted: 0, rejected: 1, invalid: 0, technicalFailures: 0 });
        assert.equal(events[1].verificationPass.status, 'semantic_rejection');
        assert.equal(events[1].verificationPass.rejectedChecks.explicit, 1);
        assert.equal(events[1].outcome, 'correction_rejected');
        assert.equal(events[1].failureClass, 'semantic_rejection');

        assert.deepEqual(events[2].correctionCounts, { proposed: 1, accepted: 0, rejected: 0, invalid: 1, technicalFailures: 0 });
        assert.equal(events[2].verificationPass.status, 'malformed');
        assert.equal(events[2].outcome, 'correction_invalid');
        assert.equal(events[2].failureClass, 'technical_failure');
        const verifierCalls = new Map();
        for (const request of requests) {
            if (!request.tools?.some(tool => tool.name === organicFactVerifierTool)) continue;
            const payload = JSON.parse(request.input.find(item => item?.role === 'user' && item.content?.startsWith('{')).content);
            verifierCalls.set(payload.currentUserMessage, (verifierCalls.get(payload.currentUserMessage) ?? 0) + 1);
        }
        assert.deepEqual([...verifierCalls.values()], [1, 1, 1], 'each candidate batch uses exactly one semantic verification request');
        const acceptedSnapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(acceptedSnapshot.assertions.length, 1,
            'only the semantically accepted correction can reach persistence');
        const acceptedEvaluation = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation')[0];
        assert.equal(acceptedEvaluation.verifierApprovedCount, 1);
        assert.equal(acceptedEvaluation.acceptedCount, 1);
        assert.equal(acceptedEvaluation.persistedCount, 1,
            'a locally valid corrected candidate must reach and complete the Memory2 write');
        assert.equal(acceptedEvaluation.createdCount, 1);
        assert.equal(acceptedEvaluation.rejectedCount, 0);
        assert.equal(acceptedEvaluation.postVerificationRejectedCount, 0);
        assert.doesNotMatch(JSON.stringify(events), /Synthetic event statement|synthetic event|faithful synthetic/u);
    }, { personalMode: true, verificationResponses });
});

test('semantic approval followed by local correction rejection reports its exact gate once and never writes', async () => {
    const verificationResponses = new Map();
    await temporaryStore(async ({ repository, runtime, responses, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const message = 'Synthetic assertion whose corrected value fails local privacy screening.';
        responses.set(message, [fact(message, 'general.synthetic_topic', 'synthetic topic', { temporal: 'current' })]);
        verificationResponses.set(message, input => ({ status: 'completed', output: [{ type: 'function_call',
            name: organicFactVerifierTool, call_id: 'verify-local-correction-contract',
            arguments: JSON.stringify({ decisions: [{ candidateIndex: 0, decision: 'correctable',
                supported: true, explicit: true, subjectMatches: true, temporalMatches: false,
                nonSensitive: true, unambiguous: true, correctedValue: 'sk-123456789012345678901234',
                correctedAttribute: input.candidates[0].topicKey, correctedTemporal: 'current', correctedValidity: 'current' }] })
        }], output_text: '' }));

        await send(runtime, conversationId, 'local-correction-contract', message);

        const verification = agentDiagnostics.filter(item => item.event === 'organic_memory_fact_verification').at(-1);
        assert.equal(verification.outcome, 'approved');
        assert.equal(verification.approvedCount, 1);
        assert.equal(verification.correctionCounts.accepted, 1);
        const evaluation = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(evaluation.verifierApprovedCount, 1,
            'semantic approval is distinct from passing the local persistence contract');
        assert.equal(evaluation.eligibleCount, 0);
        assert.equal(evaluation.acceptedCount, 0);
        assert.equal(evaluation.rejectedCount, 1,
            'the same candidate is counted once, not again as semantic rejection');
        assert.equal(evaluation.rejectionCodes.corrected_candidate_statement_ineligible, 1);
        assert.equal(evaluation.postVerificationRejectedCount, 1);
        assert.equal(evaluation.postVerificationRejectionCodes.corrected_candidate_statement_ineligible, 1);
        assert.equal(evaluation.persistedCount, 0);
        assert.equal(evaluation.writeFailedCount, 0,
            'a candidate rejected before the write is not reported as a storage failure');
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
        assert.doesNotMatch(JSON.stringify([verification, evaluation]), /Synthetic assertion|synthetic topic|sk-123456789012345678901234/u);
    }, { personalMode: true, verificationResponses });
});

test('semantic correction cannot replace an already validated technical topic key', async () => {
    const verificationResponses = new Map();
    await temporaryStore(async ({ repository, runtime, responses, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const message = 'Synthetic assertion with a correction that changes its technical topic key.';
        responses.set(message, [fact(message, 'general.synthetic_topic', 'synthetic topic', { temporal: 'current' })]);
        verificationResponses.set(message, input => ({ status: 'completed', output: [{ type: 'function_call',
            name: organicFactVerifierTool, call_id: 'verify-topic-key-preservation',
            arguments: JSON.stringify({ decisions: [{ candidateIndex: 0, decision: 'correctable',
                supported: true, explicit: true, subjectMatches: true, temporalMatches: false,
                nonSensitive: true, unambiguous: true, correctedValue: 'faithful synthetic topic',
                correctedAttribute: 'general.different_topic', correctedTemporal: 'current', correctedValidity: 'current' }] })
        }], output_text: '' }));

        await send(runtime, conversationId, 'topic-key-preservation', message);

        const verification = agentDiagnostics.filter(item => item.event === 'organic_memory_fact_verification').at(-1);
        assert.equal(verification.outcome, 'correction_invalid');
        assert.equal(verification.approvedCount, 0);
        assert.equal(verification.correctionCounts.proposed, 1);
        assert.equal(verification.correctionCounts.accepted, 0);
        assert.equal(verification.correctionCounts.invalid, 1);
        const evaluation = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(evaluation.verifierApprovedCount, 0);
        assert.equal(evaluation.acceptedCount, 0);
        assert.equal(evaluation.persistedCount, 0);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, 0);
    }, { personalMode: true, verificationResponses });
});

test('post-verifier diagnostics identify missing antecedents without exposing candidate content', async () => {
    await temporaryStore(async ({ runtime, responses, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const message = 'Synthetic prior-state assertion for diagnostic coverage.';
        responses.set(message, [fact(message, 'general.synthetic_prior_state', 'synthetic prior state', {
            temporal: 'past', priorStatement: 'a prior state that was not supplied by Memory2' })]);
        await send(runtime, conversationId, 'post-verifier-missing-prior', message);
        const evaluation = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(evaluation.verifierApprovedCount, 1);
        assert.equal(evaluation.eligibleCount, 1);
        assert.equal(evaluation.postVerificationRejectedCount, 1);
        assert.equal(evaluation.postVerificationRejectionCodes.prior_statement_mismatch, 1);
        assert.equal(evaluation.postValidationPassedCount, 0);
        assert.deepEqual(evaluation.factWriteOutcomeCounts,
            { created: 0, updated: 0, equivalent: 0, failed: 0, unexpected: 0 });
        assert.doesNotMatch(JSON.stringify(evaluation), /Synthetic prior-state|synthetic prior state/u);
    }, { personalMode: true });
});

test('new everyday topics use one generic contract and an explicit ending supersedes the prior state', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests }) => {
        const conversationId = runtime.createConversation();
        const examples = [
            ['Colecciono mapas antiguos.', 'general.collection_maps', 'Colecciono mapas antiguos.'],
            ['Estoy aprendiendo cerámica.', 'general.learning_ceramics', 'Estoy aprendiendo cerámica.'],
            ['Mi color favorito es verde.', 'general.favorite_color', 'Mi color favorito es verde.'],
            ['Prefiero trabajar de noche.', 'general.work_time', 'Prefiero trabajar de noche.'],
            ['Me gusta registrar cómo cambia la luz del atardecer en las fachadas.', 'general.light_observation',
                'I document how sunset illumination changes across building fronts.'],
        ];
        for (const [index, [quote, attribute, value]] of examples.entries()) {
            responses.set(quote, [fact(quote, attribute, value)]);
            await send(runtime, conversationId, `general-${index}`, quote);
        }
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, examples.length);
        assert.ok(snapshot.assertions.every(item => item.predicate === 'personal.fact'
            && item.status === 'active' && item.compatibility.category === 'fact'));
        const organicRequest = requests.find(item => item.tools?.some(tool => tool.name === organicTool));
        assert.match(organicRequest.tools.find(tool => tool.name === organicTool)
            .parameters.properties.facts.items.properties.attribute.description, /general\.<short_topic>/u);
        const verifierRequest = requests.find(item => item.tools?.some(tool => tool.name === organicFactVerifierTool));
        const verifierInput = JSON.parse(verifierRequest.input[0].content);
        assert.deepEqual(Object.keys(verifierInput).sort(), ['candidates', 'currentUserMessage']);
        assert.ok(!JSON.stringify(verifierInput).includes('history'));
        assert.ok(!JSON.stringify(verifierInput).includes('Memoria activa'));

        const ending = 'Ya no colecciono mapas antiguos.';
        responses.set(ending, [fact(ending, 'general.collection_maps', ending,
            { temporal: 'past', priorStatement: 'Colecciono mapas antiguos.' })]);
        await send(runtime, conversationId, 'general-ending', ending);
        snapshot = (await repository.readSnapshot()).snapshot;
        const maps = snapshot.assertions.filter(item => item.compatibility?.key === 'general.collection_maps');
        assert.equal(maps.length, 2);
        assert.equal(maps.find(item => item.status === 'active').object.value, ending);
        assert.deepEqual(maps.find(item => item.status === 'active').supersedes,
            [maps.find(item => item.status === 'superseded').id]);
        const provider = createMemoryContextProvider({ repository, embeddings: fixtureEmbeddings });
        const indirect = await provider.search({ query: 'Quiero decorar mi escritorio.' });
        assert.ok(indirect.assertions.some(item => item.object?.value === 'Estoy aprendiendo cerámica.'),
            'semantic retrieval can select an unrelated-surface paraphrase for the conversational model');
        const current = await provider.search({ query: 'colecciono mapas' });
        assert.ok(current.assertions.some(item => item.object.value === ending));
        assert.ok(!current.assertions.some(item => item.object.value === 'Colecciono mapas antiguos.'));
        const history = await provider.search({ query: 'colecciono mapas', temporal: 'history' });
        assert.ok(history.assertions.some(item => item.object.value === 'Colecciono mapas antiguos.'));

        const tentative = 'Quizás coleccione acuarelas.';
        responses.set(tentative, [fact(tentative, 'general.collection_watercolors', tentative,
            { certainty: 'uncertain', hypothetical: true, temporal: 'hypothetical' })]);
        await send(runtime, conversationId, 'general-hypothesis', tentative);
        const oneOff = 'Hoy quiero coleccionar sellos.';
        responses.set(oneOff, [fact(oneOff, 'general.collection_stamps', oneOff,
            { certainty: 'uncertain', hypothetical: true })]);
        await send(runtime, conversationId, 'general-one-off', oneOff);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, examples.length + 1);
    }, { personalMode: true });
});

test('a differently worded general update uses one bounded comparison in the existing extractor call', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        async function learn(id, message) {
            const completed = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length;
            await send(runtime, conversationId, id, message);
            assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: id,
                text: message, source: 'typed' }), true);
            for (let attempt = 0; attempt < 100; attempt++) {
                if (agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length > completed) return;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.fail('the synthetic assessment did not complete');
        }
        const original = 'Mi color favorito es verde.';
        const update = 'El color que más me gusta es azul.';
        responses.set(original, [fact(original, 'general.favorite_color', original)]);
        await learn('color-first', original);
        const originalAssertion = (await repository.readSnapshot()).snapshot.assertions
            .find(item => item.compatibility?.key === 'general.favorite_color' && item.status === 'active');
        responses.set(update, [fact(update, 'general.favorite_color', update,
            { priorStatement: original })]);
        const before = requests.length;
        await learn('color-update', update);
        const assessment = requests.slice(before).find(request => request.toolChoice === 'required');
        assert.equal(assessment.input.length, 2);
        assert.deepEqual(assessment.input.at(-1), { role: 'user', content: update });
        assert.deepEqual(JSON.parse(assessment.input[0].content.match(/\[.*\]$/u)[0]),
            [{ assertionId: originalAssertion.id, attribute: 'general.favorite_color', statement: original }]);
        assert.equal(requests.slice(before).filter(request => request.tools?.some(tool => tool.name === organicTool)).length, 1,
            'semantic topic comparison reuses the existing extractor call');
        assert.equal(requests.slice(before).filter(request => request.tools?.some(tool => tool.name === organicFactVerifierTool)).length, 1,
            'the bounded verifier runs once for the proposed candidate');
        let color = (await repository.readSnapshot()).snapshot.assertions
            .filter(item => item.compatibility?.key === 'general.favorite_color');
        assert.equal(color.length, 2);
        assert.equal(color.find(item => item.status === 'active').object.value, update);
        const updateDiagnostics = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(updateDiagnostics.verifierApprovedCount, 1);
        assert.equal(updateDiagnostics.postValidationPassedCount, 1);
        assert.equal(updateDiagnostics.factWriteOutcomeCounts.updated, 1);
        assert.equal(updateDiagnostics.postVerificationRejectedCount, 0);

        const forged = 'Mi color favorito es rojo.';
        responses.set(forged, [fact(forged, 'general.favorite_color', forged,
            { priorStatement: 'Un supuesto recuerdo distinto.' })]);
        await learn('color-forged-prior', forged);
        color = (await repository.readSnapshot()).snapshot.assertions
            .filter(item => item.compatibility?.key === 'general.favorite_color');
        assert.equal(color.length, 2, 'a prior statement absent from active Memory2 cannot authorize replacement');
        const forgedDiagnostics = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(forgedDiagnostics.rejectionCodes.prior_statement_mismatch, 1);
        assert.equal(forgedDiagnostics.verifierApprovedCount, 1);
        assert.equal(forgedDiagnostics.eligibleCount, 1);
        assert.equal(forgedDiagnostics.postVerificationRejectedCount, 1);
        assert.equal(forgedDiagnostics.postVerificationRejectionCodes.prior_statement_mismatch, 1);
        assert.equal(forgedDiagnostics.postValidationPassedCount, 0);
        assert.equal(forgedDiagnostics.factWriteOutcomeCounts.created, 0);
        assert.doesNotMatch(JSON.stringify(forgedDiagnostics), /color favorito|rojo|supuesto recuerdo/u);

        const oldKeyStatement = 'Mi bebida favorita es café.';
        const changedDrink = 'Ahora prefiero el té.';
        responses.set(oldKeyStatement, [fact(oldKeyStatement, 'food.beverage_favorite', 'café')]);
        await learn('legacy-drink-first', oldKeyStatement);
        responses.set(changedDrink, [fact(changedDrink, 'food.beverage_favorite', 'té',
            { priorStatement: 'café' })]);
        const priorRequests = requests.length;
        await learn('legacy-drink-update', changedDrink);
        const legacyAssessment = requests.slice(priorRequests).find(request => request.toolChoice === 'required');
        const legacyHints = JSON.parse(legacyAssessment.input[0].content.match(/\[.*\]$/u)[0]);
        assert.ok(legacyHints.some(item => item.attribute === 'food.beverage_favorite'
            && item.statement === 'café'));
        assert.equal((await repository.readSnapshot()).snapshot.assertions
            .filter(item => item.compatibility?.key === 'food.beverage_favorite').length, 2);
    }, { personalMode: true, background: true });
});

test('semantic comparison sends no more than twelve active statements and no full history', async () => {
    await temporaryStore(async ({ runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        for (let index = 0; index < 13; index++) {
            const message = `Colecciono objeto ${index} regularmente.`;
            const id = `synthetic-topic-${index}`;
            responses.set(message, [fact(message, `general.collection_${index}`, message)]);
            await send(runtime, conversationId, id, message);
            const completed = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length;
            assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: id,
                text: message, source: 'typed' }), true);
            for (let attempt = 0; attempt < 100; attempt++) {
                if (agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length > completed) break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.equal(agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length,
                completed + 1);
        }
        const lastAssessment = requests.filter(request => request.tools?.some(tool => tool.name === organicTool)).at(-1);
        assert.equal(lastAssessment.input.length, 2);
        const hints = JSON.parse(lastAssessment.input[0].content.match(/\[.*\]$/u)[0]);
        assert.ok(hints.length > 0 && hints.length <= 12);
        assert.ok(hints.every(item => Object.keys(item).join(',') === 'assertionId,attribute,statement'));
        assert.deepEqual(lastAssessment.input.at(-1),
            { role: 'user', content: 'Colecciono objeto 12 regularmente.' });
    }, { personalMode: true, background: true });
});

test('organic updates find an old semantic antecedent beyond twelve newer memories and preserve its history', async () => {
    const oldStatement = 'Mi pasatiempo tranquilo es armar pequeños planeadores de madera y probarlos al aire libre.';
    const changedStatement = 'Me resulta reparador diseñar planeadores pequeños y hacerlos volar al aire libre.';
    const embeddings = { model: 'synthetic-topic-vectors-v1', async embedMany(texts) {
        return texts.map(text => text.includes('planeadores de madera') || text.includes('planeadores en miniatura')
            || text.includes('Me resulta reparador') || text.includes('actividad creativa')
            ? [1, 0] : [0, 1]);
    } };
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        async function learn(id, message, candidates) {
            const previous = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length;
            responses.set(message, candidates);
            await send(runtime, conversationId, id, message);
            assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: id,
                text: message, source: 'typed' }), true);
            for (let attempt = 0; attempt < 200; attempt++) {
                if (agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length > previous) return;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            assert.fail('the synthetic assessment did not complete');
        }
        await learn('old-topic', oldStatement, [fact(oldStatement, 'general.recreation', oldStatement)]);
        for (let index = 0; index < 14; index++) {
            const message = `A veces anoto una observación independiente número ${index}.`;
            await learn(`noise-${index}`, message, [fact(message, `general.note_${index}`, message)]);
        }
        const old = (await repository.readSnapshot()).snapshot.assertions
            .find(item => item.compatibility?.key === 'general.recreation');
        assert.ok(old);
        const before = requests.length;
        await learn('semantic-update', changedStatement,
            [fact(changedStatement, 'general.recreation', 'Ahora construyo planeadores en miniatura.',
                { priorStatement: old.object.value })]);
        const assessment = requests.slice(before).find(request => request.toolChoice === 'required');
        const hints = JSON.parse(assessment.input[0].content.match(/\[.*\]$/u)[0]);
        assert.ok(hints.length <= 12);
        assert.ok(hints.some(item => item.attribute === 'general.recreation' && item.statement === old.object.value),
            'the relevant older record is selected by the semantic index despite fourteen newer records');
        assert.deepEqual(assessment.input.at(-1), { role: 'user', content: changedStatement });

        const history = (await repository.readSnapshot()).snapshot.assertions
            .filter(item => item.compatibility?.key === 'general.recreation');
        assert.equal(history.length, 2);
        assert.equal(history.find(item => item.status === 'active').object.value,
            'Ahora construyo planeadores en miniatura.');
        assert.equal(history.find(item => item.status === 'superseded').object.value, old.object.value);
        const contextProvider = createMemoryContextProvider({ repository, embeddings });
        const current = await contextProvider.search({ query: 'actividad creativa' });
        assert.ok(current.assertions.some(item => item.object.value === 'Ahora construyo planeadores en miniatura.'));
        const historical = await contextProvider.search({ query: 'actividad creativa', temporal: 'history' });
        assert.ok(historical.assertions.some(item => item.object.value === old.object.value));
        assert.equal(agentDiagnostics.filter(item => item.event === 'organic_memory_indexing').at(-1)?.status,
            'ready', 'the confirmed update is indexed incrementally after the Store write');
    }, { personalMode: true, background: true, embeddings });
});

test('an unavailable semantic index cannot authorize an organic overwrite', async () => {
    let unavailable = false;
    const embeddings = { model: 'synthetic-failable-v1', async embedMany(texts) {
        if (unavailable) throw new Error('synthetic_embedding_failure');
        return texts.map(text => text.includes('watercolor') ? [1, 0] : [0, 1]);
    } };
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const original = 'I spend quiet weekends painting watercolor landscapes.';
        responses.set(original, [fact(original, 'general.weekend_activity', original)]);
        await send(runtime, conversationId, 'semantic-failure-seed', original);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'semantic-failure-seed',
            text: original, source: 'typed' }), true);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (agentDiagnostics.some(item => item.event === 'organic_memory_evaluation')) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const before = (await repository.readSnapshot()).snapshot;
        assert.equal(before.assertions.length, 1);
        unavailable = true;
        const update = 'Me sigue resultando revitalizante pintar escenas de acuarela al aire libre.';
        responses.set(update, [fact(update, 'general.weekend_activity', 'I now paint watercolor scenes outdoors.',
            { priorStatement: before.assertions[0].object.value })]);
        await send(runtime, conversationId, 'semantic-failure-update', update);
        assert.equal(runtime.scheduleOrganicAssessment({ conversationId, requestId: 'semantic-failure-update',
            text: update, source: 'typed' }), true);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').length >= 2) break;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        const assessment = requests.filter(request => request.tools?.some(tool => tool.name === organicTool)).at(-1);
        assert.deepEqual(assessment.input, [{ role: 'user', content: update }],
            'an unavailable semantic search supplies no unranked antecedents');
        const after = (await repository.readSnapshot()).snapshot;
        assert.equal(after.assertions.length, 1);
        assert.equal(after.assertions[0].object.value, before.assertions[0].object.value);
        assert.equal(agentDiagnostics.at(-1).rejectionCodes.prior_statement_mismatch, 1);
    }, { personalMode: true, background: true, embeddings });
});

test('organic learning writes two independent editor attributes, updates history without duplicates, and retrieves them after Runtime restart', async () => {
    await temporaryStore(async ({ storePath, repository, runtime, responses, requests }) => {
        const conversationId = runtime.createConversation();
        const seed = 'Uso Windsurf todos los días para trabajar.';
        responses.set(seed, [fact(seed, 'editor.habitual', 'Windsurf')]);
        assert.match(await send(runtime, conversationId, 'organic-seed', seed), /Qué tal/u);

        const statement = 'Últimamente estoy usando Cursor para trabajar todos los días. Zed me sigue gustando para hacer pruebas.';
        responses.set(statement, [
            fact('Últimamente estoy usando Cursor para trabajar todos los días', 'editor.habitual', 'Cursor', {
                priorStatement: 'Windsurf' }),
            fact('Zed me sigue gustando para hacer pruebas', 'editor.testing_favorite', 'Zed'),
        ]);
        assert.match(await send(runtime, conversationId, 'organic-two-facts', statement), /Qué tal/u);
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 3);
        const habitual = snapshot.assertions.filter(item => item.compatibility?.key === 'editor.habitual');
        assert.equal(habitual.length, 2);
        assert.equal(habitual.find(item => item.status === 'active').object.value, 'Cursor');
        assert.equal(habitual.find(item => item.status === 'superseded').object.value, 'Windsurf');
        assert.deepEqual(habitual.find(item => item.status === 'active').supersedes, [habitual.find(item => item.status === 'superseded').id]);
        const testing = snapshot.assertions.find(item => item.compatibility?.key === 'editor.testing_favorite');
        assert.equal(testing.object.value, 'Zed');
        assert.equal(snapshot.evidence.length, 3);
        assert.ok(snapshot.evidence.every(item => item.derivation === 'inferred' && item.extraction_confidence === 0.95));

        const beforeDuplicate = snapshot.revision;
        assert.match(await send(runtime, conversationId, 'organic-duplicate', statement), /Qué tal/u);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.revision, beforeDuplicate);
        assert.equal(snapshot.assertions.length, 3);

        const past = 'Antes usaba Windsurf.';
        responses.set(past, [fact(past, 'editor.habitual', 'Windsurf', { temporal: 'past' })]);
        await send(runtime, conversationId, 'organic-past-only', past);
        const uncertain = 'Quizás vuelva a Windsurf.';
        responses.set(uncertain, [fact(uncertain, 'editor.habitual', 'Windsurf', { certainty: 'uncertain', temporal: 'future' })]);
        await send(runtime, conversationId, 'organic-uncertain', uncertain);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.revision, beforeDuplicate);
        assert.equal(snapshot.assertions.find(item => item.compatibility?.key === 'editor.habitual' && item.status === 'active')
            .object.value, 'Cursor');

        await runtime.close();
        await repository.close();
        const reopened = createJsonMemoryRepository({ storePath });
        await reopened.open();
        const retrievalRequests = [];
        const retrievalRuntime = createConversationRuntime({ memoryMode: 'memory2', agentFactory: ({ agentOptions }) =>
            createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: reopened,
                memoryContextProvider: createMemoryContextProvider({ repository: reopened, embeddings: fixtureEmbeddings }),
                memoryRetrievalEnabled: true, getTools: () => [], ask: async request => {
                    retrievalRequests.push(request);
                    return finalResponse('Tu editor habitual es Cursor y preferís Zed para pruebas.');
                } }) });
        try {
            const newConversation = retrievalRuntime.createConversation();
            await send(retrievalRuntime, newConversation, 'organic-restart-recall', '¿Cuál es mi editor habitual y cuál uso para pruebas?');
            const memoryPayload = retrievalRequests.flatMap(request => request.input)
                .filter(item => item?.type === 'function_call_output' && typeof item.output === 'string')
                .map(item => { try { return JSON.parse(item.output); } catch { return null; } })
                .find(payload => Array.isArray(payload?.assertions));
            assert.ok(memoryPayload, 'the restarted Runtime provides a Memory2 context payload');
            assert.ok(memoryPayload.assertions.some(item => item.object?.value === 'Cursor'));
            assert.ok(memoryPayload.assertions.some(item => item.object?.value === 'Zed'));
        } finally {
            await retrievalRuntime.close();
            await reopened.close();
        }
        assert.ok(requests.length >= 6);
    }, { personalMode: true });
});

test('personal Desktop learning covers preferences, routines, projects, interests and explicit goals with stable slots', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests }) => {
        const conversationId = runtime.createConversation();
        const message = 'Me encanta cocinar comida tailandesa. Suelo salir a caminar por las mañanas. Estoy trabajando en el proyecto Atlas. Me interesa la astronomía.';
        responses.set(message, [
            fact('Me encanta cocinar comida tailandesa.', 'food.cuisine', 'comida tailandesa'),
            fact('Suelo salir a caminar por las mañanas.', 'routine.morning_walk', 'salir a caminar por las mañanas'),
            fact('Estoy trabajando en el proyecto Atlas.', 'project.atlas', 'el proyecto Atlas'),
            fact('Me interesa la astronomía.', 'interest.astronomy', 'la astronomía'),
        ]);
        await send(runtime, conversationId, 'personal-organic-categories', message);
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 4);
        assert.deepEqual(new Set(snapshot.assertions.map(item => item.compatibility.category)),
            new Set(['preference', 'routine', 'project', 'fact']));

        const goal = 'Mi objetivo actual es aprender japonés.';
        responses.set(goal, [fact(goal, 'goal.learn_japanese', 'aprender japonés', { futureIntent: true })]);
        await send(runtime, conversationId, 'personal-organic-goal', goal);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 5);
        assert.equal(snapshot.assertions.find(item => item.compatibility.key === 'goal.learn_japanese').object.value,
            goal);

        const update = 'Mi objetivo actual es terminar el curso de japonés.';
        responses.set(update, [fact(update, 'goal.learn_japanese', 'terminar el curso de japonés', { futureIntent: true,
            priorStatement: goal })]);
        await send(runtime, conversationId, 'personal-organic-goal-update', update);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.filter(item => item.compatibility.key === 'goal.learn_japanese').length, 2);
        assert.equal(snapshot.assertions.find(item => item.compatibility.key === 'goal.learn_japanese' && item.status === 'active').object.value,
            update);

        const beforeDuplicate = snapshot.revision;
        await send(runtime, conversationId, 'personal-organic-goal-duplicate', update);
        assert.equal((await repository.readSnapshot()).snapshot.revision, beforeDuplicate);

        const rejectedMessages = [
            ['Quizás vuelva a cocinar comida tailandesa.', fact('Quizás vuelva a cocinar comida tailandesa.', 'food.cuisine', 'comida tailandesa',
                { certainty: 'uncertain', temporal: 'future', futureIntent: true })],
            ['Por ejemplo, me interesa la astronomía.', fact('Por ejemplo, me interesa la astronomía.', 'interest.astronomy', 'la astronomía')],
            ['Mi objetivo es pagar mi deuda médica.', fact('Mi objetivo es pagar mi deuda médica.', 'goal.pay_debt', 'pagar mi deuda médica', { futureIntent: true })],
        ];
        for (const [text, proposal] of rejectedMessages) {
            responses.set(text, [proposal]);
            await send(runtime, conversationId, `personal-organic-rejected-${text.length}`, text);
        }
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 6);
        const retrievalConversation = runtime.createConversation();
        await send(runtime, retrievalConversation, 'personal-organic-followup', '¿Cuál es mi proyecto activo Atlas?');
        assert.ok(requests.at(-1).input.some(item => item?.type === 'function_call_output'
            && typeof item.output === 'string' && item.output.includes('el proyecto Atlas')));
    }, { personalMode: true, verificationOutcomes: new Map([
        ['Por ejemplo, me interesa la astronomía.', [{ supported: false, explicit: false }]],
        ['Mi objetivo es pagar mi deuda médica.', [{ nonSensitive: false }]],
    ]) });
});

test('organic owner learning stores normalized facts, preserves negative meaning, and updates history', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests }) => {
        const conversationId = runtime.createConversation();
        const cases = [
            ['Soy desarrollador web.', 'biography.occupation', 'desarrollador web', 'desarrollador web'],
            ['Toco el saxofón alto.', 'hobby.instrument_saxophone', 'el saxofón alto', 'el saxofón alto'],
            ['Practico buceo.', 'practice.diving', 'buceo', 'buceo'],
            ['No me gusta el reguetón.', 'music.genre_reggaeton', 'No me gusta el reguetón', 'No me gusta el reguetón'],
            ['Decidí usar React para mi portfolio.', 'decision.portfolio_stack', 'usar React para mi portfolio',
                'usar React para mi portfolio'],
            ['Ensayo con mi banda todos los martes.', 'routine.band', 'Ensayo con mi banda todos los martes',
                'Ensayo con mi banda todos los martes'],
        ];
        for (const [message, attribute, value] of cases) {
            responses.set(message, [fact(message, attribute, value)]);
            await send(runtime, conversationId, `expanded-${attribute}`, message);
        }
        let snapshot = (await repository.readSnapshot()).snapshot;
        for (const [, attribute, , expected] of cases)
            assert.equal(snapshot.assertions.find(item => item.compatibility?.key === attribute)?.object.value, expected);
        const ended = 'Ya no practico buceo.';
        // The model may quote the cessation predicate together with the activity.
        // That value is valid evidence from the current sentence, but is not a
        // literal substring of the earlier positive assertion.
        responses.set(ended, [fact(ended, 'practice.diving', 'no practico buceo', { temporal: 'past',
            priorStatement: 'buceo' })]);
        await send(runtime, conversationId, 'expanded-ended', ended);
        snapshot = (await repository.readSnapshot()).snapshot;
        const diving = snapshot.assertions.filter(item => item.compatibility?.key === 'practice.diving');
        assert.equal(diving.length, 2);
        assert.equal(diving.find(item => item.status === 'active').object.value, ended);
        assert.equal(diving.find(item => item.status === 'superseded').object.value, 'buceo');
        const afterCessation = snapshot.revision;
        responses.set(ended, [fact(ended, 'practice.diving', 'no practico buceo', { temporal: 'past',
            priorStatement: 'buceo' })]);
        await send(runtime, conversationId, 'expanded-ended-repeat', ended);
        assert.equal((await repository.readSnapshot()).snapshot.revision, afterCessation,
            'repeating the cessation is idempotent');
        const wrongTopic = 'Ya no practico natación.';
        responses.set(wrongTopic, [fact(wrongTopic, 'practice.diving', 'natación', { temporal: 'past',
            priorStatement: 'buceo' })]);
        await send(runtime, conversationId, 'expanded-wrong-topic', wrongTopic);
        assert.equal((await repository.readSnapshot()).snapshot.assertions.length, snapshot.assertions.length);
        const hypothetical = 'Quizás deje de practicar buceo.';
        responses.set(hypothetical, [fact(hypothetical, 'practice.diving', 'practicar buceo',
            { certainty: 'uncertain', temporal: 'hypothetical', hypothetical: true })]);
        await send(runtime, conversationId, 'expanded-hypothetical-cessation', hypothetical);
        assert.equal((await repository.readSnapshot()).snapshot.revision, afterCessation,
            'a hypothetical cessation does not change the current fact');
        const followup = runtime.createConversation();
        for (const [index, question, expected] of [
            ['¿Qué instrumento toco?', 'el saxofón alto'],
            ['¿A qué me dedico?', 'desarrollador web'],
            ['¿Qué hago los martes?', 'Ensayo con mi banda todos los martes'],
            ['¿Sigo practicando buceo?', 'Ya no practico buceo.'],
        ].map((entry, index) => [index, ...entry])) {
            await send(runtime, followup, `expanded-recall-${index}`, question);
            const last = requests.at(-1);
            assert.ok(last.input.some(item => item?.type === 'function_call_output'
                && typeof item.output === 'string' && item.output.includes(expected)), question);
        }
        const contextProvider = createMemoryContextProvider({ repository, embeddings: fixtureEmbeddings });
        const history = await contextProvider.search({ query: '¿Practicaba esa disciplina antes?', temporal: 'history' });
        assert.ok(history.assertions.some(item => item.object?.value === 'buceo'),
            'the old assertion remains available as historical semantic evidence');
    }, { personalMode: true, verificationOutcomes: new Map([
        ['Ya no practico natación.', [{ supported: false }]],
        ['Quizás deje de practicar buceo.', [{ explicit: false }]],
    ]) });
});

test('weekday-first routine statement is learned and retrievable from a separate conversation', async () => {
    await temporaryStore(async ({ repository, runtime, responses, requests, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const statement = 'Los martes ensayo con mi banda.';
        responses.set(statement, [fact(statement, 'routine.band', 'Los martes ensayo con mi banda')]);
        await send(runtime, conversationId, 'weekday-routine', statement);

        const saved = (await repository.readSnapshot()).snapshot.assertions.find(item =>
            item.compatibility?.key === 'routine.band' && item.status === 'active');
        assert.equal(saved?.object.value, 'Los martes ensayo con mi banda',
            JSON.stringify(agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation')));

        const followup = runtime.createConversation();
        await send(runtime, followup, 'weekday-routine-recall', '¿Cuándo ensayo?');
        assert.ok(requests.at(-1).input.some(item => item?.type === 'function_call_output'
            && typeof item.output === 'string' && item.output.includes(saved.object.value)));
    }, { personalMode: true });
});

test('residence is deliberately excluded before organic evaluation by the location privacy gate', () => {
    assert.deepEqual(screenAutomaticMemoryTurn('Vivo en Barcelona'), {
        eligible: false, reason: 'excluded_location_or_movement',
    });
});

test('future plans preserve modality, uncertain proposals are rejected, and new past events remain historical', async () => {
    await temporaryStore(async ({ repository, runtime, responses }) => {
        const conversationId = runtime.createConversation();
        const goal = 'Quiero lanzar Nexa el año que viene.';
        responses.set(goal, [fact(goal, 'goal.launch_nexa', 'lanzar Nexa el año que viene',
            { temporal: 'future', futureIntent: true })]);
        await send(runtime, conversationId, 'expanded-goal', goal);
        const historicalEvent = 'Antes practicaba buceo.';
        responses.set(historicalEvent, [fact(historicalEvent, 'practice.diving', 'buceo', { temporal: 'past' })]);
        await send(runtime, conversationId, 'expanded-historical-event', historicalEvent);
        const rejected = [
            ['Quizás practique buceo.', fact('Quizás practique buceo.', 'practice.diving', 'buceo',
                { temporal: 'future', certainty: 'uncertain' })],
            ['Ya no practico buceo.', fact('Ya no practico buceo.', 'practice.diving', 'buceo',
                { temporal: 'past', subject: 'third_party', thirdParty: true, subjectName: 'Alex' })],
        ];
        for (const [index, [message, proposal]] of rejected.entries()) {
            responses.set(message, [proposal]);
            await send(runtime, conversationId, `expanded-reject-${index}`, message);
        }
        const assertions = (await repository.readSnapshot()).snapshot.assertions;
        assert.equal(assertions.length, 2);
        assert.ok(assertions.some(item => item.object.value === goal));
        assert.ok(assertions.some(item => item.object.value === historicalEvent));
    }, { personalMode: true, verificationOutcomes: new Map([
        ['Quizás practique buceo.', [{ explicit: false }]],
    ]) });
});

test('personal Desktop music preferences and compound work habits persist and are retrieved after Runtime restart', async () => {
    await temporaryStore(async ({ storePath, repository, runtime, responses }) => {
        const conversationId = runtime.createConversation();
        const music = 'Me encanta el jazz fusión y suelo escuchar funk mientras programo.';
        responses.set(music, [
            fact(music, 'music.genre_jazz_fusion', 'jazz fusión'),
            fact(music, 'music.genre_funk', 'funk'),
        ]);
        await send(runtime, conversationId, 'organic-music', music);

        const work = 'Normalmente programo por la mañana y dejo las tareas administrativas para la tarde.';
        responses.set(work, [
            fact('Normalmente programo por la mañana', 'work.programming_schedule', 'programo por la mañana'),
            fact('dejo las tareas administrativas para la tarde', 'work.admin_schedule', 'tareas administrativas para la tarde'),
        ]);
        await send(runtime, conversationId, 'organic-work-patterns', work);
        const snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.filter(item => item.status === 'active').length, 4);

        await runtime.close();
        await repository.close();
        const reopened = createJsonMemoryRepository({ storePath });
        await reopened.open();
        const retrievalRequests = [];
        const retrievalRuntime = createConversationRuntime({ memoryMode: 'memory2', agentFactory: ({ agentOptions }) =>
            createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: reopened,
                memoryContextProvider: createMemoryContextProvider({ repository: reopened, embeddings: fixtureEmbeddings }),
                memoryRetrievalEnabled: true, getTools: () => [], ask: async request => {
                    retrievalRequests.push(request);
                    return finalResponse('Ya tengo presente tu música y organización habitual.');
                } }) });
        try {
            const newConversation = retrievalRuntime.createConversation();
            await send(retrievalRuntime, newConversation, 'organic-general-restart-recall',
                '¿Qué música me gusta y cómo organizo mi jornada?');
            const payload = retrievalRequests.flatMap(request => request.input)
                .filter(item => item?.type === 'function_call_output' && typeof item.output === 'string')
                .map(item => { try { return JSON.parse(item.output); } catch { return null; } })
                .find(item => Array.isArray(item?.assertions));
            assert.ok(payload, 'the restarted Runtime provides a Memory2 context payload');
            for (const expected of [
                'jazz fusión', 'funk', 'programo por la mañana', 'tareas administrativas para la tarde',
            ]) assert.ok(payload.assertions.some(item => item.object?.value === expected), expected);
        } finally {
            await retrievalRuntime.close();
            await reopened.close();
        }
    }, { personalMode: true });
});

test('organic learning fails closed for third parties, uncertainty, hypotheses, future plans, sensitive context, ambiguity, and model-forged authority', async () => {
    await temporaryStore(async ({ repository, runtime, responses }) => {
        const conversationId = runtime.createConversation();
        const cases = [
            ['Mi compañero usa Zed para hacer pruebas.', fact('Mi compañero usa Zed para hacer pruebas.', 'editor.testing_favorite', 'Zed', { subject: 'third_party', thirdParty: true })],
            ['Quizás vuelva a Windsurf.', fact('Quizás vuelva a Windsurf.', 'editor.habitual', 'Windsurf', { certainty: 'uncertain', temporal: 'future' })],
            ['Supongamos que uso Cursor todos los días.', fact('Supongamos que uso Cursor todos los días.', 'editor.habitual', 'Cursor', { temporal: 'hypothetical', hypothetical: true })],
            ['Estoy pensando en aprender Rust.', fact('Estoy pensando en aprender Rust.', 'editor.habitual', 'Rust', { futureIntent: true, temporal: 'future' })],
            ['Últimamente uso Cursor mientras trato mi diagnóstico médico.', fact('Últimamente uso Cursor mientras trato mi diagnóstico médico.', 'editor.habitual', 'Cursor')],
            ['Cursor me parece interesante.', fact('Cursor me parece interesante.', 'editor.habitual', 'Cursor')],
            ['Ahora uso Cursor todos los días.', fact('Ahora uso Windsurf todos los días.', 'editor.habitual', 'Windsurf')],
            ['Ahora uso Cursor todos los días.', fact('Ahora uso Cursor todos los días.', 'editor.habitual', 'Windsurf')],
            ['Ahora uso Cursor todos los días.', fact('Ahora uso Cursor todos los días.', 'editor.habitual', 'Cursor', { evidenceCapability: 'forged' })],
        ];
        let index = 0;
        for (const [text, candidate] of cases) {
            const uniqueText = `${text} ${index++}`;
            // Keep quote evidence exact while adding a benign suffix to create a distinct request.
            const adjusted = { ...candidate, sourceQuote: text };
            responses.set(uniqueText, [adjusted]);
            await send(runtime, conversationId, `organic-rejected-${index}`, uniqueText);
        }
        const snapshot = (await repository.readSnapshot()).snapshot;
        assert.deepEqual(snapshot.assertions, []);
    });
});

test('organic-learning evaluation separates simulated extraction, validation, persistence, and retrieval for synthetic personal scenarios', async () => {
    await temporaryStore(async ({ storePath, repository, runtime, responses, diagnostics, requests, agentDiagnostics, authInstances }) => {
        const conversationId = runtime.createConversation();

        // The mock supplies these proposals. This verifies Runtime behavior, not whether
        // a live model would independently extract the same facts.
        const complexStatement = 'Alex es mi pareja. Estoy trabajando en Nexa para crear experiencias compartidas con Alex.';
        responses.set(complexStatement, [
            fact('Alex es mi pareja.', 'relationship.partner', 'Alex'),
            fact('Estoy trabajando en Nexa para crear experiencias compartidas con Alex.', 'project.nexa',
                'crear experiencias compartidas con Alex'),
        ]);
        await send(runtime, conversationId, 'eval-complex-relationship-motive', complexStatement);
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 1, 'relationship facts cannot bypass their dedicated consent scope');
        const project = snapshot.assertions[0];
        assert.equal(project.compatibility.key, 'project.nexa');
        assert.equal(project.object.value, 'crear experiencias compartidas con Alex');
        const evidence = snapshot.evidence.find(item => item.assertion_id === project.id);
        assert.equal(evidence.derivation, 'inferred');
        const source = snapshot.sources.find(item => item.id === evidence.source_id);
        assert.equal(source.kind, 'user_statement');
        assert.equal(source.locator, null, 'the literal quote is not retained as a persistent source locator');

        // The semantic verifier rejects a transient desire; local eligibility does not rely on a food vocabulary.
        const oneOff = 'Hoy tengo ganas de sushi.';
        responses.set(oneOff, [fact(oneOff, 'food.cuisine', 'sushi')]);
        await send(runtime, conversationId, 'eval-one-off-food', oneOff);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 1);

        // A clear current preference replaces the same stable slot; a later replacement
        // remains linked to its predecessor instead of creating two current values.
        const japanese = 'Me encanta cocinar comida japonesa.';
        responses.set(japanese, [fact(japanese, 'food.cuisine', 'comida japonesa')]);
        await send(runtime, conversationId, 'eval-stable-food', japanese);
        const italian = 'Ahora prefiero comida italiana.';
        responses.set(italian, [fact(italian, 'food.cuisine', 'comida italiana', {
            priorStatement: 'comida japonesa' })]);
        await send(runtime, conversationId, 'eval-food-change', italian);
        snapshot = (await repository.readSnapshot()).snapshot;
        const cuisine = snapshot.assertions.filter(item => item.compatibility?.key === 'food.cuisine');
        assert.equal(cuisine.length, 2);
        assert.equal(cuisine.find(item => item.status === 'active').object.value, 'comida italiana');
        assert.equal(cuisine.find(item => item.status === 'superseded').object.value, 'comida japonesa');
        assert.deepEqual(cuisine.find(item => item.status === 'active').supersedes,
            [cuisine.find(item => item.status === 'superseded').id]);

        // No relationship is available to associate a new request about Alex with the
        // owner-scoped project assertion. This is a retrieval limitation, not evidence
        // that Memory2 lost the persisted project text.
        await runtime.close();
        await repository.close();
        const reopened = createJsonMemoryRepository({ storePath });
        await reopened.open();
        const retrievalRequests = [];
        const retrievalRuntime = createConversationRuntime({ memoryMode: 'memory2', agentFactory: ({ agentOptions }) =>
            createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: reopened,
                memoryContextProvider: createMemoryContextProvider({ repository: reopened, embeddings: fixtureEmbeddings }),
                memoryRetrievalEnabled: true, getTools: () => [], ask: async request => {
                    retrievalRequests.push(request);
                    return finalResponse();
                } }) });
        try {
            const newConversation = retrievalRuntime.createConversation();
            await send(retrievalRuntime, newConversation, 'eval-contextual-alex-request',
                'Quiero preparar algo especial para Alex.');
            const contextualInput = retrievalRequests.at(-1).input;
            const contextualPayloads = contextualInput.filter(item => item?.type === 'function_call_output')
                .map(item => { try { return JSON.parse(item.output); } catch { return null; } })
                .filter(item => Array.isArray(item?.assertions));
            assert.equal(contextualPayloads.flatMap(item => item.assertions)
                .some(item => item.object?.value === 'crear experiencias compartidas con Alex'), true,
            'a first-person request now receives bounded owner context for model-level relevance selection');

            await send(retrievalRuntime, newConversation, 'eval-direct-project-recall',
                '¿Qué recuerdo yo sobre Nexa y Alex?');
            const directPayloads = retrievalRequests.at(-1).input.filter(item => item?.type === 'function_call_output')
                .map(item => { try { return JSON.parse(item.output); } catch { return null; } })
                .filter(item => Array.isArray(item?.assertions));
            assert.ok(directPayloads.flatMap(item => item.assertions)
                .some(item => item.object?.value === 'crear experiencias compartidas con Alex'));
        } finally {
            await retrievalRuntime.close();
            await reopened.close();
        }
    }, { personalMode: true, verificationOutcomes: new Map([
        ['Hoy tengo ganas de sushi.', [{ supported: false, explicit: false }]],
    ]) });
});

test('generic activity and historical facts persist while third-party and unsupported relation writes stay isolated', async () => {
        const learning = 'Estoy aprendiendo React.';
    await temporaryStore(async ({ repository, runtime, responses }) => {
        const conversationId = runtime.createConversation();
        responses.set(learning, [fact(learning, 'general.current_learning', 'Estoy aprendiendo React')]);
        await send(runtime, conversationId, 'eval-learning-react', learning);

        const previous = 'Antes estudiaba Python, pero lo dejé.';
        responses.set(previous, [fact(previous, 'interest.python', 'estudiar Python', { temporal: 'past' })]);
        await send(runtime, conversationId, 'eval-former-python', previous);

        const privateThirdParty = 'Alex prefiere el color verde.';
        responses.set(privateThirdParty, [fact(privateThirdParty, 'interest.favorite_color', 'verde',
            { subject: 'third_party', thirdParty: true })]);
        await send(runtime, conversationId, 'eval-third-party-preference', privateThirdParty);

        // Organic learning cannot cite prior turns, even if the model sees the transcript.
        const omittedSubject = 'Es mi pareja.';
        responses.set(omittedSubject, [fact('Alex es mi pareja.', 'relationship.partner', 'Alex')]);
        await send(runtime, conversationId, 'eval-omitted-subject', omittedSubject);

        const snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 2);
        assert.ok(snapshot.assertions.some(item => item.compatibility?.key === 'general.current_learning'
            && item.object.value === 'Estoy aprendiendo React'));
        assert.ok(snapshot.assertions.some(item => item.compatibility?.key === 'interest.python'
            && item.object.value === previous));
        assert.equal(snapshot.assertions.some(item => item.compatibility?.key === 'interest.favorite_color'), false,
            'third-party facts require their separate permission');
        assert.equal(snapshot.assertions.some(item => item.compatibility?.key === 'relationship.partner'), false,
            'relationship facts cannot use the generic everyday-facts scope');
    }, { personalMode: true });
});

test('missing, revoked, incompatible-scope, and candidate-only consent never persist', async () => {
    for (const consentMode of ['absent', 'revoked', 'wrong_scope', 'candidate_only']) {
        await temporaryStore(async ({ repository, runtime, responses }) => {
            const conversationId = runtime.createConversation();
            const sentence = 'Ahora uso Cursor todos los días.';
            responses.set(sentence, [fact(sentence, 'editor.habitual', 'Cursor')]);
            await send(runtime, conversationId, `organic-no-consent-${consentMode}`, sentence);
            assert.deepEqual((await repository.readSnapshot()).snapshot.assertions, []);
        }, { consentMode });
    }
});

test('persistence failure does not block a natural conversational response', async () => {
    await temporaryStore(async ({ runtime, responses, agentDiagnostics }) => {
        const conversationId = runtime.createConversation();
        const sentence = 'Ahora uso Cursor todos los días.';
        responses.set(sentence, [fact(sentence, 'editor.habitual', 'Cursor')]);
        assert.match(await send(runtime, conversationId, 'organic-write-failure', sentence), /Qué tal/u);
        const evaluation = agentDiagnostics.filter(item => item.event === 'organic_memory_evaluation').at(-1);
        assert.equal(evaluation.verifierApprovedCount, 1);
        assert.equal(evaluation.postValidationPassedCount, 1);
        assert.equal(evaluation.factWriteOutcomeCounts.failed, 1);
        assert.equal(evaluation.writeFailedCount, 1);
        assert.doesNotMatch(JSON.stringify(evaluation), /Cursor|todos los días/u);
    }, { failCommit: true, personalMode: true });
});

test('Memory1 remains the default and synthetic organic learning refuses non-synthetic compositions', async () => {
    const agent = await createAgent({ memoryBackend: 'memory1', load: async () => ({ user: {}, preferences: {}, facts: [] }),
        save: async () => {}, getTools: () => [], ask: async () => finalResponse() });
    try { assert.equal(agent.getSystemDiagnostics().memory.backend, 'memory1'); }
    finally { await agent.close(); }
    await assert.rejects(() => createAgent({ memoryBackend: 'memory1', operationalMemoryMode: mode,
        enableSyntheticOrganicLearning: true, load: async () => ({ user: {}, preferences: {}, facts: [] }), save: async () => {},
        organicMemoryAuthorizationFactory: () => ({}), organicEvidenceCapabilityFactory: () => ({}) }),
    /organic_memory_learning_requires_explicit_synthetic_memory2_runtime/u);
    const ownerAuthorizationFactory = () => ({});
    const evidenceFactory = () => ({});
    await assert.rejects(() => createAgent({ memoryBackend: 'memory1', operationalMemoryMode: 'memory2-confirmed-write',
        enableConfirmedMemoryWrites: true, enableOrganicMemoryLearning: true,
        organicMemoryAuthorizationFactory: ownerAuthorizationFactory, organicEvidenceCapabilityFactory: evidenceFactory }),
    /organic_memory_learning_requires_owner_authorized_writable_memory2/u);
    await assert.rejects(() => createAgent({ memoryBackend: 'memory2', operationalMemoryMode: 'memory2-confirmed-write',
        memory2ReadOnlyReader: { readContext: async () => ({ items: [] }), close: async () => {} },
        enableConfirmedMemoryWrites: true, enableOrganicMemoryLearning: true,
        organicMemoryAuthorizationFactory: ownerAuthorizationFactory, organicEvidenceCapabilityFactory: evidenceFactory }),
    /organic_memory_learning_requires_owner_authorized_writable_memory2/u);
});
