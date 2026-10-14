import { randomUUID } from 'node:crypto';

const MAX_RECENT_OPERATIONS = 12;
const MAX_RECENT_VOICE_OPERATIONS = 8;
const SAFE_VOICE_STAGES = new Set(['ptt', 'transcription', 'runtime', 'synthesis', 'identity_processing', 'audio_preparation', 'playback']);
const SAFE_VOICE_STATES = new Set(['started', 'processing', 'success', 'error', 'cancelled', 'interrupted']);
const SAFE_VOICE_ERRORS = new Set(['VOICE_PTT_INVALID_AUDIO', 'VOICE_PTT_UNSUPPORTED_FORMAT', 'VOICE_PTT_TOO_LARGE',
    'VOICE_PTT_TOO_LONG', 'VOICE_PTT_INVALID_STATE', 'VOICE_PTT_TRANSCRIPTION_FAILED', 'voice_audio_storage_unavailable',
    'voice_tts_generation_failed', 'voice_tts_response_invalid', 'voice_audio_processing_failed', 'voice_audio_storage_failed',
    'voice_identity_browser_unavailable', 'voice_speech_generation_failed', 'voice_speech_playback_failed', 'voice_speech_playback_timeout',
    'voice_speech_start_timeout', 'voice_speech_stop_failed', 'voice_speech_stop_timeout', 'voice_speech_busy',
    'voice_speech_degraded', 'voice_speech_too_long',
]);
const SAFE_MEMORY_ERRORS = new Set([
    'memory_store_missing', 'memory_store_invalid', 'memory_schema_unsupported', 'memory_store_changed',
    'memory_reader_closed', 'memory_read_failed', 'memory_facade_closed', 'memory_store_unreadable',
    'memory_request_not_recognized', 'memory_proposal_failed', 'memory_persist_failed',
    'memory_intent_ambiguous', 'memory_intent_interpretation_failed', 'memory_intent_validation_failed', 'memory_intent_no_action',
    'memory_history_read_failed',
]);

export function classifySystemDiagnosticRequest(message) {
    if (typeof message !== 'string') return null;
    const text = message.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').trim();
    const technical = /\b(informe tecnico|diagnostico tecnico|detalles tecnicos|reporte para soporte|informe para soporte)\b/u.test(text);
    const voice = /\b(voz|voice|ptt|audio hablado)\b/u.test(text);
    const memory = /\b(memoria|memory ?2|recuerdo|recordaste|recuperacion de memoria)\b/u.test(text);
    const explicitNexaStatus = /\b(?:nexa(?:\s*,)?\s+(?:dame\s+)?diagnostico|dame\s+tu\s+diagnostico|como\s+estan\s+tus\s+sistemas|dame\s+tu\s+estado\s+operativo|tu\s+estado\s+operativo)\b/u.test(text);
    const toolCatalog = /\b(herramientas.*disponibles|que herramientas|herramientas tenes|que podes hacer con spotify|capacidades.*(spotify|windows|correo|calendario))\b/u.test(text);
    const status = toolCatalog || /\b(sistema de memoria|memory ?2 activo|modo.*memoria|capacidades activas|estado del sistema)\b/u.test(text);
    if (technical && memory) return 'technical_memory';
    if ((technical && voice) || (voice && /\b(diagnostico|informe|estado)\b/u.test(text))) return 'technical_voice';
    if (technical) return 'technical_status';
    if (toolCatalog) return /\bspotify\b/u.test(text) ? 'tool_catalog_spotify' : 'tool_catalog';
    if (memory && (/\bdiagnostic|funcionando|por que|recordaste|recuperacion\b/u.test(text))) return 'memory';
    if (explicitNexaStatus) return 'status';
    if (status) return 'status';
    return null;
}

