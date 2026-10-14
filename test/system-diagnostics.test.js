import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySystemDiagnosticRequest, createOperationalDiagnostics,
    createTechnicalDiagnosticReport, formatMemoryDiagnostics, formatSystemStatus, formatToolCatalog, formatVoiceStatus } from '../src/core/system-diagnostics.js';

test('classifies supported Spanish system and memory questions without matching ordinary recall prompts', () => {
    assert.equal(classifySystemDiagnosticRequest('¿Qué sistema de memoria estás usando?'), 'status');
    assert.equal(classifySystemDiagnosticRequest('¿Tenés Memory2 activo?'), 'status');
    assert.equal(classifySystemDiagnosticRequest('¿Qué herramientas tenés disponibles?'), 'tool_catalog');
    assert.equal(classifySystemDiagnosticRequest('Nexa, diagnosticá tu memoria'), 'memory');
    assert.equal(classifySystemDiagnosticRequest('¿Está funcionando Memory2?'), 'memory');
    assert.equal(classifySystemDiagnosticRequest('¿Por qué no recordaste mi editor favorito?'), 'memory');
    assert.equal(classifySystemDiagnosticRequest('Preparame un informe técnico completo para soporte sobre tu última recuperación de memoria'), 'technical_memory');
    assert.equal(classifySystemDiagnosticRequest('¿Qué editor de código prefiero?'), null);
    assert.equal(classifySystemDiagnosticRequest('Dame el diagnóstico técnico de Voice'), 'technical_voice');
    assert.equal(classifySystemDiagnosticRequest('¿Cuál es el estado de PTT?'), 'technical_voice');
    assert.equal(classifySystemDiagnosticRequest('Nexa, dame tu diagnóstico'), 'status');
    assert.equal(classifySystemDiagnosticRequest('Nexa diagnóstico'), 'status');
    assert.equal(classifySystemDiagnosticRequest('¿Cómo están tus sistemas?'), 'status');
    assert.equal(classifySystemDiagnosticRequest('Dame tu estado operativo'), 'status');
    assert.equal(classifySystemDiagnosticRequest('¿Está funcionando tu memoria?'), 'memory');
    assert.equal(classifySystemDiagnosticRequest('Diagnóstico de voz'), 'technical_voice');
    for (const text of ['Generame una respuesta larga para probar tu voz', 'Decime veinte líneas para escuchar cómo hablás',
        'Generame un texto largo para probar el audio', 'Hablame sobre música funk durante un rato']) {
        assert.equal(classifySystemDiagnosticRequest(text), null, `${text} is a normal conversational request`);
    }
    for (const text of ['Tu diagnóstico. Necesito tu diagnóstico de sistema', 'Necesito tu diagnóstico de sistema',
        'Dame tu diagnóstico de sistema', 'Están tus sistemas', '¿Cómo está tu memoria?', '¿Cómo está funcionando tu Runtime?']) {
        assert.ok(classifySystemDiagnosticRequest(text), `${text} should be routed to an internal Nexa diagnostic`);
    }
    for (const text of ['diagnóstico', '¿Cómo está mi PC?', 'Revisá mi computadora', 'Diagnosticá Windows',
        'Revisá los procesos de mi computadora', '¿Qué memoria usa mi computadora?', '¿Cuántos procesos tengo abiertos?',
        '¿Cómo está el rendimiento de mi equipo?', 'Nexa, revisá mi computadora']) {
        assert.equal(classifySystemDiagnosticRequest(text), null, `${text} must not be routed to Nexa status`);
    }
});

