import { readDirectUserTurn, releaseDirectUserTurn, finalizeTrustedLocalTurnContext } from './direct-user-input.js';
import { createMemoryService } from '../memory/service.js';
import { authorizeMemoryRemember, authorizeMemoryForget, authorizePersonCreation, authorizeRelationCreation,
    authorizeRelationCorrection, authorizeRelationForget } from '../memory/authorization.js';
import { createMemory2ReadOnly } from '../memory/read-only.js';
import { MEMORY_CONTEXT_POLICY } from '../memory/context-provider.js';
import { openMemoryBackend } from '../memory/backend.js';
import { randomUUID } from 'node:crypto';
import { askOpenAI, isAutomaticMemoryLiveDetector } from '../brain/openai.js';
import { config } from '../config.js';
import { NEXA_INSTRUCTIONS } from '../prompts/nexa.js';
import { loadMemory, memoryToPrompt, saveMemory } from '../memory/memory.js';
import { getToolsForModel, executeTool } from '../tools/index.js';
import { formatSpotifyToolResult, isSpotifyTool, spotifyModelSafeOutput } from '../tools/spotify.js';
import { AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS, AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION,
    isCurrentAutomaticMemoryConsent, screenAutomaticMemoryTurn } from '../memory/automatic/privacy.js';
import { createDefaultAutomaticMemoryConsentStore } from '../memory/automatic/consent-store.js';
import { createDefaultAutomaticMemoryProposalQueue } from '../memory/automatic/proposal-queue.js';
import { createAutomaticMemoryAssessmentBoundary } from '../memory/automatic/assessment-boundary.js';
import { getAutomaticMemorySourcePolicy, getAutomaticMemoryToolSource } from '../memory/automatic/source-registry.js';

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    }
    return value;
}

function safeArgumentSummary(args) {
    return Object.fromEntries(Object.entries(args ?? {}).map(([key, value]) => {
        if (typeof value === 'string') return [key, { type: 'string', length: value.length }];
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key, value];
        if (Array.isArray(value)) return [key, { type: 'array', length: value.length }];
        if (typeof value === 'object') return [key, { type: 'object', keys: Object.keys(value).slice(0, 20) }];
        return [key, { type: typeof value }];
    }));
}

function requestedRepeatCount(message) {
    const text = String(message ?? '').toLocaleLowerCase('es');
    const numeric = text.match(/\b(\d{1,2})\s*(?:veces|times)\b/u);
    if (numeric) return Math.max(1, Math.min(10, Number(numeric[1])));
    const words = new Map([
        ['dos', 2], ['two', 2], ['tres', 3], ['three', 3], ['cuatro', 4], ['four', 4],
        ['cinco', 5], ['five', 5], ['seis', 6], ['six', 6], ['siete', 7], ['seven', 7],
        ['ocho', 8], ['eight', 8], ['nueve', 9], ['nine', 9], ['diez', 10], ['ten', 10],
    ]);
    const word = text.match(/\b(dos|two|tres|three|cuatro|four|cinco|five|seis|six|siete|seven|ocho|eight|nueve|nine|diez|ten)\s+(?:veces|times)\b/u);
    return word ? words.get(word[1]) : 1;
}

function writeAgentDiagnostic(event, details) {
    if (process.env.NEXA_AGENT_DEBUG !== 'true') return;
    console.debug(`[agent] ${JSON.stringify({ event, ...details })}`);
}