export function createOperationalDiagnostics({ runtimeId = randomUUID(), memoryMode = 'unknown' } = {}) {
    let runtime = Object.freeze({ id: runtimeId, state: 'active' });
    const configuredBackend = memoryMode === 'memory1' ? 'memory1'
        : String(memoryMode).startsWith('memory2') ? 'memory2' : 'unknown';
    let memory = Object.freeze({ mode: memoryMode, backend: configuredBackend,
        storeType: configuredBackend === 'memory1' ? 'Memory 1 legacy store'
            : configuredBackend === 'memory2' ? 'Memory 2 Schema v5 (configured)' : 'unknown',
        storeIdentity: 'unknown', initialized: false, available: null, retrievalEnabled: null,
        confirmedWriteAvailability: 'unknown', semanticInterpreterAvailable: null, schemaValidation: 'unknown', lastError: null });
    const operations = [];
    const voiceOperations = [];
    let lastMemoryChange = null;
    let voiceConfiguration = Object.freeze({ model: 'unknown', voice: 'unknown', identityProfile: 'unknown', identityProcessing: null });

    function recordVoiceOperation(event = {}) {
        const safeText = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/u.test(value) ? value : null;
        const duration = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
        if (event.model === 'gpt-4o-mini-tts' && event.voice === 'nova' && event.identityProfile === 'nova-portena') {
            voiceConfiguration = Object.freeze({ model: event.model, voice: event.voice, identityProfile: event.identityProfile,
                identityProcessing: typeof event.identityProcessing === 'boolean' ? event.identityProcessing : null });
        }
        const entry = Object.freeze({ requestId: safeText(event.requestId), stage: SAFE_VOICE_STAGES.has(event.stage) ? event.stage : 'audio_preparation',
            state: SAFE_VOICE_STATES.has(event.state) ? event.state : 'processing', errorCode: SAFE_VOICE_ERRORS.has(event.errorCode) ? event.errorCode : null,
            durationMs: duration(event.durationMs),
            model: voiceConfiguration.model, voice: voiceConfiguration.voice,
            identityProfile: voiceConfiguration.identityProfile, identityProcessing: voiceConfiguration.identityProcessing,
            durations: Object.freeze({ transcriptionMs: duration(event.durations?.transcriptionMs), runtimeMs: duration(event.durations?.runtimeMs),
                synthesisMs: duration(event.durations?.synthesisMs), identityProcessingMs: duration(event.durations?.identityProcessingMs),
                identityServerStartupMs: duration(event.durations?.identityServerStartupMs),
                identityBrowserStartupMs: duration(event.durations?.identityBrowserStartupMs),
                identityRendererPreparationMs: duration(event.durations?.identityRendererPreparationMs),
                identityDspSetupMs: duration(event.durations?.identityDspSetupMs),
                identityDspProcessingMs: duration(event.durations?.identityDspProcessingMs),
                identityAudioCaptureWaitMs: duration(event.durations?.identityAudioCaptureWaitMs),
                identityPostProcessingMs: duration(event.durations?.identityPostProcessingMs),
                audioReadyMs: duration(event.durations?.audioReadyMs),
                pttFinalizationMs: duration(event.durations?.pttFinalizationMs), audioConversionMs: duration(event.durations?.audioConversionMs),
                speechInitializationMs: duration(event.durations?.speechInitializationMs),
                playbackCommandStartMs: duration(event.durations?.playbackCommandStartMs),
                responseDispatchToPlaybackMs: duration(event.durations?.responseDispatchToPlaybackMs),
                audioPreparationMs: duration(event.durations?.audioPreparationMs), playbackMs: duration(event.durations?.playbackMs) }),
            cancellation: ['user', 'superseded', 'session_ended', 'timeout'].includes(event.cancellation) ? event.cancellation : null,
            at: new Date().toISOString() });
        voiceOperations.push(entry);
        if (voiceOperations.length > MAX_RECENT_VOICE_OPERATIONS) voiceOperations.shift();
        return entry;
    }

    function setMemoryStatus(status = {}) {
        const safeStatus = { ...status };
        if (Object.hasOwn(safeStatus, 'storeIdentity')) {
            const allowed = new Set(['unknown', 'not_applicable', 'synthetic_memory_write_01', 'synthetic_memory_desktop_01']);
            safeStatus.storeIdentity = allowed.has(safeStatus.storeIdentity) ? safeStatus.storeIdentity : 'unknown';
        }
        if (Object.hasOwn(safeStatus, 'semanticInterpreterAvailable')
            && typeof safeStatus.semanticInterpreterAvailable !== 'boolean') safeStatus.semanticInterpreterAvailable = null;
        memory = Object.freeze({ ...memory, ...safeStatus });
    }

    function recordMemoryRetrieval(operation = {}) {
        const errorCode = SAFE_MEMORY_ERRORS.has(operation.errorCode) ? operation.errorCode
            : operation.readStatus === 'error' ? 'memory_read_failed' : null;
        const entry = Object.freeze({
            operationId: typeof operation.operationId === 'string' ? operation.operationId : randomUUID(),
            requestId: typeof operation.requestId === 'string' ? operation.requestId : null,
            iteration: Number.isSafeInteger(operation.iteration) ? operation.iteration : null,
            mode: typeof operation.mode === 'string' ? operation.mode : memory.mode,
            backend: typeof operation.backend === 'string' ? operation.backend : memory.backend,
            attempted: operation.attempted !== false,
            readStatus: ['success', 'error', 'not_applicable'].includes(operation.readStatus)
                ? operation.readStatus : 'unknown',
            matchCount: Number.isSafeInteger(operation.matchCount) && operation.matchCount >= 0 ? operation.matchCount : null,
            assertionCount: Number.isSafeInteger(operation.assertionCount) && operation.assertionCount >= 0 ? operation.assertionCount : null,
            relationCount: Number.isSafeInteger(operation.relationCount) && operation.relationCount >= 0 ? operation.relationCount : null,
            contextDelivered: typeof operation.contextDelivered === 'boolean' ? operation.contextDelivered : null,
            modelUse: 'unknown',
            errorCode,
            at: new Date().toISOString(),
        });
        operations.push(entry);
        if (operations.length > MAX_RECENT_OPERATIONS) operations.shift();
        if (errorCode) setMemoryStatus({ lastError: errorCode });
        else if (operation.readStatus === 'success') setMemoryStatus({ lastError: null });
        return entry;
    }

    function recordInitializationFailure(error) {
        const code = SAFE_MEMORY_ERRORS.has(error?.code) ? error.code : 'runtime_agent_initialization_failed';
        setMemoryStatus({ initialized: false, available: false, lastError: code });
    }

    function recordMemoryChange(event = {}) {
        const allowedOperations = new Set(['remember', 'update', 'forget', 'history', 'unknown']);
        const allowedCandidates = new Set(['found', 'not_found', 'ambiguous', 'evaluated', 'unknown', 'not_applicable']);
        const allowedConfirmations = new Set(['pending', 'confirmed', 'cancelled', 'expired', 'failed', 'not_required']);
        const allowedMechanisms = new Set(['deterministic', 'semantic', 'semantic_scope_terms', 'session_context', 'explicit_question', 'unknown']);
        const allowedSemanticResults = new Set(['not_invoked', 'structured_intent', 'clarification', 'no_intent', 'failed', 'unknown']);
        const allowedValidation = new Set(['not_run', 'accepted', 'rejected', 'unknown']);
        const allowedValidationCategories = new Set(['invalid_structure', 'required_field_missing', 'source_quote_not_validated',
            'new_value_missing', 'new_value_malformed', 'new_value_not_validated', 'old_value_malformed', 'old_value_not_validated',
            'update_topic_missing', 'update_topic_malformed', 'previous_value_missing',
            'ambiguous_intent', 'correction_value_missing', 'permanent_delete_not_supported', 'operation_incompatible',
            'source_quote_contains_instruction',
            'ambiguous_memory_target', 'interpreter_error']);
        const safeError = SAFE_MEMORY_ERRORS.has(event.errorCode) ? event.errorCode : null;
        lastMemoryChange = Object.freeze({
            operationId: randomUUID(),
            requestId: typeof event.requestId === 'string' ? event.requestId : null,
            operation: allowedOperations.has(event.operation) ? event.operation : 'unknown',
            candidateState: allowedCandidates.has(event.candidateState) ? event.candidateState : 'unknown',
            candidateCount: Number.isSafeInteger(event.candidateCount) && event.candidateCount >= 0 ? event.candidateCount : null,
            selectedRecordId: typeof event.selectedRecordId === 'string' && /^mem_[0-9a-f-]{36}$/u.test(event.selectedRecordId)
                ? event.selectedRecordId : null,
            matchStrategy: ['topic_and_old_value', 'unique_topic'].includes(event.matchStrategy) ? event.matchStrategy : null,
            intentDetected: typeof event.intentDetected === 'boolean' ? event.intentDetected : null,
            proposalGenerated: typeof event.proposalGenerated === 'boolean' ? event.proposalGenerated : null,
            confirmationRequested: typeof event.confirmationRequested === 'boolean' ? event.confirmationRequested : null,
            interpretationMechanism: allowedMechanisms.has(event.interpretationMechanism) ? event.interpretationMechanism : 'unknown',
            semanticInterpreterAvailable: typeof event.semanticInterpreterAvailable === 'boolean' ? event.semanticInterpreterAvailable : null,
            semanticInterpreterInvoked: typeof event.semanticInterpreterInvoked === 'boolean' ? event.semanticInterpreterInvoked : null,
            semanticInterpretation: allowedSemanticResults.has(event.semanticInterpretation) ? event.semanticInterpretation : 'unknown',
            runtimeValidation: allowedValidation.has(event.runtimeValidation) ? event.runtimeValidation : 'unknown',
            validationCategory: allowedValidationCategories.has(event.validationCategory) ? event.validationCategory : null,
            intentAccepted: typeof event.intentAccepted === 'boolean' ? event.intentAccepted : null,
            clarificationRequested: typeof event.clarificationRequested === 'boolean' ? event.clarificationRequested : null,
            confirmation: allowedConfirmations.has(event.confirmation) ? event.confirmation : 'unknown',
            persisted: ['yes', 'no', 'not_applicable', 'unknown'].includes(event.persisted) ? event.persisted : 'unknown',
            result: ['updated', 'saved', 'forgotten', 'read', 'not_changed', 'failed', 'unknown'].includes(event.result) ? event.result : 'unknown',
            historyFactsDelivered: typeof event.historyFactsDelivered === 'boolean' ? event.historyFactsDelivered : null,
            historyResponse: ['generated', 'fallback', 'error', 'not_applicable'].includes(event.historyResponse)
                ? event.historyResponse : 'not_applicable',
            requestedDimension: ['current', 'previous', 'history', 'date', 'reason', 'status', 'unknown'].includes(event.requestedDimension)
                ? event.requestedDimension : 'unknown',
            errorCode: safeError,
            at: new Date().toISOString(),
        });
        return lastMemoryChange;
    }

    function snapshot() {
        return Object.freeze({ runtime, memory, operations: Object.freeze([...operations]),
            lastMemoryRetrieval: operations.filter(item => item.attempted).at(-1) ?? null, lastMemoryChange,
            voice: Object.freeze({ configuration: voiceConfiguration, recent: Object.freeze([...voiceOperations]),
                last: voiceOperations.at(-1) ?? null }) });
    }

    return Object.freeze({ runtimeId, setMemoryStatus, recordMemoryRetrieval, recordMemoryChange, recordVoiceOperation,
        recordInitializationFailure, snapshot });
}