test('Voice diagnostics retain bounded safe stage metadata and omit conversation, audio, and credentials', () => {
    const diagnostics = createOperationalDiagnostics();
    diagnostics.recordVoiceOperation({ requestId: '00000000-0000-4000-8000-000000000001', stage: 'identity_processing', state: 'error',
        errorCode: 'voice_identity_browser_unavailable', durationMs: 17, model: 'gpt-4o-mini-tts', voice: 'nova',
        identityProfile: 'nova-portena', identityProcessing: true,
        durations: { pttFinalizationMs: 31, audioConversionMs: 8, speechInitializationMs: 22,
            synthesisMs: 800, ttsSdkResponseMs: 730, ttsBodyReadMs: 50,
            identityProcessingMs: 17, playbackCommandStartMs: 14, responseDispatchToPlaybackMs: 1200,
            responseDispatchToSynthesisMs: 80, responseDispatchToAudioReadyMs: 1150, audioReadyToPlaybackMs: 50,
            identityBrowserStartupMs: 900,
            identityRendererPreparationMs: 120, identityDspSetupMs: 40, identityDspProcessingMs: 7000,
            identityAudioCaptureWaitMs: 6800, identityPostProcessingMs: 15, audioReadyMs: 10300, audioPreparationMs: 2 },
        transcript: 'private utterance', text: 'private response', apiKey: 'secret' });
    const report = JSON.parse(createTechnicalDiagnosticReport(diagnostics.snapshot(), 'voice'));
    assert.equal(report.component, 'voice');
    assert.equal(report.voice.last.stage, 'identity_processing');
    assert.equal(report.voice.last.errorCode, 'voice_identity_browser_unavailable');
    assert.equal(report.voice.last.errorDescription, 'Browser local de procesamiento de identidad vocal no disponible');
    assert.equal(report.voice.last.durations.synthesisMs, 800);
    assert.equal(report.voice.last.durations.ttsSdkResponseMs, 730);
    assert.equal(report.voice.last.durations.ttsBodyReadMs, 50);
    assert.equal(report.voice.last.durations.pttFinalizationMs, 31);
    assert.equal(report.voice.last.durations.audioConversionMs, 8);
    assert.equal(report.voice.last.durations.speechInitializationMs, 22);
    assert.equal(report.voice.last.durations.playbackCommandStartMs, 14);
    assert.equal(report.voice.last.durations.responseDispatchToPlaybackMs, 1200);
    assert.equal(report.voice.last.durations.responseDispatchToSynthesisMs, 80);
    assert.equal(report.voice.last.durations.responseDispatchToAudioReadyMs, 1150);
    assert.equal(report.voice.last.durations.audioReadyToPlaybackMs, 50);
    assert.equal(report.voice.last.durations.identityBrowserStartupMs, 900);
    assert.equal(report.voice.last.durations.identityAudioCaptureWaitMs, 6800);
    assert.equal(report.voice.last.durations.audioReadyMs, 10300);
    assert.equal(report.voice.last.model, 'gpt-4o-mini-tts');
    assert.doesNotMatch(JSON.stringify(report), /private utterance|private response|secret|"apiKey"|"transcript"|C:\\Users\\/iu);
    for (let index = 0; index < 12; index++) diagnostics.recordVoiceOperation({ requestId: `req-${index}`, stage: 'playback', state: 'success' });
    assert.equal(diagnostics.snapshot().voice.recent.length, 8);
});

test('follow-up diagnostics retain only an allowlisted outcome and bounded duration', () => {
    const diagnostics = createOperationalDiagnostics();
    diagnostics.recordVoiceOperation({ requestId: '00000000-0000-4000-8000-000000000002', stage: 'followup', state: 'success',
        durationMs: 5000, followupOutcome: 'prefix_rejected', transcript: 'private transcript' });
    const report = JSON.parse(createTechnicalDiagnosticReport(diagnostics.snapshot(), 'voice'));
    assert.equal(report.voice.last.stage, 'followup');
    assert.equal(report.voice.last.followupOutcome, 'prefix_rejected');
    assert.doesNotMatch(JSON.stringify(report), /private transcript/u);
    diagnostics.recordVoiceOperation({ requestId: '00000000-0000-4000-8000-000000000003', stage: 'followup', state: 'success',
        followupOutcome: 'private transcript' });
    assert.equal(diagnostics.snapshot().voice.last.followupOutcome, null);
});

