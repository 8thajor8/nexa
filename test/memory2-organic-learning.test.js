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

const organicTool = 'propose_organic_memory_facts';
const mode = 'memory2-organic-synthetic-test';

function fact(sourceQuote, attribute, value, overrides = {}) {
    return { sourceQuote, attribute, value, confidence: 'high', certainty: 'explicit', subject: 'owner',
        temporal: 'current', sensitivity: 'none', ambiguous: false, thirdParty: false,
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

async function temporaryStore(callback, { failCommit = false, consentMode = 'granted', personalMode = false } = {}) {
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
        let toolAwaitingFinal = false;
        const ask = async request => {
            requests.push(request);
            const text = [...request.input].reverse().find(item => item?.role === 'user')?.content ?? '';
            if (!toolAwaitingFinal && request.tools?.some(item => item.name === organicTool) && responses.has(text)) {
                toolAwaitingFinal = true;
                return toolResponse(responses.get(text));
            }
            if (toolAwaitingFinal) toolAwaitingFinal = false;
            return finalResponse();
        };
        const authInstances = [];
        const activeMode = personalMode ? 'memory2-confirmed-write' : mode;
        function agentFactory({ agentOptions }) {
            return createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: hostRepository,
                memoryRetrievalEnabled: true, enableSyntheticOrganicLearning: !personalMode,
                enableConfirmedMemoryWrites: personalMode, enableOrganicMemoryLearning: personalMode,
                operationalMemoryMode: activeMode, getTools: () => [], execute: async () => { throw new Error('external_tool_forbidden'); },
                ask,
                organicMemoryAuthorizationFactory: ({ repository: target, persist }) => {
                    const storeCapabilities = new WeakMap(), consentCapabilities = new WeakMap(), evidenceCapabilities = new WeakMap();
                    const ownerId = 'synthetic-owner';
                    storeCapabilities.set(target, personalMode
                        ? { kind: 'memory2_personal', personalData: true, ownerId, mode: activeMode }
                        : { kind: 'synthetic_test', isolated: true, personalData: false });
                    const storeCapability = target;
                    const authorization = createOrganicMemoryAuthorization({ storeCapability,
                        verifyStoreCapability: capability => storeCapabilities.get(capability) ?? null,
                        persist,
                        verifyConsentCapability: capability => consentCapabilities.get(capability) ?? null,
                        verifyEvidenceCapability: capability => evidenceCapabilities.get(capability) ?? null });
                    const consentCapability = Object.freeze(Object.create(null));
                    const purpose = consentMode === 'candidate_only' ? 'automatic_memory_assessment' : 'organic_memory_learning';
                    const scopes = consentMode === 'wrong_scope' ? ['daily_preferences']
                        : personalMode ? ['tool_preferences', 'entertainment_preferences', 'food_activity_preferences',
                            'interaction_preferences', 'daily_routines', 'work_patterns', 'recurring_activities',
                            'active_projects', 'interests', 'goals'] : ['tool_preferences'];
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
                    authInstances.push({ authorization, evidenceCapabilities });
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
                        proposal: evidence.proposal });
                    return capability;
                },
            });
        }
        runtime = createConversationRuntime({ memoryMode: activeMode, agentFactory });
        await callback({ directory, storePath, repository, runtime, responses, requests, authInstances });
    } finally {
        try { await runtime?.close(); } catch { /* preserve the original test result */ }
        try { await repository?.close(); } catch { /* preserve the original test result */ }
        await rm(directory, { recursive: true, force: true });
    }
}

async function send(runtime, conversationId, id, text) {
    const result = await runtime.sendMessage({ conversationId, requestId: id, text, source: 'typed' });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    return result.text;
}