export function formatSystemStatus(snapshot, { technical = false } = {}) {
    const { runtime, memory, tools, voice } = snapshot;
    const available = Array.isArray(tools?.available) ? tools.available : null;
    const mode = memory.mode === 'memory2-confirmed-write' ? 'Memory2 en modo de escritura confirmada'
        : memory.mode === 'memory2-readonly' ? 'Memory2 en modo de solo lectura'
            : memory.backend === 'memory1' ? 'Memory1' : 'un modo de memoria no identificado';
    const state = memory.initialized === true
        ? (memory.available === true ? 'inicializado y disponible' : 'inicializado; disponibilidad no comprobada')
        : memory.available === false ? 'no pudo inicializarse' : 'todavía no inicializado';
    const lastRetrieval = snapshot.lastMemoryRetrieval;
    const operationallyVerified = memory.backend !== 'memory2' ? 'unknown'
        : lastRetrieval?.readStatus === 'success' ? 'yes'
            : lastRetrieval?.readStatus === 'error' ? 'no' : 'unknown';
    if (!technical) {
        const statusLabel = value => value === true ? 'Disponible' : value === false ? 'No disponible' : 'Sin comprobar';
        const humanBackend = memory.backend === 'memory2' ? 'Memory2'
            : memory.backend === 'memory1' ? 'Memory1 heredada' : 'Sin identificar';
        const humanMode = memory.mode === 'memory2-confirmed-write' ? 'escritura confirmada'
            : memory.mode === 'memory2-readonly' ? 'solo lectura'
                : memory.mode === 'memory1' ? 'modo heredado' : 'sin identificar';
        const storeMatch = typeof memory.storeType === 'string' && memory.storeType.match(/schema\s*v(\d+)/iu);
        const storeLabel = memory.backend === 'memory2' && storeMatch ? `Memory2, esquema versión ${storeMatch[1]}`
            : memory.storeType && memory.storeType !== 'unknown' ? memory.storeType : 'No identificado';
        const initialization = memory.initialized === true ? 'Inicializado'
            : memory.initialized === false ? 'Pendiente de inicialización' : 'Sin comprobar';
        const retrieval = memory.retrievalEnabled === true ? 'Habilitada' : memory.retrievalEnabled === false ? 'Deshabilitada' : 'Sin comprobar';
        const validation = memory.schemaValidation === 'validated' ? 'Validado'
            : memory.schemaValidation === 'invalid' ? 'No válido' : 'Sin comprobar';
        const verification = operationallyVerified === 'yes' ? 'Lectura comprobada correctamente'
            : operationallyVerified === 'no' ? 'La última lectura comprobada falló'
                : 'Todavía no hay una lectura operativa reciente';
        const runtimeState = runtime?.state === 'active' ? 'Activo'
            : runtime?.state === 'error' ? 'Con errores' : 'Sin comprobar';
        const registered = [...new Set(Array.isArray(tools?.registered) ? tools.registered : [])];
        const enabled = Array.isArray(tools?.available) ? new Set(tools.available) : null;
        const aliases = {
            'Computadora y aplicaciones': 'Control de Windows y aplicaciones',
            'Ventanas y controles': 'Gestión de ventanas e interfaz',
            'Archivos y carpetas': 'Archivos y navegación',
            'Voz y audio': 'Audio y multimedia',
            'Música y Spotify': 'Spotify',
            'Correo electrónico': 'Correo electrónico',
            'Calendario': 'Calendario',
            'Lifeguard': 'Integración Lifeguard',
            'WhatsApp': 'WhatsApp',
            'Búsqueda e información': 'Internet, clima, fecha y hora',
            'Diagnóstico y sistema': 'Internet, clima, fecha y hora',
            'Memoria': 'Memoria y conocimiento',
            'Otras herramientas': 'Otras capacidades',
        };
        const categories = new Map();
        for (const id of registered) {
            const presentation = toolPresentation(id);
            const presentationCategory = id === 'open_url' ? 'Búsqueda e información'
                : /^(inspect_ui|find_ui_element|focus_ui_element|invoke_ui_element|set_ui_value|get_ui_value)$/u.test(id)
                    ? 'Ventanas y controles' : presentation.category;
            const category = aliases[presentationCategory] ?? 'Otras capacidades';
            const entry = categories.get(category) ?? { enabled: [], enabledCount: 0, disabled: 0 };
            if (enabled?.has(id)) {
                entry.enabledCount++;
                if (TOOL_PRESENTATION[id]) entry.enabled.push(TOOL_PRESENTATION[id][0]);
            }
            else if (enabled) entry.disabled++;
            categories.set(category, entry);
        }
        const capabilityLines = [...categories].map(([category, entry]) => {
            const operations = [...new Set(entry.enabled)];
            const detail = operations.length ? operations.join(', ') : enabled === null
                ? 'Disponibilidad de las operaciones sin comprobar' : entry.enabledCount
                    ? 'Operaciones disponibles en esta categoría' : 'Sin operaciones habilitadas en esta sesión';
            const disabledNote = entry.disabled ? `; ${entry.disabled} registrada${entry.disabled === 1 ? '' : 's'} pero deshabilitada${entry.disabled === 1 ? '' : 's'}` : '';
            return `- **${category}** — ${detail}${disabledNote}.`;
        });
        const counts = `Registradas: ${registered.length}; habilitadas: ${enabled ? [...enabled].length : 'sin comprobar'}.`;
        const voiceStageNames = { ptt: 'micrófono y captura', transcription: 'transcripción', runtime: 'respuesta de Nexa',
            synthesis: 'síntesis de voz', identity_processing: 'identidad vocal', audio_preparation: 'preparación de audio', playback: 'reproducción' };
        const voiceStateNames = { started: 'iniciada', processing: 'en curso', success: 'completada', error: 'con error',
            cancelled: 'cancelada', interrupted: 'interrumpida' };
        const safeErrorNames = { voice_identity_browser_unavailable: 'No está disponible el motor local de identidad vocal.',
            voice_tts_generation_failed: 'Falló la generación de voz.', voice_audio_processing_failed: 'Falló el procesamiento del audio.',
            voice_speech_playback_failed: 'Falló la reproducción de voz.', voice_speech_playback_timeout: 'La reproducción excedió el tiempo esperado.',
            voice_speech_stop_failed: 'No se pudo confirmar la interrupción de la voz.', voice_speech_stop_timeout: 'La interrupción de voz excedió el tiempo esperado.',
            voice_audio_storage_unavailable: 'El almacenamiento temporal de audio no está disponible.', voice_speech_busy: 'Ya había una operación de voz en curso.' };
        const memoryErrorNames = { memory_store_missing: 'No se encontró el almacén de memoria.',
            memory_store_invalid: 'El almacén de memoria no tiene un formato válido.', memory_schema_unsupported: 'La versión del almacén no es compatible.',
            memory_store_changed: 'El almacén cambió durante una operación.', memory_reader_closed: 'El lector de memoria está cerrado.',
            memory_read_failed: 'Falló la última lectura de memoria.', memory_store_unreadable: 'No se pudo leer el almacén de memoria.',
            memory_store_locked: 'El almacén de Memory2 está bloqueado.', memory_persist_failed: 'No se pudo guardar el cambio de memoria.' };
        const lastVoice = voice?.last;
        const lastTranscription = [...(voice?.recent ?? [])].reverse().find(item => item.stage === 'transcription');
        const voiceReady = voice?.configuration?.model !== 'unknown' && voice?.configuration?.voice !== 'unknown';
        const voiceLines = [
            `- **Estado:** ${lastVoice ? `última operación ${voiceStateNames[lastVoice.state] ?? 'registrada'}` : 'Sin ejecuciones recientes registradas'}.`,
            `- **Última etapa:** ${lastVoice ? voiceStageNames[lastVoice.stage] ?? 'etapa registrada' : 'Sin datos recientes'}`,
            `- **Última duración:** ${lastVoice?.durationMs === null || !lastVoice ? 'Sin medición reciente' : `${lastVoice.durationMs} ms`}`,
            `- **Transcripción:** ${lastTranscription ? `${lastTranscription.durations?.transcriptionMs ?? lastTranscription.durationMs ?? 'medición no disponible'}${typeof (lastTranscription.durations?.transcriptionMs ?? lastTranscription.durationMs) === 'number' ? ' ms' : ''}` : 'Sin medición reciente'}`,
            `- **Síntesis:** ${voiceReady ? 'Configurada; el acceso al proveedor no se comprueba desde este informe' : 'Configuración no comprobada'}`,
            `- **Identidad vocal:** ${voice?.configuration?.identityProfile === 'nova-portena' ? 'Nova rioplatense' : voice?.configuration?.identityProfile && voice.configuration.identityProfile !== 'unknown' ? 'Perfil de identidad configurado' : 'Sin perfil comprobado'}`,
            `- **Procesamiento de identidad:** ${voice?.configuration?.identityProcessing === true ? 'Activo' : voice?.configuration?.identityProcessing === false ? 'Desactivado' : 'Sin comprobar'}`,
        ];
        if (lastVoice?.errorCode) voiceLines.push(`- **Incidencia reciente:** ${safeErrorNames[lastVoice.errorCode] ?? 'Se registró un error de voz.'}`);
        const errors = memory.lastError ? (memoryErrorNames[memory.lastError] ?? 'Hay un error de memoria registrado.') : lastVoice?.state === 'error'
            ? 'Hay un error reciente de Voice.' : 'No hay errores recientes registrados en estos diagnósticos.';
        return [
            '**Diagnóstico de Nexa**',
            '', '**1. Sistema central**',
            `- **Runtime:** ${runtimeState}.`,
            `- **Backend y modo de memoria:** ${humanBackend}; ${humanMode}.`,
            `- **Almacén:** ${storeLabel}.`,
            `- **Inicialización:** ${initialization}; **disponibilidad:** ${statusLabel(memory.available)}.`,
            `- **Lectura:** ${retrieval}; **integridad del esquema:** ${validation}.`,
            `- **Verificación operativa:** ${verification}.`,
            `- **Errores relevantes:** ${memory.lastError ? memoryErrorNames[memory.lastError] ?? 'Hay un error de memoria registrado.' : 'No hay error de memoria registrado.'}`,
            '', '**2. Capacidades de Nexa**',
            counts,
            ...(capabilityLines.length ? capabilityLines : ['- No hay herramientas registradas en el snapshot actual.']),
            'El registro de herramientas no confirma por sí solo que un proveedor externo esté conectado.',
            '', '**3. Sistema de voz**', ...voiceLines,
            '', '**4. Evaluación general**',
            `${runtimeState === 'Activo' && memory.available !== false && lastVoice?.state !== 'error'
                ? 'El núcleo de Nexa está operativo según los datos disponibles.'
                : 'El estado presenta aspectos pendientes de comprobar o una incidencia registrada.'} ${errors}`,
        ].join('\n');
    }
    const lines = [
        '**Informe técnico del sistema**',
        `- **Runtime:** ${runtime?.state ?? 'unknown'}${runtime?.id ? ` (${runtime.id})` : ''}`,
        `- **Backend de memoria:** ${memory.backend}`,
        `- **Modo:** ${memory.mode}`,
        `- **Almacén:** ${memory.storeType}`,
        `- **Inicialización:** ${memory.initialized ? 'initialized' : 'not_initialized'}`,
        `- **Disponibilidad:** ${memory.available === true ? 'available' : memory.available === false ? 'unavailable' : 'unknown'}`,
        `- **Lectura habilitada:** ${memory.retrievalEnabled === true ? 'yes' : memory.retrievalEnabled === false ? 'no' : 'unknown'}`,
        `- **Validación de esquema:** ${memory.schemaValidation}`,
        `- **Verificación operativa:** ${operationallyVerified}`,
        `- **Último error de memoria:** ${memory.lastError ?? 'none_recorded'}`,
        `- **Herramientas registradas (${snapshot.tools?.registered?.length ?? 'unknown'}):** ${(snapshot.tools?.registered ?? []).join(', ') || 'unknown'}`,
        `- **Herramientas habilitadas (${available?.length ?? 'unknown'}):** ${(available ?? []).join(', ') || 'unknown'}`,
    ];
    if (voice?.last) {
        lines.push(`- **Voice:** etapa ${voice.last.stage}; estado ${voice.last.state}; error ${voice.last.errorCode ?? 'none_recorded'}`);
        if (voice.last.durationMs !== null) lines.push(`- **Duración última etapa Voice:** ${voice.last.durationMs} ms`);
        lines.push(`- **PTT/transcripción:** ${voice.recent.some(item => item.stage === 'transcription') ? 'registrado' : 'sin ejecución reciente'}`);
        lines.push(`- **TTS/identidad:** ${voice.configuration?.model ?? 'unknown'} / ${voice.configuration?.voice ?? 'unknown'} / ${voice.configuration?.identityProfile ?? 'unknown'}`);
        lines.push(`- **Procesamiento de identidad:** ${voice.configuration?.identityProcessing === true ? 'enabled' : voice.configuration?.identityProcessing === false ? 'disabled' : 'unknown'}`);
    } else lines.push('- **Voice:** sin ejecuciones recientes registradas');
    return lines.join('\n');
}