test('Voice diagnostic is Spanish, Voice-only, and preserves observed follow-up and playback timing', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-readonly' });
    diagnostics.recordVoiceOperation({ requestId: 'safe-request-1', stage: 'followup', state: 'success',
        followupOutcome: 'prefix_accepted', durationMs: 5000 });
    diagnostics.recordVoiceOperation({ requestId: 'safe-request-1', stage: 'transcription', state: 'success', durationMs: 430,
        durations: { transcriptionMs: 430 } });
    diagnostics.recordVoiceOperation({ requestId: 'safe-request-1', stage: 'playback', state: 'success', durationMs: 900,
        model: 'gpt-4o-mini-tts', voice: 'nova', identityProfile: 'nova-portena', identityProcessing: true,
        durations: { responseDispatchToSynthesisMs: 40, responseDispatchToAudioReadyMs: 700,
            responseDispatchToPlaybackMs: 760, audioReadyToPlaybackMs: 60 } });
    const snapshot = { ...diagnostics.snapshot(), tools: { registered: ['spotify_play'], available: ['spotify_play'] } };
    const report = formatVoiceStatus(snapshot);
    assert.match(report, /Diagnóstico de Voice/u);
    assert.match(report, /palabra de activación válida/u);
    assert.match(report, /430 ms/u);
    assert.match(report, /audio listo 700 ms/u);
    assert.match(report, /inicio de reproducción 760 ms/u);
    assert.match(report, /Nova rioplatense; procesamiento activo/u);
    assert.doesNotMatch(report, /Memory2|Spotify|Windows|memoria|spotify_play|safe-request-1/u);
});

test('diagnostic evidence is bounded, in-memory and retained when later reports are requested', () => {
    const diagnostics = createOperationalDiagnostics({ runtimeId: 'runtime-test-1', memoryMode: 'memory2-readonly' });
    diagnostics.setMemoryStatus({ backend: 'memory2', storeType: 'Memory 2 Schema v5', initialized: true,
        available: true, retrievalEnabled: true, schemaValidation: 'validated' });
    const first = diagnostics.recordMemoryRetrieval({ operationId: 'op-test-1', requestId: 'request-test-1',
        mode: 'memory2-readonly', backend: 'memory2', readStatus: 'success', assertionCount: 1,
        relationCount: 0, matchCount: 1, contextDelivered: true });
    const snapshot = diagnostics.snapshot();
    assert.equal(snapshot.lastMemoryRetrieval.operationId, first.operationId);
    assert.equal(snapshot.operations.length, 1);
    assert.match(formatMemoryDiagnostics(snapshot), /contexto se incluyó en la solicitud al modelo/u);
    const report = formatMemoryDiagnostics(snapshot, { technical: true });
    assert.match(report, /MEMORY_CONTEXT_DELIVERED_USAGE_UNKNOWN/u);
    assert.match(report, /Uso por el modelo.*unknown/u);
    assert.doesNotMatch(report, /C:\\Users\\|OPENAI_API_KEY|token/iu);
    for (let index = 0; index < 20; index++) diagnostics.recordMemoryRetrieval({
        operationId: `op-${index}`, readStatus: 'success', matchCount: 0, contextDelivered: false,
    });
    assert.equal(diagnostics.snapshot().operations.length, 12);
    assert.equal(diagnostics.snapshot().lastMemoryRetrieval.operationId, 'op-19');
});

