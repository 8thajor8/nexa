import { consumeTrustedLocalTurnContext, consumeTrustedLocalTurnExposure } from '../../core/direct-user-input.js';
import { isCurrentAutomaticMemoryConsent, screenAutomaticMemoryTurn,
    AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS } from './privacy.js';
import { validateAutomaticMemoryCandidates } from './schema.js';
import { evaluateAutomaticMemoryPolicy } from './policy.js';
import { getAutomaticMemorySourcePolicy } from './source-registry.js';

const EXPOSURE_KINDS = new Set(['assistant_output', 'tool_result', 'retrieved_memory', 'derived_external_data']);

function exactObject(value, keys, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
        throw new TypeError(code);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key)))
        throw new TypeError(code);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError(code);
    }
    return value;
}

function denied(code) {
    return Object.freeze({ success: false, assessed: false, error: Object.freeze({ code }) });
}

/**
 * Isolated C.5a boundary. It consumes the opaque stdin proof itself; strings,
 * source labels and plain objects cannot substitute for the proof. C.5b composes
 * it only behind the agent's explicit, disabled-by-default assessment gate.
 */
export function createAutomaticMemoryAssessmentBoundary(options = {}) {
    if (!options || (Reflect.ownKeys(options).length !== 4 && Reflect.ownKeys(options).length !== 5))
        throw new TypeError('automatic_memory_assessment_boundary_invalid');
    exactObject(options, Reflect.ownKeys(options).includes('timeoutMs')
        ? ['detector', 'consentStore', 'analysisEnabled', 'isConversationExcluded', 'timeoutMs']
        : ['detector', 'consentStore', 'analysisEnabled', 'isConversationExcluded'],
    'automatic_memory_assessment_boundary_invalid');
    const { detector, consentStore, analysisEnabled, isConversationExcluded,
        timeoutMs = AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS } = options;
    if (!detector || typeof detector.detect !== 'function'
        || Reflect.ownKeys(detector).some(key => key !== 'detect')
        || typeof consentStore?.load !== 'function'
        || typeof analysisEnabled !== 'function' || typeof isConversationExcluded !== 'function'
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AUTOMATIC_MEMORY_ASSESSMENT_TIMEOUT_MS)
        throw new TypeError('automatic_memory_assessment_boundary_invalid');

    const exposedSessions = new Set();
    const active = new Set();
    let generation = 0;
    let exposureOverflow = false;

    function consume(input) {
        if (!input || (Reflect.ownKeys(input).length !== 3 && Reflect.ownKeys(input).length !== 4))
            throw new TypeError('automatic_memory_assessment_input_invalid');
        exactObject(input, Reflect.ownKeys(input).includes('signal')
            ? ['capability', 'recipient', 'text', 'signal'] : ['capability', 'recipient', 'text'],
        'automatic_memory_assessment_input_invalid');
        const context = consumeTrustedLocalTurnContext(input.capability, input.recipient, input.text);
        if (input.signal !== undefined && !(input.signal instanceof AbortSignal))
            throw new TypeError('automatic_memory_assessment_input_invalid');
        return context;
    }

    function recordExposure(input) {
        try {
            exactObject(input, Reflect.ownKeys(input).includes('sourceId')
                ? ['capability', 'recipient', 'text', 'kind', 'sourceId']
                : ['capability', 'recipient', 'text', 'kind'], 'automatic_memory_provenance_input_invalid');
            if (!input.capability || typeof input.text !== 'string') return denied('trusted_turn_required');
            const context = consumeTrustedLocalTurnExposure(input.capability, input.recipient, input.text);
            // Any verified exposure closes assessment for the runtime session. The
            // source label is metadata only; it can never relax this decision.
            if (exposedSessions.size >= 10000) exposureOverflow = true;
            else exposedSessions.add(context.sessionId);
            const source = getAutomaticMemorySourcePolicy(input.sourceId);
            if (!EXPOSURE_KINDS.has(input.kind)) return denied('provenance_event_invalid');
            return Object.freeze({ success: true, blockedForSession: true, source: source.source,
                dataType: source.dataType, memoryPolicy: source.memoryPolicy, freshness: source.freshness });
        } catch {
            return denied('trusted_turn_required');
        }
    }

    async function assess(input) {
        let context;
        try { context = consume(input); }
        catch { return denied('trusted_turn_required'); }

        if (exposureOverflow || exposedSessions.has(context.sessionId)) return denied('untrusted_context_exposed');
        if (input.signal?.aborted) return denied('assessment_cancelled');
        let enabled = false;
        try { enabled = await analysisEnabled(); } catch { return denied('analysis_control_unavailable'); }
        if (enabled !== true) return denied('analysis_disabled');

        let consent;
        try { consent = await consentStore.load(); } catch { return denied('consent_unavailable'); }
        if (!isCurrentAutomaticMemoryConsent(consent, context.sessionId)) return denied('consent_missing_or_revoked');
        try {
            if (await isConversationExcluded(context.sessionId, consent) !== false)
                return denied('conversation_excluded_or_unverified');
        } catch { return denied('conversation_excluded_or_unverified'); }

        const screening = screenAutomaticMemoryTurn(input.text);
        if (!screening.eligible) return denied(screening.reason);

        const controller = new AbortController();
        const callGeneration = generation;
        const activeCall = { controller, callGeneration };
        active.add(activeCall);
        const abortFromCaller = () => controller.abort();
        input.signal?.addEventListener('abort', abortFromCaller, { once: true });
        // Once extraction begins the message may have left the process. Taint the
        // whole stdin session so a later paraphrase cannot be learned by default.
        if (exposedSessions.size >= 10000) exposureOverflow = true;
        else exposedSessions.add(context.sessionId);

        let timer;
        let timedOut = false;
        const lateSafe = Promise.resolve().then(() => detector.detect({ text: input.text, signal: controller.signal }))
            .then(value => ({ kind: 'result', value }), () => ({ kind: 'error' }));
        // Attach a rejection handler above before racing. Late results are ignored.
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                resolve({ kind: 'timeout' });
            }, timeoutMs);
        });
        const cancelled = new Promise(resolve => controller.signal.addEventListener('abort',
            () => { if (!timedOut) resolve({ kind: 'cancelled' }); }, { once: true }));
        let settled;
        try { settled = await Promise.race([lateSafe, timeout, cancelled]); }
        finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', abortFromCaller);
            active.delete(activeCall);
        }
        if (settled.kind === 'timeout') return denied('assessment_timeout');
        if (settled.kind === 'cancelled') return denied('assessment_cancelled');
        if (controller.signal.aborted || callGeneration !== generation) return denied('assessment_cancelled');
        if (settled.kind !== 'result' || !settled.value?.success) return denied('candidate_detection_unavailable');

        // Recheck revocation/exclusion after the await; a late model result is
        // discarded if privacy state changed while the request was in flight.
        let currentConsent;
        try { currentConsent = await consentStore.load(); } catch { return denied('consent_unavailable'); }
        if (!isCurrentAutomaticMemoryConsent(currentConsent, context.sessionId)
            || currentConsent.consentId !== consent.consentId) return denied('consent_missing_or_revoked');
        let stillEnabled = false;
        try { stillEnabled = await analysisEnabled(); } catch { return denied('analysis_control_unavailable'); }
        if (stillEnabled !== true) return denied('analysis_disabled');
        try {
            if (await isConversationExcluded(context.sessionId, currentConsent) !== false)
                return denied('conversation_excluded_or_unverified');
        } catch { return denied('conversation_excluded_or_unverified'); }
        if (controller.signal.aborted || callGeneration !== generation) return denied('assessment_cancelled');

        const validated = validateAutomaticMemoryCandidates(settled.value.proposal, input.text);
        if (!validated.success) return denied('candidate_output_invalid');
        const policy = evaluateAutomaticMemoryPolicy(validated.candidates);
        return Object.freeze({ success: true, assessed: true, candidates: policy.candidates,
            authorizationGranted: false, writeReady: false, persisted: false });
    }

    return Object.freeze({
        assess,
        recordUntrustedContextExposure: recordExposure,
        cancelActive() {
            generation++;
            for (const call of active) call.controller.abort();
            active.clear();
        },
    });
}