const TOOL_PRESENTATION = Object.freeze({
    get_current_time: ['Consultar la hora', 'Fecha y hora actuales del equipo.', 'Diagnóstico y sistema'],
    get_weather: ['Consultar el tiempo', 'Tiempo actual y pronóstico de una ciudad.', 'Búsqueda e información'],
    open_app: ['Abrir una aplicación', 'Inicia una aplicación disponible en el equipo.', 'Computadora y aplicaciones'],
    open_url: ['Abrir un sitio web', 'Abre una dirección web permitida.', 'Computadora y aplicaciones'],
    get_open_apps: ['Ver aplicaciones abiertas', 'Consulta las aplicaciones en ejecución.', 'Computadora y aplicaciones'],
    list_directory: ['Listar archivos de una carpeta', 'Muestra nombres de archivos en una ubicación permitida.', 'Archivos y carpetas'],
    read_file: ['Leer un archivo permitido', 'Lee contenido de una ruta autorizada por las reglas existentes.', 'Archivos y carpetas'],
    get_volume: ['Consultar el volumen', 'Muestra el nivel de volumen actual.', 'Voz y audio'],
    set_volume: ['Ajustar el volumen', 'Cambia el nivel de volumen solicitado.', 'Voz y audio'],
    mute_volume: ['Silenciar el audio', 'Silencia la salida de audio.', 'Voz y audio'],
    unmute_volume: ['Activar el audio', 'Quita el silencio de la salida de audio.', 'Voz y audio'],
    media_play_pause: ['Reproducir o pausar audio', 'Alterna la reproducción multimedia del sistema.', 'Voz y audio'],
    is_app_running: ['Comprobar una aplicación', 'Indica si una aplicación está abierta.', 'Computadora y aplicaciones'],
    get_active_window: ['Consultar la ventana activa', 'Identifica la ventana que está al frente.', 'Ventanas y controles'],
    list_windows: ['Ver ventanas abiertas', 'Enumera ventanas disponibles.', 'Ventanas y controles'],
    focus_window: ['Cambiar a una ventana', 'Trae una ventana abierta al frente.', 'Ventanas y controles'],
    maximize_window: ['Maximizar una ventana', 'Amplía una ventana al espacio disponible.', 'Ventanas y controles'],
    minimize_window: ['Minimizar una ventana', 'Oculta temporalmente una ventana.', 'Ventanas y controles'],
    restore_window: ['Restaurar una ventana', 'Restaura una ventana minimizada o maximizada.', 'Ventanas y controles'],
    close_window: ['Cerrar una ventana', 'Cierra una ventana con los controles existentes.', 'Ventanas y controles'],
    inspect_ui: ['Consultar elementos visibles', 'Inspecciona elementos accesibles de una aplicación permitida.', 'Computadora y aplicaciones'],
    find_ui_element: ['Buscar un elemento de interfaz', 'Busca un control visible en una aplicación permitida.', 'Computadora y aplicaciones'],
    focus_ui_element: ['Enfocar un control', 'Lleva el foco a un control de interfaz identificado.', 'Computadora y aplicaciones'],
    invoke_ui_element: ['Activar un control', 'Activa un control de interfaz identificado según los permisos.', 'Computadora y aplicaciones'],
    set_ui_value: ['Cambiar un campo de interfaz', 'Establece un valor en un control identificado.', 'Computadora y aplicaciones'],
    get_ui_value: ['Consultar un campo de interfaz', 'Lee el valor de un control identificado.', 'Computadora y aplicaciones'],
    whatsapp_open_chat: ['Abrir un chat de WhatsApp', 'Abre una conversación identificada.', 'WhatsApp'],
    whatsapp_prepare_message: ['Preparar un mensaje de WhatsApp', 'Prepara un mensaje para revisión antes de enviarlo.', 'WhatsApp'],
    whatsapp_get_status: ['Consultar WhatsApp', 'Comprueba el estado disponible de WhatsApp.', 'WhatsApp'],
    generate_speech: ['Generar voz', 'Genera audio hablado a partir de texto.', 'Voz y audio'],
    play_audio: ['Reproducir audio', 'Reproduce audio generado por Nexa.', 'Voz y audio'],
    spotify_play: ['Reproducir música en Spotify', 'Inicia o reanuda la reproducción.', 'Música y Spotify'],
    spotify_pause: ['Pausar Spotify', 'Pausa la reproducción actual.', 'Música y Spotify'],
    spotify_next: ['Pasar a la siguiente canción', 'Avanza a la pista siguiente.', 'Música y Spotify'],
    spotify_previous: ['Volver a la canción anterior', 'Retrocede o reinicia la pista actual.', 'Música y Spotify'],
    spotify_search: ['Buscar música en Spotify', 'Busca canciones, álbumes o artistas.', 'Música y Spotify'],
    spotify_get_devices: ['Ver dispositivos de Spotify', 'Consulta los dispositivos disponibles.', 'Música y Spotify'],
    spotify_get_current_track: ['Consultar lo que suena', 'Muestra la pista y el estado actuales.', 'Música y Spotify'],
    get_email_connection_status: ['Consultar conexión de correo', 'Comprueba si Outlook está disponible.', 'Correo electrónico'],
    list_email_mailboxes: ['Ver buzones de correo', 'Consulta los buzones disponibles.', 'Correo electrónico'],
    list_recent_emails: ['Ver correos recientes', 'Consulta mensajes recientes de Outlook.', 'Correo electrónico'],
    search_emails: ['Buscar correos', 'Busca mensajes de Outlook.', 'Correo electrónico'],
    prepare_email: ['Preparar un correo', 'Prepara un correo para revisión y confirmación.', 'Correo electrónico'],
    prepare_email_reply: ['Preparar una respuesta', 'Prepara una respuesta para revisión y confirmación.', 'Correo electrónico'],
    resolve_pending_action: ['Consultar una acción pendiente', 'Comprueba el resultado de una acción previa.', 'Correo electrónico'],
    confirm_pending_action: ['Confirmar una acción preparada', 'Confirma una operación pendiente del flujo de comunicaciones.', 'Correo electrónico'],
    cancel_pending_action: ['Cancelar una acción preparada', 'Cancela una operación pendiente del flujo de comunicaciones.', 'Correo electrónico'],
    list_calendar_events: ['Consultar eventos', 'Muestra eventos del calendario.', 'Calendario'],
    get_calendar_event: ['Leer un evento', 'Consulta los detalles de un evento.', 'Calendario'],
    prepare_calendar_event: ['Preparar un evento', 'Prepara un evento para revisión y confirmación.', 'Calendario'],
    prepare_calendar_event_update: ['Preparar un cambio de evento', 'Prepara una modificación para revisión y confirmación.', 'Calendario'],
    prepare_calendar_event_cancel: ['Preparar la cancelación de un evento', 'Prepara una cancelación para revisión y confirmación.', 'Calendario'],
    discover_apps: ['Descubrir aplicaciones', 'Actualiza el inventario de aplicaciones disponibles.', 'Computadora y aplicaciones'],
    get_email: ['Leer un correo electrónico', 'Consulta mensajes de Outlook.', 'Correo electrónico'],
    lifeguard_search_incidents: ['Buscar casos de Lifeguard', 'Busca incidencias CRM con filtros.', 'Lifeguard'],
    lifeguard_read_incident: ['Leer un caso de Lifeguard', 'Consulta una incidencia por referencia.', 'Lifeguard'],
    web_search: ['Buscar información en internet', 'Busca información en la web.', 'Búsqueda e información'],
    remember: ['Guardar un recuerdo', 'Prepara un recuerdo para guardar.', 'Memoria'],
    recall: ['Buscar en la memoria', 'Busca recuerdos relacionados con la consulta.', 'Memoria'],
    forget: ['Olvidar un recuerdo', 'Prepara la eliminación de un recuerdo.', 'Memoria'],
});