test('diagnostics distinguish missing retrieval, no match and read errors', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory1' });
    assert.match(formatMemoryDiagnostics(diagnostics.snapshot(), { technical: true }), /MEMORY_NO_RETRIEVAL/u);
    diagnostics.recordMemoryRetrieval({ readStatus: 'success', matchCount: 0, contextDelivered: false });
    assert.match(formatMemoryDiagnostics(diagnostics.snapshot()), /no encontró recuerdos/u);
    diagnostics.recordMemoryRetrieval({ readStatus: 'error', errorCode: 'memory_store_changed' });
    const report = formatMemoryDiagnostics(diagnostics.snapshot(), { technical: true });
    assert.match(report, /MEMORY_READ_FAILED/u);
    assert.match(report, /memory_store_changed/u);
    assert.doesNotMatch(report, /secret-value|C:\\Users\\/iu);
});

test('system status separates registered and available tools and reports unknown states honestly', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-confirmed-write' });
    const snapshot = { ...diagnostics.snapshot(), tools: { registered: ['open_app', 'spotify_play'], available: ['open_app'] } };
    const simple = formatSystemStatus(snapshot);
    assert.match(simple, /Backend y modo de memoria:\*\* Memory2; escritura confirmada/u);
    assert.match(simple, /Pendiente de inicialización/u);
    assert.doesNotMatch(simple, /open_app|spotify_play/u);
    const technical = formatSystemStatus(snapshot, { technical: true });
    assert.match(technical, /Herramientas registradas \(2\)/u);
    assert.match(technical, /Herramientas habilitadas \(1\)/u);
    assert.match(technical, /Disponibilidad:\*\* unknown/u);
});

test('human system diagnostic presents runtime, memory, voice and dynamically grouped real capabilities without internal identifiers', () => {
    const diagnostics = createOperationalDiagnostics({ runtimeId: 'private-runtime-id', memoryMode: 'memory2-readonly' });
    diagnostics.setMemoryStatus({ backend: 'memory2', mode: 'memory2-readonly', storeType: 'Memory 2 Schema v5',
        initialized: true, available: true, retrievalEnabled: true, schemaValidation: 'validated' });
    diagnostics.recordMemoryRetrieval({ readStatus: 'success', matchCount: 1 });
    diagnostics.recordVoiceOperation({ requestId: 'private-request-id', stage: 'transcription', state: 'success', durationMs: 520,
        durations: { transcriptionMs: 520 } });
    diagnostics.recordVoiceOperation({ requestId: 'private-request-id', stage: 'playback', state: 'success', durationMs: 850,
        model: 'gpt-4o-mini-tts', voice: 'nova', identityProfile: 'nova-portena', identityProcessing: true,
        durations: { transcriptionMs: 520, synthesisMs: 300, identityProcessingMs: 600 } });
    const snapshot = { ...diagnostics.snapshot(), tools: { registered: ['open_app', 'list_windows', 'read_file',
        'whatsapp_prepare_message', 'search_emails', 'list_calendar_events', 'spotify_play', 'remember',
        'web_search', 'get_weather', 'lifeguard_search_incidents', 'mystery_tool'],
    available: ['open_app', 'list_windows', 'read_file', 'search_emails', 'spotify_play', 'remember', 'get_weather', 'mystery_tool'] } };
    const report = formatSystemStatus(snapshot);
    for (const phrase of ['Diagnóstico de Nexa', 'Sistema central', 'Capacidades de Nexa', 'Sistema de voz', 'Evaluación general',
        'Registradas: 12; habilitadas: 8', 'Runtime:** Activo', 'Backend y modo de memoria:** Memory2; solo lectura',
        'Memory2, esquema versión 5', 'Lectura comprobada correctamente',
        'Control de Windows y aplicaciones', 'Gestión de ventanas e interfaz', 'Archivos y navegación', 'Spotify',
        'Correo electrónico', 'Calendario', 'Memoria y conocimiento', 'Internet, clima, fecha y hora',
        'Integración Lifeguard', 'Sin operaciones habilitadas en esta sesión', 'Nova rioplatense', '520 ms']) {
        assert.ok(report.includes(phrase), `expected report to include ${phrase}`);
    }
    assert.doesNotMatch(report, /open_app|mystery_tool|private-runtime-id|private-request-id|spotify_play|remember/u);
    const technical = formatSystemStatus(snapshot, { technical: true });
    assert.match(technical, /private-runtime-id/u);
    assert.match(technical, /spotify_play/u);
});