test('organic learning writes two independent editor attributes, updates history without duplicates, and retrieves them after Runtime restart', async () => {
    await temporaryStore(async ({ storePath, repository, runtime, responses, requests }) => {
        const conversationId = runtime.createConversation();
        const seed = 'Uso Windsurf todos los días para trabajar.';
        responses.set(seed, [fact(seed, 'editor.habitual', 'Windsurf')]);
        assert.match(await send(runtime, conversationId, 'organic-seed', seed), /Qué tal/u);

        const statement = 'Últimamente estoy usando Cursor para trabajar todos los días. Zed me sigue gustando para hacer pruebas.';
        responses.set(statement, [
            fact('Últimamente estoy usando Cursor para trabajar todos los días', 'editor.habitual', 'Cursor'),
            fact('Zed me sigue gustando para hacer pruebas', 'editor.testing_favorite', 'Zed'),
        ]);
        assert.match(await send(runtime, conversationId, 'organic-two-facts', statement), /Qué tal/u);
        let snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.length, 3);
        const habitual = snapshot.assertions.filter(item => item.compatibility?.key === 'editor.habitual');
        assert.equal(habitual.length, 2);
        assert.equal(habitual.find(item => item.status === 'active').object.value, 'Mi editor habitual es Cursor.');
        assert.equal(habitual.find(item => item.status === 'superseded').object.value, 'Mi editor habitual es Windsurf.');
        assert.deepEqual(habitual.find(item => item.status === 'active').supersedes, [habitual.find(item => item.status === 'superseded').id]);
        const testing = snapshot.assertions.find(item => item.compatibility?.key === 'editor.testing_favorite');
        assert.equal(testing.object.value, 'Mi editor favorito para hacer pruebas es Zed.');
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
            .object.value, 'Mi editor habitual es Cursor.');

        await runtime.close();
        await repository.close();
        const reopened = createJsonMemoryRepository({ storePath });
        await reopened.open();
        const retrievalRequests = [];
        const retrievalRuntime = createConversationRuntime({ memoryMode: 'memory2', agentFactory: ({ agentOptions }) =>
            createAgent({ ...agentOptions, memoryBackend: 'memory2', memory2Repository: reopened,
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
            assert.ok(memoryPayload.assertions.some(item => item.object?.value === 'Mi editor habitual es Cursor.'));
            assert.ok(memoryPayload.assertions.some(item => item.object?.value === 'Mi editor favorito para hacer pruebas es Zed.'));
        } finally {
            await retrievalRuntime.close();
            await reopened.close();
        }
        assert.ok(requests.length >= 6);
    });
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
            'Mi objetivo actual es aprender japonés.');

        const update = 'Mi objetivo actual es terminar el curso de japonés.';
        responses.set(update, [fact(update, 'goal.learn_japanese', 'terminar el curso de japonés', { futureIntent: true })]);
        await send(runtime, conversationId, 'personal-organic-goal-update', update);
        snapshot = (await repository.readSnapshot()).snapshot;
        assert.equal(snapshot.assertions.filter(item => item.compatibility.key === 'goal.learn_japanese').length, 2);
        assert.equal(snapshot.assertions.find(item => item.compatibility.key === 'goal.learn_japanese' && item.status === 'active').object.value,
            'Mi objetivo actual es terminar el curso de japonés.');

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
            && typeof item.output === 'string' && item.output.includes('Mi proyecto activo es el proyecto Atlas.')));
    }, { personalMode: true });
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
                'Mi preferencia musical es jazz fusión.', 'Mi preferencia musical es funk.',
                'Mi forma habitual de trabajar es programo por la mañana.',
                'Mi forma habitual de trabajar es tareas administrativas para la tarde.',
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
    await temporaryStore(async ({ runtime, responses }) => {
        const conversationId = runtime.createConversation();
        const sentence = 'Ahora uso Cursor todos los días.';
        responses.set(sentence, [fact(sentence, 'editor.habitual', 'Cursor')]);
        assert.match(await send(runtime, conversationId, 'organic-write-failure', sentence), /Qué tal/u);
    }, { failCommit: true });
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