function toolPresentation(name, description = '') {
    const mapped = TOOL_PRESENTATION[name];
    const category = mapped?.[2] ?? (/^spotify_/u.test(name) ? 'Música y Spotify'
        : /email|mailbox|pending_action/u.test(name) ? 'Correo electrónico'
            : /calendar|event/u.test(name) ? 'Calendario'
                : /window/u.test(name) ? 'Ventanas y controles'
                    : /^(open_|get_open_apps|is_app_running|discover_apps)/u.test(name) ? 'Computadora y aplicaciones'
                            : /^lifeguard_/u.test(name) ? 'Lifeguard'
                                : /speech|voice|audio/u.test(name) ? 'Voz y audio'
                                    : /whatsapp/u.test(name) ? 'WhatsApp'
                                        : /^(list_directory|read_file)$/u.test(name) ? 'Archivos y carpetas'
                                            : /^(get_volume|set_volume|mute_volume|unmute_volume|media_play_pause|generate_speech|play_audio)$/u.test(name) ? 'Voz y audio'
                            : /^(remember|recall|forget|memory_)/u.test(name) ? 'Memoria' : 'Otras herramientas');
    return { id: name, name: mapped?.[0] ?? name,
        description: mapped?.[1] ?? (typeof description === 'string' ? description.slice(0, 240) : ''), category };
}