test('system status includes full report and catalog requests group only registered tools', () => {
    const snapshot = { runtime: { id: 'runtime-test', state: 'active' },
        memory: { mode: 'memory2-confirmed-write', backend: 'memory2', storeType: 'Memory 2 Schema v5',
            initialized: false, available: null, retrievalEnabled: null, schemaValidation: 'unknown', lastError: null },
        tools: { registered: ['spotify_play', 'spotify_next', 'open_app', 'mystery_tool'],
            available: ['spotify_play', 'open_app'], definitions: [{ id: 'mystery_tool', description: 'Unknown actual tool description' }] },
        lastMemoryRetrieval: null };
    assert.equal(classifySystemDiagnosticRequest('¿Qué sistema de memoria estás usando?'), 'status');
    const status = formatSystemStatus(snapshot);
    assert.match(status, /Sistema central/u);
    assert.match(status, /Capacidades de Nexa/u);
    assert.doesNotMatch(status, /spotify_play|mystery_tool|herramientas disponibles/u);
    assert.equal(classifySystemDiagnosticRequest('¿Qué herramientas tenés disponibles?'), 'tool_catalog');
    const all = formatToolCatalog(snapshot);
    assert.match(all.text, /Música y Spotify/u);
    assert.match(all.text, /Computadora y aplicaciones/u);
    assert.doesNotMatch(all.text, /spotify_play|mystery_tool/u);
    assert.equal(all.tools.find((tool) => tool.id === 'mystery_tool').name, 'mystery_tool');
    assert.equal(all.tools.find((tool) => tool.id === 'mystery_tool').connected, 'unknown');
    assert.doesNotMatch(all.technicalDetail, /Unknown actual tool description/u);
    const spotify = formatToolCatalog(snapshot, { category: 'Música y Spotify' });
    assert.match(spotify.text, /Herramientas de Spotify/u);
    assert.doesNotMatch(spotify.text, /Computadora y aplicaciones/u);
    const unavailableSpotify = formatToolCatalog({ ...snapshot, tools: { ...snapshot.tools, available: ['open_app'] } },
        { category: 'Música y Spotify' });
    assert.match(unavailableSpotify.text, /No tengo herramientas de Spotify habilitadas/u);
});

test('technical diagnostic report is structured, correlated, and omits arbitrary sensitive fields', () => {
    const report = JSON.parse(createTechnicalDiagnosticReport({ runtime: { id: 'runtime-1' }, memory: {
        backend: 'memory2', mode: 'memory2-readonly', storeType: 'Memory 2 Schema v5', initialized: true,
        schemaValidation: 'validated', retrievalEnabled: true, lastError: null, secret: 'do-not-copy',
    }, tools: { registered: ['open_app'], available: ['open_app'] }, lastMemoryRetrieval: {
        operationId: 'op-1', requestId: 'req-1', backend: 'memory2', mode: 'memory2-readonly',
        readStatus: 'success', matchCount: 1, contextDelivered: true, privatePayload: 'do-not-copy',
    } }, 'system'));
    assert.equal(report.operationId, 'op-1');
    assert.equal(report.contextDelivered, true);
    assert.equal(report.tools[0].id, 'open_app');
    assert.equal(report.tools[0].enabled, true);
    assert.equal(JSON.stringify(report).includes('do-not-copy'), false);
});

