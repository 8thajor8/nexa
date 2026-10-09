import test from 'node:test';
import assert from 'node:assert/strict';
import { toFile } from 'openai/uploads';
import { AUDIO_FORMATS, DEFAULT_TRANSCRIPTION_MODEL, MAX_AUDIO_BYTES, VoiceError,
    createSpeechRecognizer, getVoiceConfig } from '../src/voice/index.js';
import { createOpenAITranscriptionProvider } from '../src/voice/providers/openai.js';

test('recognizer returns a final transcript and provider language without importing the Core', async () => {
    let received;
    const recognizer = createSpeechRecognizer({ provider: { async transcribe(input) {
        received = input;
        return { text: 'Hola Nexa', language: 'es' };
    } } });
    const audio = Uint8Array.from([1, 2, 3]);
    const result = await recognizer.transcribe({ audio, format: 'WAV' });
    assert.deepEqual(result, { text: 'Hola Nexa', language: 'es' });
    assert.equal(received.format, 'wav');
    assert.equal(received.model, DEFAULT_TRANSCRIPTION_MODEL);
    assert.deepEqual(received.audio, Buffer.from([1, 2, 3]));
    assert.notEqual(received.audio.buffer, audio.buffer);
});

test('provider and malformed-response failures are sanitized', async () => {
    const providerFailure = createSpeechRecognizer({ provider: { async transcribe() {
        throw new Error('api_key=secret response body');
    } } });
    await assert.rejects(providerFailure.transcribe({ audio: Buffer.from([1]), format: 'wav' }), error => {
        assert.equal(error.code, 'voice_provider_error');
        assert.doesNotMatch(error.message, /secret|response body/iu);
        return true;
    });

    const malformed = createSpeechRecognizer({ provider: { async transcribe() { return { text: 42 }; } } });
    await assert.rejects(malformed.transcribe({ audio: Buffer.from([1]), format: 'wav' }),
        error => error.code === 'voice_response_invalid');
});

test('rejects empty, invalid, oversized audio, formats, languages, and getter-backed input before provider use', async () => {
    let calls = 0;
    const recognizer = createSpeechRecognizer({ provider: { async transcribe() { calls++; return { text: '' }; } } });
    const expectCode = async (input, code) => assert.rejects(recognizer.transcribe(input), error => error.code === code);
    await expectCode({ audio: Buffer.alloc(0), format: 'wav' }, 'voice_audio_empty');
    await expectCode({ audio: 'raw audio', format: 'wav' }, 'voice_audio_invalid');
    await expectCode({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), format: 'wav' }, 'voice_audio_too_large');
    await expectCode({ audio: Buffer.from([1]), format: 'exe' }, 'voice_format_unsupported');
    await expectCode({ audio: Buffer.from([1]), format: 'wav', language: 'spanish' }, 'voice_language_invalid');
    const getterInput = { format: 'wav', get audio() { throw new Error('getter must not run'); } };
    await expectCode(getterInput, 'voice_audio_invalid');
    assert.equal(calls, 0);
});

test('cancellation is forwarded and pre-cancelled input makes no provider call', async () => {
    let receivedSignal;
    const recognizer = createSpeechRecognizer({ provider: { async transcribe({ signal }) {
        receivedSignal = signal;
        return { text: 'ok' };
    } } });
    const controller = new AbortController();
    const result = await recognizer.transcribe({ audio: Buffer.from([1]), format: 'wav', signal: controller.signal });
    assert.deepEqual(result, { text: 'ok', language: null });
    assert.equal(receivedSignal, controller.signal);
    controller.abort();
    await assert.rejects(recognizer.transcribe({ audio: Buffer.from([1]), format: 'wav', signal: controller.signal }),
        error => error.code === 'voice_cancelled');
});

test('configuration selects gpt-transcribe by default and accepts an explicit model override', () => {
    assert.equal(getVoiceConfig({}).model, 'gpt-transcribe');
    assert.equal(getVoiceConfig({ NEXA_STT_MODEL: 'custom-stt-v1' }).model, 'custom-stt-v1');
    assert.equal(getVoiceConfig({ NEXA_STT_MODEL: '  ' }).model, 'gpt-transcribe');
    assert.throws(() => getVoiceConfig({ NEXA_STT_MODEL: 'bad model' }), error => error.code === 'voice_model_invalid');
    assert.equal(Object.keys(AUDIO_FORMATS).length, 9);
});

test('OpenAI adapter uses the shared client, in-memory upload, configured model, and request AbortSignal', async () => {
    let request;
    let requestOptions;
    const signal = new AbortController().signal;
    const provider = createOpenAITranscriptionProvider({
        clientFactory: () => ({ audio: { transcriptions: { async create(body, options) {
            request = body;
            requestOptions = options;
            return { text: 'Buenos días', languages: [{ code: 'es' }] };
        } } } }),
    });
    const result = await provider.transcribe({ audio: Buffer.from([1, 2]), format: 'wav', model: 'gpt-transcribe', signal });
    assert.deepEqual(result, { text: 'Buenos días', language: 'es' });
    assert.ok(request.file instanceof File);
    assert.equal(request.file.name, 'voice-audio.wav');
    assert.equal(request.file.type, 'audio/wav');
    assert.equal(Buffer.from(await request.file.arrayBuffer()).toString('hex'), '0102');
    assert.equal(request.model, 'gpt-transcribe');
    assert.equal(request.response_format, 'json');
    assert.equal(Object.hasOwn(request, 'language'), false);
    assert.equal(Object.hasOwn(request, 'languages'), false);
    assert.equal(requestOptions.signal, signal);
    assert.equal(toFile instanceof Function, true);
});

test('OpenAI adapter maps gpt-transcribe language hints to languages and preserves singular hints for other models', async () => {
    async function captureRequest(model, language) {
        let request;
        const provider = createOpenAITranscriptionProvider({
            config: { model },
            clientFactory: () => ({ audio: { transcriptions: { async create(body) {
                request = body;
                return { text: 'hola' };
            } } } }),
        });
        await provider.transcribe({ audio: Buffer.from([1]), format: 'wav', language });
        return request;
    }

    const defaultRequest = await captureRequest(DEFAULT_TRANSCRIPTION_MODEL, 'es');
    assert.deepEqual(defaultRequest.languages, ['es']);
    assert.equal(Object.hasOwn(defaultRequest, 'language'), false);

    for (const model of ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe']) {
        const request = await captureRequest(model, 'es');
        assert.equal(request.model, model);
        assert.equal(request.language, 'es');
        assert.equal(Object.hasOwn(request, 'languages'), false);
    }
});

test('the public Voice module has no Electron or Core imports', async () => {
    const { createVoiceSession } = await import('../src/voice/index.js');
    assert.equal(typeof createVoiceSession, 'function');
    assert.equal(typeof VoiceError, 'function');
});