export function formatToolCatalog(snapshot, { category = null, technical = false } = {}) {
    const definitions = Array.isArray(snapshot.tools?.definitions) ? snapshot.tools.definitions : [];
    const registered = new Set(snapshot.tools?.registered ?? []);
    const enabled = new Set(snapshot.tools?.available ?? []);
    const descriptionFor = new Map(definitions.map((definition) => [definition.id, definition.description]));
    const tools = [...registered].map((id) => ({ ...toolPresentation(id, descriptionFor.get(id)),
        registered: true, enabled: snapshot.tools?.available === null || snapshot.tools?.available === undefined
            ? 'unknown' : enabled.has(id), connected: 'unknown' }))
        .filter((tool) => !category || tool.category === category);
    const groups = new Map();
    const userTools = snapshot.tools?.available === null || snapshot.tools?.available === undefined
        ? null : tools.filter((tool) => tool.enabled);
    for (const tool of userTools ?? []) groups.set(tool.category, [...(groups.get(tool.category) ?? []), tool]);
    const summaries = {
        'Computadora y aplicaciones': 'Abrir aplicaciones y consultar cuáles están disponibles o en ejecución.',
        'Ventanas y controles': 'Consultar ventanas y usar los controles que estén habilitados.',
        'Archivos y carpetas': 'Listar contenido o leer archivos mediante las herramientas y rutas permitidas.',
        'Música y Spotify': 'Buscar música, consultar la reproducción y usar los controles de Spotify disponibles.',
        'Correo electrónico': 'Consultar y gestionar correos con las operaciones habilitadas.',
        'Calendario': 'Consultar y gestionar eventos con las operaciones habilitadas.',
        'Lifeguard': 'Buscar o consultar casos de Lifeguard con acceso de solo lectura.',
        'WhatsApp': 'Consultar el estado, abrir chats y preparar mensajes.',
        'Búsqueda e información': 'Consultar información web o meteorológica, según disponibilidad.',
        'Diagnóstico y sistema': 'Consultar información operativa del Runtime.',
        'Memoria': 'Consultar o gestionar recuerdos según el modo y las confirmaciones requeridas.',
        'Otras herramientas': 'Hay herramientas adicionales habilitadas para esta sesión.',
    };
    const human = [...groups].map(([name]) => `**${name}**\n${summaries[name] ?? 'Capacidades disponibles en esta categoría.'}`).join('\n\n');
    const text = userTools === null ? 'Todavía no pude comprobar qué herramientas están habilitadas en esta sesión.'
        : category ? groups.has(category) ? `**Herramientas de Spotify**\n\n${summaries['Música y Spotify']}\n\nNo comprobé el estado de conexión en esta consulta.`
            : 'No tengo herramientas de Spotify habilitadas en esta sesión.'
            : userTools.length === 0 ? 'En esta sesión no hay herramientas habilitadas.'
                : `**Mis herramientas**\n\nPuedo ayudarte con estas áreas:\n\n${human}\n\nLa disponibilidad de una herramienta no confirma que su servicio externo esté conectado.`;
    const technicalTools = tools.map(({ description, ...tool }) => tool);
    return { text, tools, technicalDetail: JSON.stringify({ schema: 'nexa-tool-catalog/v1', tools: technicalTools }, null, 2) };
}