export async function createAgent({
    permissionPolicy,
    memoryBackend = config.memoryBackend,
    memory2StorePath = config.memory2StorePath,
    memory2Repository = null, // Explicit host composition only; the personal CLI never sets this.
    memory2ReadOnlyReader = null, // Experimental composition with an existing-store reader only.
    ask = askOpenAI,
    load = loadMemory,
    save = saveMemory,
    getTools = getToolsForModel,
    execute = executeTool,
    maxToolIterations = config.maxToolIterations,
    logger = writeAgentDiagnostic,
    enableAutomaticMemoryAssessment = false,
    automaticMemoryDetector = null,
    automaticMemoryAssessmentTimeoutMs = AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS,
    automaticMemoryConsentStore = createDefaultAutomaticMemoryConsentStore(),
    automaticMemoryProposalQueue = createDefaultAutomaticMemoryProposalQueue(),
    memoryRetrievalEnabled = memoryBackend === 'memory2',
} = {}) {
    if (typeof enableAutomaticMemoryAssessment !== 'boolean'
        || (automaticMemoryDetector !== null && typeof automaticMemoryDetector?.detect !== 'function')
        || (enableAutomaticMemoryAssessment && automaticMemoryDetector === null)
        || (enableAutomaticMemoryAssessment && isAutomaticMemoryLiveDetector(automaticMemoryDetector))
        || !Number.isSafeInteger(automaticMemoryAssessmentTimeoutMs) || automaticMemoryAssessmentTimeoutMs < 1
        || automaticMemoryAssessmentTimeoutMs > AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS
        || typeof automaticMemoryConsentStore?.load !== 'function' || typeof automaticMemoryConsentStore?.grant !== 'function'
        || typeof automaticMemoryConsentStore?.revoke !== 'function'
        || typeof automaticMemoryProposalQueue?.listGrouped !== 'function'
        || typeof automaticMemoryProposalQueue?.review !== 'function' || typeof automaticMemoryProposalQueue?.approve !== 'function'
        || typeof automaticMemoryProposalQueue?.reject !== 'function' || typeof automaticMemoryProposalQueue?.discard !== 'function'
        || typeof automaticMemoryProposalQueue?.excludeConversation !== 'function'
        || typeof automaticMemoryProposalQueue?.revokeConsent !== 'function'
        || typeof memoryRetrievalEnabled !== 'boolean') {
        throw new TypeError('automatic_memory_assessment_configuration_invalid');
    }
    let selectedBackend;
    const readOnlyMemory2 = memory2ReadOnlyReader !== null;
    if (readOnlyMemory2) {
        if (typeof memory2ReadOnlyReader?.readContext !== 'function'
            || typeof memory2ReadOnlyReader?.close !== 'function'
            || memory2Repository !== null || enableAutomaticMemoryAssessment) {
            throw new Error('Read-only Memory 2 requires an explicit reader and disabled automatic assessment.');
        }
        selectedBackend = { backend: 'memory2',
            memory: { user: {}, preferences: {}, facts: [] },
            contextProvider: { read: options => memory2ReadOnlyReader.readContext(options), invalidate() {} },
            close: () => memory2ReadOnlyReader.close() };
    } else if (memory2Repository) {
        if (memoryBackend !== 'memory2') throw new Error('Injected Memory 2 repository requires memoryBackend=memory2.');
        const memory2ReadOnly = createMemory2ReadOnly({ repository: memory2Repository });
        selectedBackend = { backend: 'memory2', repository: memory2Repository,
            memory: { user: {}, preferences: {}, facts: [] },
            service: createMemoryService({ repository: memory2Repository }),
            contextProvider: {
                read: options => memory2ReadOnly.readContext(options),
                // Successful writes clear the agent's digest and conversation below.
                // The read-only facade intentionally has no invalidation or mutation API.
                invalidate() {},
            },
            // The repository remains owned by the explicit composition caller.
            close: () => memory2ReadOnly.close() };
    } else {
        selectedBackend = await openMemoryBackend({ backend: memoryBackend, storePath: memory2StorePath, loadLegacy: load });
    }
    const memory = selectedBackend.memory;
    const memory2 = selectedBackend.service ?? null;
    const contextProvider = selectedBackend.contextProvider ?? null;
    let queue = Promise.resolve();
    let currentMessage = '', currentSource = 'untrusted', contextDigest = null;
    let recentUserTurns = [], currentRecentUserMessages = [];
    let pendingAutomaticMemoryAssessment = null;
    let automaticMemoryConsent = null, pendingConsentChallenge = null, pendingProposalConfirmation = null;
    let activeAutomaticAssessment = null, assessmentGeneration = 0;
    let conversationAutomaticMemoryExcluded = false;
    let lastRunAssessmentEligible = false;
    let activeDirectTurn = null;
    let automaticAssessmentContextTainted = false;
    let automaticAssessmentSessionUsed = false;
    const memoryToolNames = new Set(['remember', 'forget', 'recall', 'memory_context_snapshot', 'create_person',
        'create_relation', 'correct_relation', 'forget_relation', 'relations_for_entity']);
    function enqueue(operation) {
        const next = queue.then(operation);
        queue = next.catch(() => {});
        return next;
    }

    async function completePendingAutomaticMemoryAssessment() {
        const pending = pendingAutomaticMemoryAssessment;
        const directTurn = activeDirectTurn;
        pendingAutomaticMemoryAssessment = null; // consume before awaiting; repeated calls cannot assess twice.
        const finishTurn = () => {
            if (!directTurn) return;
            finalizeTrustedLocalTurnContext(directTurn.runtimeContextCapability, directTurn.recipient);
            if (activeDirectTurn === directTurn) activeDirectTurn = null;
        };
        try {
            await refreshPersistentAutomaticMemoryConsent();
            if (!enableAutomaticMemoryAssessment || !assessmentBoundary || !pending
                || !isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId)
                || automaticMemoryConsent.excludedConversations?.includes(sessionId))
                return { success: true, assessed: false };
            if (activeAutomaticAssessment) return { success: true, assessed: false, reason: 'assessment_already_in_flight' };

            const controller = new AbortController();
            const generation = assessmentGeneration;
            const job = { controller, generation };
            activeAutomaticAssessment = job;
            const result = await assessmentBoundary.assess({ capability: pending.runtimeContextCapability,
                recipient: pending.recipient, text: pending.text, signal: controller.signal,
                speakerIdentityCapability: pending.speakerIdentityCapability });
            if (activeAutomaticAssessment === job) activeAutomaticAssessment = null;
            if (controller.signal.aborted || generation !== assessmentGeneration)
                return { success: true, assessed: false, reason: 'assessment_invalidated' };
            if (result.success && result.assessed) {
                diagnostic('automatic_memory_assessment_completed', { success: true,
                    candidateCount: result.candidates.length });
                return result;
            }
            const code = result.error?.code ?? result.reason ?? 'automatic_memory_assessment_failed';
            diagnostic('automatic_memory_assessment_completed', { success: false, code });
            return result;
        } catch {
            diagnostic('automatic_memory_assessment_completed', { success: false,
                code: 'automatic_memory_assessment_failed' });
            return { success: false, assessed: false, error: { code: 'automatic_memory_assessment_failed' } };
        } finally {
            if (activeAutomaticAssessment?.controller.signal.aborted) activeAutomaticAssessment = null;
            finishTurn();
        }
    }
    const sessionId = randomUUID();
    const assessmentBoundary = automaticMemoryDetector ? createAutomaticMemoryAssessmentBoundary({
        detector: { detect: input => {
            automaticAssessmentSessionUsed = true;
            return automaticMemoryDetector.detect(input);
        } },
        consentStore: { load: async () => { await refreshPersistentAutomaticMemoryConsent(); return automaticMemoryConsent; } },
        analysisEnabled: async () => Boolean(enableAutomaticMemoryAssessment && automaticMemoryDetector
            && !automaticAssessmentContextTainted),
        isConversationExcluded: async () => Boolean(conversationAutomaticMemoryExcluded
            || automaticMemoryConsent?.excludedConversations?.includes(sessionId)),
        timeoutMs: automaticMemoryAssessmentTimeoutMs,
    }) : null;
    try { automaticMemoryConsent = await automaticMemoryConsentStore.load(); }
    catch { automaticMemoryConsent = null; }

    function diagnostic(event, details = {}) {
        try { logger(event, details); } catch { /* diagnostics never change agent behavior */ }
    }

    function recordTrustedExposure(kind, sourcePolicy) {
        const turn = activeDirectTurn;
        if (!turn) {
            automaticAssessmentContextTainted = true;
            assessmentBoundary?.cancelActive();
            return false;
        }
        lastRunAssessmentEligible = false;
        turn.exposed = true;
        automaticAssessmentContextTainted = true;
        if (!assessmentBoundary || turn.exposureRecorded) return Boolean(assessmentBoundary);
        turn.exposureRecorded = true;
        const event = assessmentBoundary.recordUntrustedContextExposure({
            capability: turn.runtimeExposureCapability, recipient: turn.recipient, text: turn.message,
            kind, sourceId: sourcePolicy?.source ?? 'tool:unclassified',
        });
        if (event.success !== true) turn.exposureRecordingFailed = true;
        diagnostic('automatic_memory_source_exposed', { source: event.source ?? 'tool:unclassified',
            memoryPolicy: event.memoryPolicy ?? 'never_store' });
        return event.success === true;
    }

    function invalidateAutomaticMemorySessionState() {
        automaticMemoryConsent = null;
        pendingConsentChallenge = null;
        pendingProposalConfirmation = null;
        pendingAutomaticMemoryAssessment = null;
        assessmentGeneration++;
        activeAutomaticAssessment?.controller.abort();
        assessmentBoundary?.cancelActive();
    }

    async function refreshPersistentAutomaticMemoryConsent() {
        let latest = null;
        try { latest = await automaticMemoryConsentStore.load(); }
        catch { diagnostic('automatic_memory_consent_read_failed', { code: 'automatic_memory_storage_unavailable' }); }
        if (latest?.consentId !== automaticMemoryConsent?.consentId) {
            pendingConsentChallenge = null;
            pendingProposalConfirmation = null;
            pendingAutomaticMemoryAssessment = null;
            assessmentGeneration++;
            activeAutomaticAssessment?.controller.abort();
            assessmentBoundary?.cancelActive();
        }
        automaticMemoryConsent = latest;
        return latest;
    }

    async function revokePersistentAutomaticMemoryConsent() {
        const previousConsent = automaticMemoryConsent;
        invalidateAutomaticMemorySessionState();
        let consentRevoked = false, queueInvalidated = !previousConsent?.consentId;
        try { await automaticMemoryConsentStore.revoke(); consentRevoked = true; }
        catch { diagnostic('automatic_memory_consent_revoke_failed', { code: 'automatic_memory_storage_unavailable' }); }
        try {
            if (previousConsent?.consentId) {
                await automaticMemoryProposalQueue.revokeConsent(previousConsent.consentId);
                queueInvalidated = true;
            }
        } catch {
            diagnostic('automatic_memory_consent_revoke_failed', { code: 'automatic_memory_storage_unavailable' });
        }
        return { consentRevoked, queueInvalidated };
    }

    async function excludeCurrentAutomaticMemoryConversation() {
        conversationAutomaticMemoryExcluded = true;
        pendingAutomaticMemoryAssessment = null;
        pendingProposalConfirmation = null;
        assessmentGeneration++;
        activeAutomaticAssessment?.controller.abort();
        let persisted = false, queueInvalidated = false;
        try { persisted = Boolean((await automaticMemoryConsentStore.excludeConversation(sessionId))?.success); }
        catch { diagnostic('automatic_memory_conversation_exclusion_failed', { code: 'automatic_memory_storage_unavailable' }); }
        try { await automaticMemoryProposalQueue.excludeConversation(sessionId); queueInvalidated = true; }
        catch { diagnostic('automatic_memory_conversation_exclusion_failed', { code: 'automatic_memory_storage_unavailable' }); }
        return { persisted, queueInvalidated };
    }

    function automaticMemoryControlState() {
        return Object.freeze({
            automaticAnalysisEnabled: Boolean(enableAutomaticMemoryAssessment && automaticMemoryDetector
                && !automaticAssessmentContextTainted && !automaticAssessmentSessionUsed
                && !conversationAutomaticMemoryExcluded && isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId)),
            automaticSavingEnabled: false,
            memoryRetrievalEnabled: selectedBackend.backend === 'memory2' ? memoryRetrievalEnabled : null,
            consentPolicyVersion: automaticMemoryConsent?.policyVersion ?? null,
            consentPersisted: Boolean(automaticMemoryConsent && automaticMemoryConsent.scope === 'future_direct_user_turns_across_runtime_sessions'),
            conversationAutomaticMemoryExcluded,
        });
    }

    function getInstructions() {
        if (memory2 || readOnlyMemory2) return NEXA_INSTRUCTIONS + MEMORY_CONTEXT_POLICY;
        return `
${NEXA_INSTRUCTIONS}

MEMORIA ACTUAL DEL USUARIO:
${memoryToPrompt(memory)}
`;
    }

    const conversation = [];

    async function getModelResponse(tools, iteration, finalOnly = false) {
        const memoryContext = contextProvider && memoryRetrievalEnabled ? await contextProvider.read({ message: currentMessage,
            recentUserMessages: currentRecentUserMessages }) : null;
        if (memoryContext) recordTrustedExposure('retrieved_memory', getAutomaticMemorySourcePolicy('memory'));
        if (memoryContext && contextDigest !== null && contextDigest !== memoryContext.digest) {
            // Discard all derived history, including possible assistant echoes of deleted facts.
            conversation.length = 0;
            conversation.push({ role: 'user', content: currentMessage });
            recentUserTurns = [];
            currentRecentUserMessages = [];
        }
        if (memoryContext) contextDigest = memoryContext.digest;
        const response = await ask({
            instructions: getInstructions(),
            input: memoryContext ? [...memoryContext.items, ...structuredClone(conversation)] : conversation,
            tools: readOnlyMemory2 ? [] : memory2 ? tools.filter(tool => !memoryToolNames.has(tool.name)) : tools,
        });
        if (response?.status !== 'completed') lastRunAssessmentEligible = false;
        conversation.push(...(response.output ?? []));
        const toolCalls = (response.output ?? []).filter(item => item.type === 'function_call');
        diagnostic('model_response', {
            iteration,
            finalOnly,
            type: toolCalls.length ? 'tool_calls' : 'final',
            toolCallCount: toolCalls.length,
        });
        return { response, toolCalls };
    }

    async function finalAnswer(spotifyMessages, iteration, reason) {
        diagnostic('final_turn', { iteration, reason, toolsDisabled: true });
        const { response, toolCalls } = await getModelResponse([], iteration, true);
        if (toolCalls.length > 0) {
            diagnostic('tool_loop_prevented', { iteration, reason: 'tools_returned_when_disabled', count: toolCalls.length });
            return [...spotifyMessages, 'El ciclo de herramientas terminó, pero no pude generar una respuesta final segura.'].filter(Boolean).join('\n\n');
        }
        return [response.output_text, ...spotifyMessages].filter(Boolean).join('\n\n')
            || [...spotifyMessages, 'El ciclo de herramientas terminó, pero no pude generar una respuesta final.'].filter(Boolean).join('\n\n');
    }

    async function run(userMessage, source = 'untrusted') {
        if (typeof userMessage !== 'string') throw new TypeError('user_message_must_be_text');
        if (!activeDirectTurn || source !== 'direct_user') automaticAssessmentContextTainted = true;
        lastRunAssessmentEligible = true;
        currentMessage = userMessage; currentSource = source;
        currentRecentUserMessages = recentUserTurns.slice(-4);
        recentUserTurns = [...recentUserTurns, userMessage.slice(0, 1000)].slice(-8);
        const spotifyMessages = [];
        const successfulCalls = new Map();
        const repeatLimit = requestedRepeatCount(userMessage);
        conversation.push({ role: 'user', content: userMessage });

        for (let iteration = 1; iteration <= maxToolIterations; iteration++) {
            const { response, toolCalls } = await getModelResponse(readOnlyMemory2 ? [] : getTools(permissionPolicy), iteration);
            if (toolCalls.length === 0) {
                return [response.output_text, ...spotifyMessages].filter(Boolean).join('\n\n');
            }

            let repeatedSuccessfulCall = false;
            for (const toolCall of toolCalls) {
                let args;
                try {
                    args = JSON.parse(toolCall.arguments);
                } catch {
                    args = {};
                    const result = { success: false, error: { code: 'invalid_tool_arguments', message: 'Los argumentos de la herramienta no eran JSON válido.' } };
                    diagnostic('tool_call', { iteration, tool: toolCall.name, arguments: {}, result: 'error', code: 'invalid_tool_arguments' });
                    conversation.push({ type: 'function_call_output', call_id: toolCall.call_id, output: JSON.stringify(result) });
                    continue;
                }

                const callKey = JSON.stringify([toolCall.name, stableValue(args)]);
                const successfulCount = successfulCalls.get(callKey) ?? 0;
                if (successfulCount >= repeatLimit) {
                    const result = {
                        success: false,
                        error: {
                            code: 'repeated_successful_tool_call',
                            message: 'Esta misma llamada ya se completó correctamente en esta conversación. No la repitas; responde al usuario con el resultado anterior.',
                        },
                    };
                    diagnostic('tool_loop_prevented', { iteration, tool: toolCall.name, reason: 'repeated_successful_tool_call' });
                    conversation.push({ type: 'function_call_output', call_id: toolCall.call_id, output: JSON.stringify(result) });
                    repeatedSuccessfulCall = true;
                    continue;
                }

                diagnostic('tool_call', { iteration, tool: toolCall.name, arguments: safeArgumentSummary(args) });
                let result;
                try {
                    if (readOnlyMemory2) {
                        result = { success: false, error: { code: 'tool_execution_disabled', message: 'Tool execution is disabled in this read-only session.' } };
                    } else if (memory2 && memoryToolNames.has(toolCall.name)) {
                        result = { success: false, error: { code: 'memory_write_not_authorized', message: 'Memory commands require direct terminal input.' } };
                    } else {
                        result = await execute(toolCall.name, args, { memory, saveMemory: memory2 ? undefined : save,
                            permissionPolicy, sessionId, userMessage,
                            userMessageSource: currentSource });
                    }
                } catch (error) {
                    result = { success: false, error: { code: 'tool_execution_failed', message: error.message } };
                }
                const succeeded = result?.success === true;
                if (succeeded && ['set_ui_value', 'invoke_ui_element'].includes(toolCall.name)) {
                    result = { ...result, completed: true };
                }
                diagnostic('tool_result', { iteration, tool: toolCall.name, success: succeeded, code: result?.error?.code ?? null });
                if (succeeded) successfulCalls.set(callKey, successfulCount + 1);

                const isSpotify = isSpotifyTool(toolCall.name);
                const output = isSpotify ? spotifyModelSafeOutput(toolCall.name, result) : result;
                recordTrustedExposure('tool_result', getAutomaticMemoryToolSource(toolCall.name));
                if (isSpotify) spotifyMessages.push(formatSpotifyToolResult(toolCall.name, result));
                conversation.push({
                    type: 'function_call_output',
                    call_id: toolCall.call_id,
                    output: JSON.stringify(output),
                });
            }

            if (repeatedSuccessfulCall) {
                return finalAnswer(spotifyMessages, iteration, 'repeated_successful_tool_call');
            }
        }

        // Tool rounds are capped; give the model one response-only turn to summarize their outcomes.
        return finalAnswer(spotifyMessages, maxToolIterations, 'max_tool_iterations');
    }

    // No method accepting a caller string can assert trusted Memory 2 provenance.
    async function readAndRun() {
        return enqueue(async () => {
            // A host that failed to complete the prior post-presentation phase loses that
            // assessment; never let it race with stdin or silently run it before a reply.
            if (activeDirectTurn) {
                finalizeTrustedLocalTurnContext(activeDirectTurn.runtimeContextCapability, activeDirectTurn.recipient);
                activeDirectTurn = null;
            }
            pendingAutomaticMemoryAssessment = null;
            const turn = await readDirectUserTurn(memory2 ?? agent);
            if (!turn) return { done: true };
            activeDirectTurn = { ...turn, recipient: memory2 ?? agent, message: turn.message,
                exposureRecorded: false, exposureRecordingFailed: false, exposed: false };
            try {
                await refreshPersistentAutomaticMemoryConsent();
                const { message, command, capability } = turn;
                const operation = command?.operation;
                if (readOnlyMemory2 && command) {
                    return { done: false, response: 'Los comandos de memoria están deshabilitados en esta sesión de solo lectura.' };
                }
                if (pendingConsentChallenge) {
                    const expected = pendingConsentChallenge;
                    pendingConsentChallenge = null;
                    if (operation === 'automatic_memory_consent_confirm' && command.consentChallenge === expected) {
                        try { automaticMemoryConsent = await automaticMemoryConsentStore.grant(); }
                        catch {
                            diagnostic('automatic_memory_consent_save_failed', { code: 'automatic_memory_storage_unavailable' });
                            return { done: false, response: 'No pude guardar el consentimiento local; el análisis sigue desactivado.' };
                        }
                        const inactiveNotice = enableAutomaticMemoryAssessment && automaticMemoryDetector
                            ? '' : ' El extractor no está conectado, así que no analizará ni enviará mensajes.';
                        return { done: false, response: `Consentimiento local persistente registrado bajo ${AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION}. Solo cubre turnos directos futuros; no analiza historial, no activa por sí mismo un extractor y no autoriza guardado.${inactiveNotice}` };
                    }
                }
                if (pendingProposalConfirmation) {
                    const expected = pendingProposalConfirmation;
                    pendingProposalConfirmation = null;
                    if (operation === 'automatic_memory_proposal_confirm'
                        && command.proposalId === expected.proposalId && command.proposalChallenge === expected.challenge
                        && Date.now() < expected.expiresAt) {
                        const result = await automaticMemoryProposalQueue.approve(expected.proposalId, expected.fingerprint);
                        if (result.success) return { done: false, response: 'Propuesta aprobada individualmente para revisión futura. No se escribió ningún recuerdo.' };
                        return { done: false, response: 'La propuesta ya no está vigente; no se escribió ningún recuerdo.' };
                    }
                }
                if (operation === 'automatic_memory_proposal_confirm')
                    return { done: false, response: 'La confirmación de propuesta no está vigente; no se escribió ningún recuerdo.' };
                if (operation === 'automatic_memory_consent_request') {
                    const challenge = randomUUID();
                    pendingConsentChallenge = challenge;
                    return { done: false, response: `Consentimiento opcional y persistente solo para evaluar nuevos turnos directos (${AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION}). No analiza historial, no activa por sí solo el extractor real y no permite guardar recuerdos. Si se conecta explícitamente un extractor en una fase posterior, el texto elegible podría enviarse a OpenAI. Podrían evaluarse temas de salud, finanzas personales, relaciones, asuntos legales/migratorios, trabajo/proyectos, contexto emocional y contexto general de terceros. Se excluyen secretos/credenciales, datos financieros de autenticación, documentos de identidad, ubicación y movimiento precisos, contenido temporal, citas/importaciones, datos de pacientes, secretos profesionales y entradas ambiguas detectadas por el filtro. Temas sensibles permitidos nunca se guardan sin confirmación individual; consentimiento de análisis no equivale a consentimiento de guardado. El archivo local contendrá únicamente versión, propósito, alcance y fecha de consentimiento. Para aceptar exactamente este alcance, escribe en tu siguiente entrada: /automatic-memory confirm-consent ${challenge}. Cualquier otra entrada cancela esta solicitud.` };
                }
                if (operation === 'automatic_memory_consent_revoke') {
                    const revoked = await revokePersistentAutomaticMemoryConsent();
                    return { done: false, response: revoked.consentRevoked && revoked.queueInvalidated
                        ? 'Consentimiento persistente de análisis revocado. Las propuestas pendientes asociadas se invalidaron; los recuerdos existentes y Memory1 no se modificaron.'
                        : revoked.consentRevoked
                            ? 'El consentimiento persistente quedó revocado y el análisis está desactivado; no pude limpiar la cola local. Las propuestas quedan ocultas mientras no haya consentimiento y requieren revisión local.'
                            : 'El análisis queda desactivado en esta sesión, pero no pude guardar la revocación local. Revísalo antes de cerrar Nexa.' };
                }
                if (operation === 'automatic_memory_consent_confirm')
                    return { done: false, response: 'La solicitud de consentimiento no está vigente; no se habilitó el análisis.' };
                if (operation === 'automatic_memory_exclude_conversation') {
                    const excluded = await excludeCurrentAutomaticMemoryConversation();
                    return { done: false, response: excluded.persisted && excluded.queueInvalidated
                        ? 'Esta conversación de CLI queda excluida de nuevos análisis. Sus propuestas pendientes se descartaron; no se borraron recuerdos anteriores.'
                        : excluded.persisted
                            ? 'La exclusión local quedó guardada y no se harán nuevos análisis; no pude limpiar la cola. Las propuestas de esta conversación quedan ocultas.'
                            : 'Esta conversación queda excluida en esta sesión, pero no pude confirmar la exclusión persistente. No se harán nuevos análisis en esta ejecución.' };
                }
                if (operation === 'automatic_memory_proposals_list') {
                    try {
                        const groups = await automaticMemoryProposalQueue.listGrouped({
                            consentId: automaticMemoryConsent?.consentId ?? null,
                            excludedConversationId: conversationAutomaticMemoryExcluded ? sessionId : null,
                            excludedConversationIds: automaticMemoryConsent?.excludedConversations ?? [],
                        });
                        if (!groups.length) return { done: false, response: 'No hay propuestas pendientes.' };
                        const lines = ['Propuestas pendientes (revisión agrupada; cada aprobación es individual):'];
                        for (const group of groups) {
                            lines.push(`\n${group.category} · ${group.action}${group.sensitive ? ' · sensible' : ''}`);
                            for (const item of group.proposals.slice(0, 20))
                                lines.push(`- ${item.proposalId}: ${item.summary}${item.targetSummary ? ` (reemplazar: ${item.targetSummary})` : ''}`);
                        }
                        return { done: false, response: lines.join('\n') };
                    } catch { return { done: false, response: 'La cola local no está disponible o requiere revisión; no se modificó ningún recuerdo.' }; }
                }
                if (operation === 'automatic_memory_proposal_review') {
                    try {
                        const item = await automaticMemoryProposalQueue.review(command.proposalId);
                        if (!item) return { done: false, response: 'La propuesta no existe, expiró o ya fue procesada.' };
                        if (!automaticMemoryConsent || item.consentId !== automaticMemoryConsent.consentId
                            || automaticMemoryConsent.excludedConversations?.includes(item.conversationId)
                            || item.conversationId === sessionId && conversationAutomaticMemoryExcluded)
                            return { done: false, response: 'La propuesta quedó invalidada por revocación o exclusión; no se escribió ningún recuerdo.' };
                        const challenge = randomUUID();
                        pendingProposalConfirmation = { proposalId: item.proposalId, fingerprint: item.fingerprint,
                            challenge, expiresAt: Date.now() + 60_000 };
                        const clean = value => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 180);
                        const sensitivity = item.sensitive ? 'Es sensible y exige esta confirmación individual.' : 'La aprobación también será individual.';
                        return { done: false, response: `Revisión: ${item.action} · ${item.category}. ${sensitivity}\nPropuesta: ${clean(item.summary)}${item.targetSummary ? `\nObjetivo de reemplazo: ${clean(item.targetSummary)}` : ''}\nAceptar solo esta propuesta y solo como elemento revisado: /automatic-memory confirm-proposal ${item.proposalId} ${challenge}. Cualquier otro turno cancela la confirmación. Aceptar no escribe ni autoriza una escritura de memoria.` };
                    } catch { return { done: false, response: 'La propuesta no pudo revisarse; no se escribió ningún recuerdo.' }; }
                }
                if (operation === 'automatic_memory_proposal_reject' || operation === 'automatic_memory_proposal_discard') {
                    try {
                        const item = await automaticMemoryProposalQueue.review(command.proposalId);
                        if (!item) return { done: false, response: 'La propuesta no existe, expiró o ya fue procesada.' };
                        const result = operation === 'automatic_memory_proposal_reject'
                            ? await automaticMemoryProposalQueue.reject(item.proposalId, item.fingerprint)
                            : await automaticMemoryProposalQueue.discard(item.proposalId);
                        return { done: false, response: result.success
                            ? operation === 'automatic_memory_proposal_reject' ? 'Propuesta rechazada y su resumen eliminado.' : 'Propuesta descartada.'
                            : 'La propuesta ya no está vigente.' };
                    } catch { return { done: false, response: 'La propuesta no pudo procesarse; no se escribió ningún recuerdo.' }; }
                }
                if (message.trim().toLowerCase() === 'salir') return { done: true };
                if (!message.trim()) return { done: false, response: '' };
                if (memory2 && command) {
                    const input = { capability, recipient: memory2 };
                    let result;
                    if (command.operation === 'create_person') result = await memory2.createPerson(command.request,
                        authorizePersonCreation({ ...input, request: command.request }));
                    else if (command.operation === 'remember') result = await memory2.remember({ proposal: command.request },
                        authorizeMemoryRemember({ ...input, proposal: command.request }));
                    else if (command.operation === 'create_relation') result = await memory2.createRelation(command.request,
                        authorizeRelationCreation({ ...input, request: command.request }));
                    else if (command.operation === 'correct_relation') result = await memory2.correctRelation(command.request,
                        authorizeRelationCorrection({ ...input, request: command.request }));
                    else if (command.operation === 'forget_relation') result = await memory2.forgetRelation(command.request,
                        authorizeRelationForget({ ...input, request: command.request }));
                    else result = await memory2.forget(command.request,
                        authorizeMemoryForget({ ...input, target: command.request }));
                    if (result.success && result.invalidateContext === true) {
                        contextProvider.invalidate();
                        conversation.length = 0;
                        contextDigest = null;
                        recentUserTurns = [];
                        currentRecentUserMessages = [];
                    }
                    // No memory payload or proof is passed to the model or to tools.
                    return { done: false, response: result.success ? 'Memoria actualizada.' : result.error.message, memoryResult: result };
                }
                const mayAssess = enableAutomaticMemoryAssessment && automaticMemoryDetector
                    && !automaticAssessmentContextTainted && !automaticAssessmentSessionUsed
                    && !conversationAutomaticMemoryExcluded
                    && isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId);
                const preflight = mayAssess ? screenAutomaticMemoryTurn(message) : null;
                if (preflight && !preflight.eligible)
                    diagnostic('automatic_memory_assessment_skipped', { code: preflight.reason });
                const response = await run(message, 'direct_user');
                if (enableAutomaticMemoryAssessment && !command && message.trim()
                    && mayAssess && preflight?.eligible && lastRunAssessmentEligible
                    && !activeDirectTurn.exposed && !activeDirectTurn.exposureRecordingFailed
                    && typeof response === 'string' && response.trim())
                    pendingAutomaticMemoryAssessment = { text: message,
                        runtimeContextCapability: turn.runtimeContextCapability,
                        speakerIdentityCapability: turn.speakerIdentityCapability, recipient: memory2 ?? agent };
                return { done: false, response };
            } finally { releaseDirectUserTurn(turn.capability); }
        });
    }
    const agent = { run: message => enqueue(() => run(message)), readAndRun,
        // The CLI calls this only after presenting readAndRun()'s response. It takes no
        // caller text or proof and is deliberately not exposed as a model tool.
        completePresentedTurn: () => enqueue(completePendingAutomaticMemoryAssessment),
        memory, memoryBackend: selectedBackend.backend,
        get automaticMemoryControls() { return automaticMemoryControlState(); },
        close: async () => {
            if (activeDirectTurn) {
                finalizeTrustedLocalTurnContext(activeDirectTurn.runtimeContextCapability, activeDirectTurn.recipient);
                activeDirectTurn = null;
            }
            invalidateAutomaticMemorySessionState();
            return selectedBackend.close();
        } };
    return agent;
}