test('memory diagnostics distinguish confirmed-write availability and an explicit request without a proposal', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-confirmed-write' });
    diagnostics.setMemoryStatus({ backend: 'memory2', mode: 'memory2-confirmed-write', storeType: 'Memory 2 Schema v5',
        initialized: true, available: true, retrievalEnabled: true, confirmedWriteAvailability: 'available' });
    diagnostics.recordMemoryChange({ requestId: 'request-write-1', operation: 'remember', intentDetected: true,
        proposalGenerated: false, confirmationRequested: false, confirmation: 'not_required', persisted: 'no',
        result: 'unknown', errorCode: 'memory_request_not_recognized', proposalText: 'private synthetic value' });
    const snapshot = diagnostics.snapshot();
    const human = formatMemoryDiagnostics(snapshot);
    assert.match(human, /Memory2 está activado para guardar recuerdos con confirmación/u);
    assert.match(human, /no llegó a generar una propuesta/u);
    assert.match(human, /No se guardó ningún recuerdo/u);
    const technical = JSON.parse(createTechnicalDiagnosticReport(snapshot, 'memory'));
    assert.equal(technical.confirmedWriteAvailability, 'available');
    assert.equal(technical.lastMemoryChange.intentDetected, true);
    assert.equal(technical.lastMemoryChange.proposalGenerated, false);
    assert.equal(technical.lastMemoryChange.confirmationRequested, false);
    assert.equal(technical.lastMemoryChange.persisted, 'no');
    assert.equal(technical.lastMemoryChange.errorCode, 'memory_request_not_recognized');
    assert.equal(Object.hasOwn(technical, 'tools'), false, 'memory detail must not dump the full tool catalog');
    assert.doesNotMatch(JSON.stringify(technical), /private synthetic value|proposalText/u);
});

test('unobserved write activity remains unknown instead of being reported as a failed write', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-confirmed-write' });
    diagnostics.setMemoryStatus({ confirmedWriteAvailability: 'available' });
    const report = formatMemoryDiagnostics(diagnostics.snapshot());
    assert.match(report, /Todavía no hay una recuperación contextual registrada/u);
    assert.doesNotMatch(report, /solicitud no llegó|No se guardó ningún recuerdo/u);
});

test('technical memory report exposes only an allowlisted synthetic store identity', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-confirmed-write' });
    diagnostics.setMemoryStatus({ storeIdentity: 'synthetic_memory_write_01' });
    const report = JSON.parse(createTechnicalDiagnosticReport(diagnostics.snapshot(), 'memory'));
    assert.equal(report.storeIdentity, 'synthetic_memory_write_01');

    diagnostics.setMemoryStatus({ storeIdentity: 'C:\\Users\\private\\memory.json' });
    const redacted = JSON.parse(createTechnicalDiagnosticReport(diagnostics.snapshot(), 'memory'));
    assert.equal(redacted.storeIdentity, 'unknown');
    assert.doesNotMatch(JSON.stringify(redacted), /C:\\\\Users|private|memory\.json/u);
});

test('memory diagnostics summarize update confirmation state without retaining proposed content', () => {
    const diagnostics = createOperationalDiagnostics({ memoryMode: 'memory2-confirmed-write' });
    diagnostics.recordMemoryChange({ requestId: 'request-update-1', operation: 'update', candidateState: 'found',
        candidateCount: 1, confirmation: 'pending', result: 'unknown', proposedValue: 'private synthetic value' });
    const snapshot = diagnostics.snapshot();
    const report = formatMemoryDiagnostics(snapshot, { technical: true });
    assert.match(report, /Último cambio de memoria:\*\* update; mecanismo=unknown; intérprete_invocado=unknown; interpretación=unknown; validación_Runtime=unknown; intención=unknown; aceptada=unknown; propuesta=unknown; aclaración=unknown; confirmación solicitada=unknown; estado=pending; persistido=unknown; resultado=unknown/u);
    assert.doesNotMatch(report, /private synthetic value|proposedValue|C:\\Users\\/iu);
    assert.match(formatMemoryDiagnostics(snapshot), /pendiente de tu confirmación/u);
});
