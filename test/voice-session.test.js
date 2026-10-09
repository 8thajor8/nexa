import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceSession, createSpeechRecognizer, VOICE_EVENTS } from '../src/voice/index.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('session correlates lifecycle and transcript events with the right session and turn', async () => {
    let turn = 0;
    let timestamp = 10;
    const session = createVoiceSession({
        sessionId: 'session-test',
        idFactory: () => `turn-${++turn}`,
        now: () => timestamp++,
        recognizer: createSpeechRecognizer({ provider: { async transcribe() { return { text: 'hola', language: 'es' }; } } }),
    });
    const received = [];
    for (const type of VOICE_EVENTS) session.on(type, event => received.push(event));
    assert.equal(session.start(), 'session-test');
    const result = await session.transcribe({ audio: Buffer.from([1]), format: 'wav' });
    assert.deepEqual(result, { sessionId: 'session-test', turnId: 'turn-1', text: 'hola', language: 'es' });
    assert.equal(session.end(), true);
    assert.equal(session.end(), false);
    assert.deepEqual(received.map(event => event.type), [
        'voice.session.started', 'voice.transcribing', 'voice.transcript.final', 'voice.session.ended',
    ]);
    assert.ok(received.every(event => event.sessionId === 'session-test'));
    assert.equal(received[1].turnId, 'turn-1');
    assert.equal(received[2].turnId, 'turn-1');
    assert.equal(received[2].text, 'hola');
});

test('cancelling returns promptly and ignores a late provider result', async () => {
    const pending = deferred();
    let receivedSignal;
    const session = createVoiceSession({
        sessionId: 'session-late',
        idFactory: () => 'turn-late',
        recognizer: { transcribe({ signal }) { receivedSignal = signal; return pending.promise; } },
    });
    const received = [];
    session.on('voice.cancelled', event => received.push(event));
    session.on('voice.transcript.final', event => received.push(event));
    session.start();
    const task = session.transcribe({ audio: Buffer.from([1]), format: 'wav' });
    await Promise.resolve();
    assert.equal(session.cancel('user'), true);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(await task, null);
    pending.resolve({ text: 'late transcript', language: 'es' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(received.map(event => event.type), ['voice.cancelled']);
});

test('starting a new turn cancels the previous one and late errors cannot replace the new result', async () => {
    const first = deferred();
    let call = 0;
    const session = createVoiceSession({
        idFactory: (() => { let index = 0; return () => `turn-${++index}`; })(),
        recognizer: { transcribe() { return ++call === 1 ? first.promise : Promise.resolve({ text: 'new', language: null }); } },
    });
    const received = [];
    for (const type of ['voice.cancelled', 'voice.transcript.final', 'voice.error']) session.on(type, event => received.push(event));
    session.start();
    const oldTask = session.transcribe({ audio: Buffer.from([1]), format: 'wav' });
    await Promise.resolve();
    const newTask = session.transcribe({ audio: Buffer.from([2]), format: 'wav' });
    assert.equal(await oldTask, null);
    const result = await newTask;
    first.reject(new Error('late provider failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.turnId, 'turn-2');
    assert.equal(result.text, 'new');
    assert.deepEqual(received.map(event => [event.type, event.turnId]), [
        ['voice.cancelled', 'turn-1'], ['voice.transcript.final', 'turn-2'],
    ]);
});

test('provider failures emit a sanitized, correlated error event', async () => {
    const session = createVoiceSession({
        sessionId: 'session-error',
        idFactory: () => 'turn-error',
        recognizer: createSpeechRecognizer({ provider: { async transcribe() { throw new Error('token=secret'); } } }),
    });
    const events = [];
    session.on('voice.error', event => events.push(event));
    session.start();
    await assert.rejects(session.transcribe({ audio: Buffer.from([1]), format: 'wav' }), error => error.code === 'voice_provider_error');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'voice.error');
    assert.equal(events[0].sessionId, 'session-error');
    assert.equal(events[0].turnId, 'turn-error');
    assert.doesNotMatch(JSON.stringify(events[0]), /secret|token/iu);
});

test('ending a session cancels active work and prevents future turns', async () => {
    const pending = deferred();
    const session = createVoiceSession({ recognizer: { transcribe() { return pending.promise; } } });
    const events = [];
    session.on('voice.cancelled', event => events.push(event.type));
    session.on('voice.session.ended', event => events.push(event.type));
    session.start();
    const task = session.transcribe({ audio: Buffer.from([1]), format: 'wav' });
    await Promise.resolve();
    session.end();
    assert.equal(await task, null);
    assert.deepEqual(events, ['voice.cancelled', 'voice.session.ended']);
    await assert.rejects(session.transcribe({ audio: Buffer.from([1]), format: 'wav' }), error => error.code === 'voice_session_invalid_state');
    pending.resolve({ text: 'late', language: null });
});
