import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsAudioPlayer } from '../src/speech/windows-player.js';

function deferred() {
    let resolve;
    const promise = new Promise(res => { resolve = res; });
    return { promise, resolve };
}

async function until(predicate) {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('test_condition_timeout');
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

function fakeMci({ onCommand = () => ({ code: 0 }), ...options } = {}) {
    const calls = [];
    const sender = async command => { calls.push(command); return onCommand(command); };
    const player = createWindowsAudioPlayer({ platform: 'win32', sendCommand: sender, pollIntervalMs: 2,
        startTimeoutMs: 100, stopTimeoutMs: 30, completionTimeoutMs: 100, releaseTimeoutMs: 30, ...options });
    return { player, calls };
}

test('MCI play is nonblocking and natural completion closes its alias before resolving', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('play ')) setTimeout(() => { mode = 'stopped'; }, 12);
        if (command.startsWith('status ')) return { code: 0, output: mode };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'natural' });
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 1);
    const result = await playback;
    assert.equal(timerRan, true, 'the event loop runs while the WAV is playing');
    assert.deepEqual(result, { success: true, status: 'completed', released: true, interrupted: false });
    assert(calls.some(item => /^play .*$/u.test(item) && !item.endsWith(' wait')));
    assert(calls.at(-1).startsWith('close '));
    assert.equal(player.getStatus('natural').status, 'completed');
});

test('stop during playback confirms stop, closes resources, and settles play once', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('stop ')) mode = 'stopped';
        if (command.startsWith('status ')) return { code: 0, output: mode };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'stoppable' });
    await until(() => calls.some(item => item.startsWith('play ')));
    const stopped = await player.stop('stoppable');
    const playResult = await playback;
    assert.deepEqual(stopped, { playbackId: 'stoppable', status: 'stopped', confirmed: true, released: true, interrupted: true });
    assert.equal(playResult.status, 'stopped');
    assert.equal(calls.filter(item => item.startsWith('close ')).length, 1);
    assert.equal(player.getStatus('stoppable').released, true);
});

test('stop during open prevents play and releases the alias', async () => {
    const opening = deferred();
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('open ')) return opening.promise;
        if (command.startsWith('status ')) return { code: 0, output: 'stopped' };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'opening' });
    await until(() => calls.some(item => item.startsWith('open ')));
    const stopping = player.stop('opening');
    opening.resolve({ code: 0 });
    const stopped = await stopping;
    const playResult = await playback;
    assert.equal(stopped.released, true);
    assert.equal(stopped.interrupted, false);
    assert.equal(playResult.status, 'stopped');
    assert.equal(calls.some(item => item.startsWith('play ')), false);
    assert.equal(calls.filter(item => item.startsWith('close ')).length, 1);
});

test('repeated stop calls share one physical stop operation', async () => {
    let mode = 'playing';
    const stopGate = deferred();
    let stopCount = 0;
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('stop ')) { stopCount++; return stopGate.promise; }
        if (command.startsWith('status ')) return { code: 0, output: mode };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'repeat-stop' });
    await until(() => calls.some(item => item.startsWith('play ')));
    const firstStop = player.stop('repeat-stop');
    await until(() => stopCount === 1);
    const secondStop = player.stop('repeat-stop');
    mode = 'stopped';
    stopGate.resolve({ code: 0 });
    assert.equal((await firstStop).released, true);
    assert.equal((await secondStop).released, true);
    await playback;
    assert.equal(stopCount, 1);
});

test('natural completion racing with stop is not reported as an interruption', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('stop ')) { mode = 'stopped'; return { code: 263 }; }
        if (command.startsWith('status ')) return { code: 0, output: mode };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'completion-race' });
    await until(() => calls.some(item => item.startsWith('play ')));
    mode = 'stopped';
    const stopped = await player.stop('completion-race');
    const result = await playback;
    assert.equal(stopped.status, 'already_finished');
    assert.equal(stopped.interrupted, false);
    assert.equal(result.status, 'completed');
    assert.equal(calls.filter(item => item.startsWith('close ')).length, 1);
});

test('stop failure with playback still active degrades, then recovers only after confirming release', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ stopTimeoutMs: 12, onCommand(command) {
        if (command.startsWith('stop ')) return { code: 263 };
        if (command.startsWith('status ')) return { code: 0, output: mode };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'stop-fail' });
    await until(() => calls.some(item => item.startsWith('play ')));
    const stopped = await player.stop('stop-fail');
    assert.equal(stopped.confirmed, false);
    assert.equal(stopped.released, false);
    assert.equal(player.getStatus('stop-fail').status, 'unknown');
    const blocked = await player.play('other.wav', { playbackId: 'blocked' });
    assert.equal(blocked.error.code, 'audio_player_degraded');
    assert.equal(calls.filter(item => item.startsWith('play ')).length, 1);
    mode = 'stopped';
    const recovered = await player.stop('stop-fail');
    assert.equal(recovered.released, true);
    await playback;
    const next = player.play('next.wav', { playbackId: 'recovered' });
    await until(() => calls.filter(item => item.startsWith('play ')).length === 2);
    mode = 'stopped';
    assert.equal((await next).status, 'completed');
});

test('status timeout or error keeps resources and temporary audio classified unknown', async () => {
    const { player, calls } = fakeMci({ completionTimeoutMs: 14, onCommand(command) {
        if (command.startsWith('status ')) return { code: 5, output: '' };
        return { code: 0 };
    } });
    const result = await player.play('controlled.wav', { playbackId: 'status-fail' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.released, false);
    assert.equal(player.getStatus('status-fail').degraded, true);
    assert.equal(calls.some(item => item.startsWith('close ')), false);
});

test('close error never reports resources released and leaves the controller degraded', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('status ')) { mode = 'stopped'; return { code: 0, output: mode }; }
        if (command.startsWith('close ')) return { code: 5 };
        return { code: 0 };
    } });
    const result = await player.play('controlled.wav', { playbackId: 'close-fail' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.released, false);
    assert.equal(player.getStatus('close-fail').degraded, true);
    assert.equal(calls.at(-1).startsWith('close '), true);
    assert.equal((await player.play('other.wav', { playbackId: 'no-overlap' })).error.code, 'audio_player_degraded');
});

test('one active playback blocks overlap and a later playback works after confirmed release', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('stop ')) mode = 'stopped';
        if (command.startsWith('status ')) return { code: 0, output: mode };
        if (command.startsWith('play ')) mode = 'playing';
        return { code: 0 };
    } });
    const first = player.play('one.wav', { playbackId: 'one' });
    await until(() => calls.some(item => item.startsWith('play ')));
    assert.equal((await player.play('two.wav', { playbackId: 'two' })).error.code, 'audio_player_busy');
    assert.equal((await player.stop('one')).released, true);
    await first;
    const second = player.play('two.wav', { playbackId: 'two' });
    await until(() => calls.filter(item => item.startsWith('play ')).length === 2);
    mode = 'stopped';
    assert.equal((await second).status, 'completed');
});

test('dispose stops active playback and closes resources before returning', async () => {
    let mode = 'playing';
    const { player, calls } = fakeMci({ onCommand(command) {
        if (command.startsWith('stop ')) mode = 'stopped';
        if (command.startsWith('status ')) return { code: 0, output: mode };
        return { code: 0 };
    } });
    const playback = player.play('controlled.wav', { playbackId: 'dispose' });
    await until(() => calls.some(item => item.startsWith('play ')));
    assert.equal((await player.dispose()).success, true);
    assert.equal((await playback).status, 'stopped');
    assert(calls.at(-1).startsWith('close '));
});