export function createTechnicalDiagnosticReport(snapshot, kind = 'memory') {
    const memory = snapshot.memory ?? {};
    const operation = snapshot.lastMemoryRetrieval ?? null;
    const allowedString = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:() -]{1,120}$/u.test(value) ? value : 'unknown';
    const lastChange = snapshot.lastMemoryChange ?? null;
    const voice = snapshot.voice ?? {};
    const voiceErrorDescription = code => ({
        voice_identity_browser_unavailable: 'Browser local de procesamiento de identidad vocal no disponible',
        voice_audio_processing_failed: 'Falló el procesamiento de identidad o audio',
        voice_audio_storage_unavailable: 'No se pudo inicializar el almacenamiento local de audio',
        voice_audio_storage_failed: 'No se pudo guardar el audio preparado',
        voice_tts_generation_failed: 'Falló la solicitud de síntesis de voz',
        voice_tts_response_invalid: 'El proveedor devolvió audio inválido',
        voice_speech_playback_failed: 'Falló la reproducción de audio',
        voice_speech_playback_timeout: 'La reproducción superó el límite de tiempo',
        VOICE_PTT_TRANSCRIPTION_FAILED: 'Falló la transcripción PTT',
    })[code] ?? null;
    const safeVoiceEvent = item => item ? {
        requestId: allowedString(item.requestId), stage: allowedString(item.stage), state: allowedString(item.state),
        errorCode: allowedString(item.errorCode), durationMs: Number.isSafeInteger(item.durationMs) ? item.durationMs : null,
        errorDescription: voiceErrorDescription(item.errorCode),
        durations: Object.fromEntries(['pttFinalizationMs', 'audioConversionMs', 'transcriptionMs', 'runtimeMs', 'speechInitializationMs',
            'synthesisMs', 'identityProcessingMs', 'playbackCommandStartMs', 'responseDispatchToPlaybackMs',
            'identityServerStartupMs', 'identityBrowserStartupMs', 'identityRendererPreparationMs', 'identityDspProcessingMs',
            'identityDspSetupMs', 'identityAudioCaptureWaitMs', 'identityPostProcessingMs', 'audioReadyMs',
            'audioPreparationMs', 'playbackMs']
            .map(key => [key, Number.isSafeInteger(item.durations?.[key]) ? item.durations[key] : null])),
        model: allowedString(item.model), voice: allowedString(item.voice), identityProfile: allowedString(item.identityProfile),
        identityProcessing: typeof item.identityProcessing === 'boolean' ? item.identityProcessing : 'unknown',
        cancellation: allowedString(item.cancellation), at: allowedString(item.at),
    } : null;
    const report = {
        schema: 'nexa-system-diagnostic/v1', component: kind === 'memory' ? 'memory' : kind === 'voice' ? 'voice' : 'runtime',
        runtimeId: allowedString(snapshot.runtime?.id),
        backend: allowedString(operation?.backend ?? memory.backend),
        mode: allowedString(operation?.mode ?? memory.mode),
        initialization: memory.initialized === true ? 'initialized' : memory.initialized === false ? 'not_initialized' : 'unknown',
        storeType: allowedString(memory.storeType),
        storeIdentity: ['unknown', 'not_applicable', 'synthetic_memory_write_01', 'synthetic_memory_desktop_01']
            .includes(memory.storeIdentity) ? memory.storeIdentity : 'unknown',
        readStatus: allowedString(operation?.readStatus), operationId: allowedString(operation?.operationId),
        requestId: allowedString(operation?.requestId), matchCount: Number.isSafeInteger(operation?.matchCount) ? operation.matchCount : null,
        schemaValidation: allowedString(memory.schemaValidation), retrievalEnabled: typeof memory.retrievalEnabled === 'boolean' ? memory.retrievalEnabled : 'unknown',
        contextDelivered: typeof operation?.contextDelivered === 'boolean' ? operation.contextDelivered : 'unknown',
        confirmedWriteAvailability: ['available', 'unavailable', 'degraded', 'unknown'].includes(memory.confirmedWriteAvailability)
            ? memory.confirmedWriteAvailability : 'unknown',
        semanticInterpreterAvailable: typeof memory.semanticInterpreterAvailable === 'boolean' ? memory.semanticInterpreterAvailable : 'unknown',
        lastMemoryChange: lastChange ? {
            operationId: allowedString(lastChange.operationId), requestId: allowedString(lastChange.requestId),
            operation: allowedString(lastChange.operation), candidateState: allowedString(lastChange.candidateState),
            candidateCount: Number.isSafeInteger(lastChange.candidateCount) ? lastChange.candidateCount : null,
            selectedRecordId: allowedString(lastChange.selectedRecordId), matchStrategy: allowedString(lastChange.matchStrategy),
            intentDetected: typeof lastChange.intentDetected === 'boolean' ? lastChange.intentDetected : 'unknown',
            proposalGenerated: typeof lastChange.proposalGenerated === 'boolean' ? lastChange.proposalGenerated : 'unknown',
            confirmationRequested: typeof lastChange.confirmationRequested === 'boolean' ? lastChange.confirmationRequested : 'unknown',
            interpretationMechanism: allowedString(lastChange.interpretationMechanism),
            semanticInterpreterAvailable: typeof lastChange.semanticInterpreterAvailable === 'boolean' ? lastChange.semanticInterpreterAvailable : 'unknown',
            semanticInterpreterInvoked: typeof lastChange.semanticInterpreterInvoked === 'boolean' ? lastChange.semanticInterpreterInvoked : 'unknown',
            semanticInterpretation: allowedString(lastChange.semanticInterpretation),
            runtimeValidation: allowedString(lastChange.runtimeValidation),
            validationCategory: allowedString(lastChange.validationCategory),
            intentAccepted: typeof lastChange.intentAccepted === 'boolean' ? lastChange.intentAccepted : 'unknown',
            clarificationRequested: typeof lastChange.clarificationRequested === 'boolean' ? lastChange.clarificationRequested : 'unknown',
            confirmation: allowedString(lastChange.confirmation), persisted: allowedString(lastChange.persisted),
            result: allowedString(lastChange.result),
            historyFactsDelivered: typeof lastChange.historyFactsDelivered === 'boolean' ? lastChange.historyFactsDelivered : 'unknown',
            historyResponse: ['generated', 'fallback', 'error', 'not_applicable'].includes(lastChange.historyResponse)
                ? lastChange.historyResponse : 'unknown',
            requestedDimension: ['current', 'previous', 'history', 'date', 'reason', 'status', 'unknown'].includes(lastChange.requestedDimension)
                ? lastChange.requestedDimension : 'unknown',
            errorCode: allowedString(lastChange.errorCode),
        } : null,
        modelUse: 'unknown', errorCode: allowedString(operation?.errorCode ?? memory.lastError),
        evidence: operation ? 'Runtime memory retrieval record' : 'No retrieval record',
        ...(kind === 'voice' ? { voice: { configuration: {
            model: allowedString(voice.configuration?.model), voice: allowedString(voice.configuration?.voice),
            identityProfile: allowedString(voice.configuration?.identityProfile),
            identityProcessing: typeof voice.configuration?.identityProcessing === 'boolean' ? voice.configuration.identityProcessing : 'unknown',
        }, last: safeVoiceEvent(voice.last), recent: (Array.isArray(voice.recent) ? voice.recent : []).slice(-8).map(safeVoiceEvent) } } : {}),
        ...(kind !== 'system' ? {} : { tools: [...new Set(snapshot.tools?.registered ?? [])].map((id) => ({ id,
            registered: true, enabled: Array.isArray(snapshot.tools?.available) ? snapshot.tools.available.includes(id) : 'unknown' })),
        }),
    };
    return JSON.stringify(report, null, 2);
}

