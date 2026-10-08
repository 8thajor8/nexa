import { readDirectUserTurn, releaseDirectUserTurn } from './direct-user-input.js';
import { createMemoryService } from '../memory/service.js';
import { authorizeMemoryRemember, authorizeMemoryForget, authorizePersonCreation, authorizeRelationCreation,
    authorizeRelationCorrection, authorizeRelationForget } from '../memory/authorization.js';
import { createMemoryContextProvider, MEMORY_CONTEXT_POLICY } from '../memory/context-provider.js';
import { openMemoryBackend } from '../memory/backend.js';
import { randomUUID } from 'node:crypto';
import { askOpenAI } from '../brain/openai.js';
import { config } from '../config.js';
import { NEXA_INSTRUCTIONS } from '../prompts/nexa.js';
import { loadMemory, memoryToPrompt, saveMemory } from '../memory/memory.js';
import { getToolsForModel, executeTool } from '../tools/index.js';
import { formatSpotifyToolResult, isSpotifyTool, spotifyModelSafeOutput } from '../tools/spotify.js';
import { AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS, AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION,
    createAutomaticMemorySessionConsent, isCurrentAutomaticMemoryConsent, screenAutomaticMemoryTurn } from '../memory/automatic/privacy.js';

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
    memoryRetrievalEnabled = memoryBackend === 'memory2',
} = {}) {
    if (typeof enableAutomaticMemoryAssessment !== 'boolean'
        || (automaticMemoryDetector !== null && typeof automaticMemoryDetector?.detect !== 'function')
        || (enableAutomaticMemoryAssessment && automaticMemoryDetector === null)
        || !Number.isSafeInteger(automaticMemoryAssessmentTimeoutMs) || automaticMemoryAssessmentTimeoutMs < 1
        || automaticMemoryAssessmentTimeoutMs > AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS
        || typeof memoryRetrievalEnabled !== 'boolean') {
        throw new TypeError('automatic_memory_assessment_configuration_invalid');
    }
    let selectedBackend;
    if (memory2Repository) {
        if (memoryBackend !== 'memory2') throw new Error('Injected Memory 2 repository requires memoryBackend=memory2.');
        selectedBackend = { backend: 'memory2', repository: memory2Repository,
            memory: { user: {}, preferences: {}, facts: [] },
            service: createMemoryService({ repository: memory2Repository }),
            contextProvider: createMemoryContextProvider({ repository: memory2Repository }), close: async () => {} };
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
    let automaticMemoryConsent = null, pendingConsentChallenge = null;
    let activeAutomaticAssessment = null, assessmentGeneration = 0;
    let lastRunAssessmentEligible = false;
    const memoryToolNames = new Set(['remember', 'forget', 'recall', 'memory_context_snapshot', 'create_person',
        'create_relation', 'correct_relation', 'forget_relation', 'relations_for_entity']);
    function enqueue(operation) {
        const next = queue.then(operation);
        queue = next.catch(() => {});
        return next;
    }

    async function completePendingAutomaticMemoryAssessment() {
        const pending = pendingAutomaticMemoryAssessment;
        pendingAutomaticMemoryAssessment = null; // consume before awaiting; repeated calls cannot assess twice.
        if (!enableAutomaticMemoryAssessment || !automaticMemoryDetector || !pending
            || !isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId))
            return { success: true, assessed: false };
        const screening = screenAutomaticMemoryTurn(pending.text);
        if (!screening.eligible) {
            diagnostic('automatic_memory_assessment_skipped', { code: screening.reason });
            return { success: true, assessed: false, reason: screening.reason };
        }
        if (activeAutomaticAssessment) return { success: true, assessed: false, reason: 'assessment_already_in_flight' };

        const controller = new AbortController();
        const generation = assessmentGeneration;
        const consent = automaticMemoryConsent;
        const job = { controller, generation };
        activeAutomaticAssessment = job;
        // Attach both settlement handlers immediately. Even a non-cooperative detector
        // cannot create an unhandled rejection after timeout/revocation.
        const settled = Promise.resolve().then(() => automaticMemoryDetector.detect({ text: pending.text,
            signal: controller.signal })).then(() => {
            if (controller.signal.aborted || generation !== assessmentGeneration
                || !isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId)
                || automaticMemoryConsent !== consent) return { success: true, assessed: false, reason: 'assessment_invalidated' };
            diagnostic('automatic_memory_assessment_completed', { success: true });
            return { success: true, assessed: true };
        }, () => {
            if (controller.signal.aborted || generation !== assessmentGeneration
                || !isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId)
                || automaticMemoryConsent !== consent) return { success: true, assessed: false, reason: 'assessment_invalidated' };
            diagnostic('automatic_memory_assessment_completed', { success: false,
                code: 'automatic_memory_assessment_failed' });
            return { success: false, assessed: true, error: { code: 'automatic_memory_assessment_failed' } };
        });
        settled.then(() => { if (activeAutomaticAssessment === job) activeAutomaticAssessment = null; });

        let timer;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => {
                assessmentGeneration++;
                controller.abort();
                diagnostic('automatic_memory_assessment_timed_out', { code: 'automatic_memory_assessment_timeout' });
                resolve({ success: false, assessed: true, error: { code: 'automatic_memory_assessment_timeout' } });
            }, automaticMemoryAssessmentTimeoutMs);
        });
        try { return await Promise.race([settled, timeout]); }
        finally { clearTimeout(timer); }
    }
    const sessionId = randomUUID();

    function diagnostic(event, details = {}) {
        try { logger(event, details); } catch { /* diagnostics never change agent behavior */ }
    }

    function revokeAutomaticMemoryConsent() {
        automaticMemoryConsent = null;
        pendingConsentChallenge = null;
        pendingAutomaticMemoryAssessment = null;
        assessmentGeneration++;
        activeAutomaticAssessment?.controller.abort();
    }

    function automaticMemoryControlState() {
        return Object.freeze({
            automaticAnalysisEnabled: Boolean(enableAutomaticMemoryAssessment && automaticMemoryDetector
                && isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId)),
            automaticSavingEnabled: false,
            memoryRetrievalEnabled: selectedBackend.backend === 'memory2' ? memoryRetrievalEnabled : null,
            consentPolicyVersion: automaticMemoryConsent?.policyVersion ?? null,
        });
    }

    function getInstructions() {
        if (memory2) return NEXA_INSTRUCTIONS + MEMORY_CONTEXT_POLICY;
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
            tools: memory2 ? tools.filter(tool => !memoryToolNames.has(tool.name)) : tools,
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
        lastRunAssessmentEligible = true;
        currentMessage = userMessage; currentSource = source;
        currentRecentUserMessages = recentUserTurns.slice(-4);
        recentUserTurns = [...recentUserTurns, userMessage.slice(0, 1000)].slice(-8);
        const spotifyMessages = [];
        const successfulCalls = new Map();
        const repeatLimit = requestedRepeatCount(userMessage);
        conversation.push({ role: 'user', content: userMessage });

        for (let iteration = 1; iteration <= maxToolIterations; iteration++) {
            const { response, toolCalls } = await getModelResponse(getTools(permissionPolicy), iteration);
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
                    if (memory2 && memoryToolNames.has(toolCall.name)) {
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
            pendingAutomaticMemoryAssessment = null;
            const turn = await readDirectUserTurn(memory2 ?? agent);
            if (!turn) return { done: true };
            try {
                const { message, command, capability } = turn;
                const operation = command?.operation;
                if (pendingConsentChallenge) {
                    const expected = pendingConsentChallenge;
                    pendingConsentChallenge = null;
                    if (operation === 'automatic_memory_consent_confirm' && command.consentChallenge === expected) {
                        automaticMemoryConsent = createAutomaticMemorySessionConsent({ sessionId, consentId: expected });
                        const inactiveNotice = enableAutomaticMemoryAssessment && automaticMemoryDetector
                            ? '' : ' Este proceso no tiene detector conectado, así que no analizará ni enviará mensajes.';
                        return { done: false, response: `Consentimiento de análisis registrado para esta sesión bajo ${AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION}. Solo cubre turnos directos futuros y no autoriza guardado.${inactiveNotice}` };
                    }
                }
                if (operation === 'automatic_memory_consent_request') {
                    revokeAutomaticMemoryConsent();
                    const challenge = randomUUID();
                    pendingConsentChallenge = challenge;
                    return { done: false, response: `Consentimiento opcional para evaluar turnos directos futuros de esta sesión (${AUTOMATIC_MEMORY_CONSENT_POLICY_VERSION}). Si en una composición futura se conecta explícitamente un extractor, el texto no excluido podría enviarse a OpenAI. Pueden evaluarse salud, finanzas personales, relaciones, asuntos legales/migratorios, trabajo, temas emocionales y contexto general de terceros; cualquier dato sensible requeriría confirmación antes de guardar. Se excluyen credenciales y secretos, credenciales financieras, documentos de identidad, ubicación y movimientos precisos, contenido temporal, citas/importaciones, datos de pacientes o secretos profesionales y entradas ambiguas detectadas por el filtro. No se guarda ningún recuerdo y el consentimiento expira al cerrar esta sesión. Para aceptar solo este alcance, escribe como tu siguiente entrada: /automatic-memory confirm-consent ${challenge}. Cualquier otra entrada cancela esta solicitud.` };
                }
                if (operation === 'automatic_memory_consent_revoke') {
                    revokeAutomaticMemoryConsent();
                    return { done: false, response: 'Consentimiento de análisis revocado para esta sesión. Memory1 y sus funciones continúan sin cambios.' };
                }
                if (operation === 'automatic_memory_consent_confirm')
                    return { done: false, response: 'La solicitud de consentimiento no está vigente; no se habilitó el análisis.' };
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
                    && isCurrentAutomaticMemoryConsent(automaticMemoryConsent, sessionId);
                const preflight = mayAssess ? screenAutomaticMemoryTurn(message) : null;
                if (preflight && !preflight.eligible)
                    diagnostic('automatic_memory_assessment_skipped', { code: preflight.reason });
                const response = await run(message, 'direct_user');
                if (enableAutomaticMemoryAssessment && !command && message.trim()
                    && mayAssess && preflight?.eligible && lastRunAssessmentEligible
                    && typeof response === 'string' && response.trim())
                    pendingAutomaticMemoryAssessment = { text: message };
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
        close: () => { revokeAutomaticMemoryConsent(); return selectedBackend.close(); } };
    return agent;
}