export function formatMemoryDiagnostics(snapshot, { technical = false } = {}) {
    const { memory, lastMemoryRetrieval: operation, lastMemoryChange } = snapshot;
    const mode = memory.mode === 'memory2-confirmed-write' ? 'Memory2 en modo de escritura confirmada'
        : memory.mode === 'memory2-readonly' ? 'Memory2 en modo de solo lectura'
            : memory.backend === 'memory1' ? 'Memory1' : 'un modo de memoria no identificado';
    let conclusion;
    let code;
    const unproposedExplicitWrite = lastMemoryChange?.intentDetected === true
        && lastMemoryChange.proposalGenerated === false;
    if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'available'
        && lastMemoryChange.errorCode === 'memory_request_not_recognized') {
        code = 'MEMORY_WRITE_PROPOSAL_NOT_GENERATED';
        conclusion = 'Memory2 está activado para guardar recuerdos con confirmación, pero tu última solicitud no llegó a generar una propuesta de guardado. No se guardó ningún recuerdo. Todavía no puedo determinar la causa exacta.';
    } else if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'available'
        && lastMemoryChange.errorCode === 'memory_intent_ambiguous') {
        code = 'MEMORY_INTENT_NEEDS_CLARIFICATION';
        conclusion = 'La solicitud podría referirse a guardar un recuerdo, pero la intención no quedó suficientemente clara. No preparé una propuesta ni guardé nada; hace falta aclarar qué querés recordar.';
    } else if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'available'
        && lastMemoryChange.errorCode === 'memory_intent_no_action') {
        code = 'MEMORY_INTENT_NOT_STRUCTURED';
        conclusion = 'El intérprete no produjo una intención estructurada de guardado o actualización. No preparé una propuesta ni guardé nada.';
    } else if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'available'
        && ['memory_intent_interpretation_failed', 'memory_intent_validation_failed'].includes(lastMemoryChange.errorCode)) {
        code = 'MEMORY_INTENT_INTERPRETATION_FAILED';
        const category = typeof lastMemoryChange.validationCategory === 'string'
            && /^[a-z_]{1,64}$/u.test(lastMemoryChange.validationCategory) ? ` (${lastMemoryChange.validationCategory})` : '';
        conclusion = `No pude validar la interpretación de la solicitud${category}. No preparé una propuesta ni guardé ningún recuerdo.`;
    } else if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'available'
        && lastMemoryChange.errorCode === 'memory_proposal_failed') {
        code = 'MEMORY_PROPOSAL_FAILED';
        conclusion = 'La intención fue reconocida, pero Memory2 no pudo preparar la propuesta. No se guardó ningún recuerdo.';
    } else if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'available') {
        code = 'MEMORY_WRITE_PROPOSAL_NOT_GENERATED';
        conclusion = 'Memory2 está disponible para guardar recuerdos con confirmación, pero esta solicitud no generó una propuesta. No se guardó ningún recuerdo.';
    } else if (unproposedExplicitWrite && memory.confirmedWriteAvailability === 'degraded') {
        code = 'MEMORY_CONFIRMED_WRITE_DEGRADED';
        conclusion = 'La solicitud explícita de guardar fue detectada, pero el mecanismo de propuesta y confirmación no está disponible por completo. No se guardó ningún recuerdo.';
    } else if (!operation && memory.lastError) {
        const memoryFailure = String(memory.lastError).startsWith('memory_');
        code = memoryFailure ? 'MEMORY_INITIALIZATION_FAILED' : 'RUNTIME_INITIALIZATION_FAILED';
        conclusion = memoryFailure
            ? `No pude inicializar el servicio de memoria (${memory.lastError}). No intenté leer recuerdos.`
            : 'No pude inicializar el agente del Runtime. No tengo evidencia suficiente para atribuirlo al servicio de memoria.';
    } else if (!operation) {
        code = 'MEMORY_NO_RETRIEVAL';
        conclusion = 'Todavía no hay una recuperación contextual registrada en este proceso. No modifiqué ningún recuerdo.';
    } else if (operation.readStatus === 'error') {
        code = 'MEMORY_READ_FAILED';
        conclusion = `La última lectura de memoria falló${operation.errorCode ? ` (${operation.errorCode})` : ''}. No puedo afirmar si había una coincidencia.`;
    } else if (operation.readStatus === 'not_applicable') {
        code = 'MEMORY_RETRIEVAL_NOT_APPLICABLE';
        conclusion = 'El modo actual no hizo una recuperación contextual separada; no hay evidencia por operación para explicar el resultado.';
    } else if (operation.matchCount === 0) {
        code = 'MEMORY_NO_MATCH';
        conclusion = 'La lectura se completó, pero no encontró recuerdos relacionados con esa consulta.';
    } else if (operation.matchCount > 0 && operation.contextDelivered === false) {
        code = 'MEMORY_CONTEXT_NOT_DELIVERED';
        conclusion = `La lectura encontró ${operation.matchCount} coincidencia(s), pero el contexto no se entregó al modelo.`;
    } else {
        code = 'MEMORY_CONTEXT_DELIVERED_USAGE_UNKNOWN';
        conclusion = `La lectura encontró ${operation.matchCount ?? 'una o más'} coincidencia(s) y el contexto se incluyó en la solicitud al modelo. No puedo confirmar que lo haya utilizado al redactar la respuesta.`;
    }
    if (!technical) {
        const pendingChange = lastMemoryChange?.confirmation === 'pending'
            ? ' También hay una operación de memoria pendiente de tu confirmación.' : '';
        return `**Diagnóstico de memoria**\n\nEstoy usando ${mode}. ${conclusion}${pendingChange} No cambié ningún recuerdo durante este diagnóstico.`;
    }
    return [
        '**Informe técnico de memoria**',
        `- **Runtime:** ${snapshot.runtime?.id ?? 'unknown'}`,
        `- **Operación:** ${operation?.operationId ?? 'none'}`,
        `- **Solicitud:** ${operation?.requestId ?? 'none'}`,
        `- **Backend:** ${operation?.backend ?? memory.backend}`,
        `- **Modo:** ${operation?.mode ?? memory.mode}`,
        `- **Tipo de almacén:** ${memory.storeType}`,
        `- **Inicialización:** ${memory.initialized ? 'initialized' : 'not_initialized'}`,
        `- **Disponibilidad:** ${memory.available === true ? 'available' : memory.available === false ? 'unavailable' : 'unknown'}`,
        `- **Escritura confirmada:** ${memory.confirmedWriteAvailability ?? 'unknown'}`,
        `- **Intérprete semántico:** ${memory.semanticInterpreterAvailable === true ? 'available' : memory.semanticInterpreterAvailable === false ? 'unavailable' : 'unknown'}`,
        `- **Lectura:** ${operation?.readStatus ?? 'not_recorded'}`,
        `- **Coincidencias:** ${operation?.matchCount ?? 'unknown'}`,
        `- **Afirmaciones:** ${operation?.assertionCount ?? 'unknown'}`,
        `- **Relaciones:** ${operation?.relationCount ?? 'unknown'}`,
        `- **Contexto entregado:** ${operation?.contextDelivered === true ? 'yes' : operation?.contextDelivered === false ? 'no' : 'unknown'}`,
        '- **Uso por el modelo:** unknown',
        `- **Error:** ${operation?.errorCode ?? memory.lastError ?? 'none_recorded'}`,
        `- **Código:** ${code}`,
        `- **Último cambio de memoria:** ${lastMemoryChange ? `${lastMemoryChange.operation}; mecanismo=${lastMemoryChange.interpretationMechanism ?? 'unknown'}; intérprete_invocado=${lastMemoryChange.semanticInterpreterInvoked ?? 'unknown'}; interpretación=${lastMemoryChange.semanticInterpretation ?? 'unknown'}; validación_Runtime=${lastMemoryChange.runtimeValidation ?? 'unknown'}; intención=${lastMemoryChange.intentDetected ?? 'unknown'}; aceptada=${lastMemoryChange.intentAccepted ?? 'unknown'}; propuesta=${lastMemoryChange.proposalGenerated ?? 'unknown'}; aclaración=${lastMemoryChange.clarificationRequested ?? 'unknown'}; confirmación solicitada=${lastMemoryChange.confirmationRequested ?? 'unknown'}; estado=${lastMemoryChange.confirmation}; persistido=${lastMemoryChange.persisted ?? 'unknown'}; resultado=${lastMemoryChange.result}; error=${lastMemoryChange.errorCode ?? 'none'}` : 'not_recorded'}`,
        `- **Conclusión:** ${conclusion}`,
        '- **Persistencia:** evidencia solo en memoria; no se guarda en disco.',
    ].join('\n');
}
