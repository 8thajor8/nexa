import { randomBytes } from 'node:crypto';

// MCI play runs without `wait`, so Node can poll and accept stop requests.
// Individual Koffi calls remain synchronous and cannot be preempted by JS timers.
const defaults = Object.freeze({ startTimeoutMs: 10_000, stopTimeoutMs: 3_000, completionTimeoutMs: 300_000, releaseTimeoutMs: 3_000, pollIntervalMs: 50 });
const terminalStates = new Set(['stopped', 'completed', 'failed']);

function failure(code, status = 'failed', released = false) {
    return { success: false, status, released, error: { code, message: 'Windows no pudo completar la reproducción de audio.' } };
}

function withTimeout(promise, timeoutMs, code) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
    return Promise.race([Promise.resolve(promise).then(value => ({ value }), () => ({ failed: true })), timeout])
        .then(result => result.timedOut ? { timedOut: true, code } : result)
        .finally(() => clearTimeout(timer));
}

export function createWindowsAudioPlayer({
    platform = process.platform,
    sendCommand,
    startTimeoutMs = defaults.startTimeoutMs,
    stopTimeoutMs = defaults.stopTimeoutMs,
    completionTimeoutMs = defaults.completionTimeoutMs,
    releaseTimeoutMs = defaults.releaseTimeoutMs,
    pollIntervalMs = defaults.pollIntervalMs,
    idFactory = () => `NexaAudio${randomBytes(6).toString('hex')}`,
} = {}) {
    for (const value of [startTimeoutMs, stopTimeoutMs, completionTimeoutMs, releaseTimeoutMs, pollIntervalMs]) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('mci_timeout_invalid');
    }
    if (typeof idFactory !== 'function') throw new TypeError('mci_id_factory_invalid');

    const records = new Map();
    let active = null;
    let degraded = false;
    let disposed = false;
    let clientPromise;
    let commandQueue = Promise.resolve();

    async function getCommandSender() {
        if (sendCommand) return sendCommand;
        if (!clientPromise) clientPromise = import('koffi').then(({ default: koffi }) => {
            const winmm = koffi.load('winmm.dll');
            const mciSendStringW = winmm.func('__stdcall', 'mciSendStringW', 'uint32_t', ['str16', 'void *', 'uint32_t', 'void *']);
            const sender = command => {
                const isStatus = command.startsWith('status ');
                const output = isStatus ? koffi.alloc('uint16_t', 256) : null;
                try {
                    const code = mciSendStringW(command, output, isStatus ? 256 : 0, null);
                    return { code, output: isStatus ? koffi.decode.string16(output) : undefined };
                } finally { if (output) koffi.free(output); }
            };
            sender.dispose = () => { winmm.unload(); };
            return sender;
        });
        return clientPromise;
    }

    function command(text) {
        const operation = commandQueue.then(async () => {
            const sender = await getCommandSender();
            const result = await sender(text);
            if (typeof result === 'number') return { code: result, output: undefined };
            if (!result || !Number.isInteger(result.code)) throw new Error('mci_invalid_command_result');
            return result;
        });
        commandQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    function remember(record) {
        records.set(record.playbackId, record);
        while (records.size > 100) {
            const oldest = records.keys().next().value;
            if (records.get(oldest) === active) break;
            records.delete(oldest);
        }
    }

    function snapshot(record) {
        return Object.freeze({ playbackId: record.playbackId, status: record.status,
            errorCode: record.errorCode ?? null, released: record.released === true });
    }

    function settle(record, result, status) {
        if (record.settled) return;
        record.settled = true;
        record.status = status;
        record.released = result.released === true;
        record.errorCode = result.error?.code ?? null;
        if (record.released && active === record) {
            active = null;
            degraded = false;
        }
        if (!record.released) degraded = true;
        record.resolveDone(result);
    }

    async function closeRecord(record) {
        const closed = await withTimeout(command(`close ${record.alias}`), releaseTimeoutMs, 'audio_close_timeout');
        if (closed.timedOut) return { success: false, status: 'unknown', released: false, error: { code: 'audio_close_timeout' } };
        if (closed.failed || closed.value.code !== 0) return { success: false, status: 'unknown', released: false, error: { code: 'audio_close_failed' } };
        return { success: true, status: 'stopped', released: true };
    }

    async function readMode(record, timeoutMs = stopTimeoutMs) {
        const result = await withTimeout(command(`status ${record.alias} mode`), timeoutMs, 'audio_status_timeout');
        if (result.timedOut) return { ok: false, code: 'audio_status_timeout' };
        if (result.failed || result.value.code !== 0 || typeof result.value.output !== 'string') return { ok: false, code: 'audio_status_failed' };
        const mode = result.value.output.trim().toLowerCase();
        if (!['playing', 'stopped', 'paused', 'open', 'not ready'].includes(mode)) return { ok: false, code: 'audio_status_unknown' };
        return { ok: true, mode };
    }

    function finish(record, terminalStatus) {
        if (record.finalizePromise) return record.finalizePromise;
        if (record.settled) return record.done;
        record.finalizePromise = (async () => {
            record.status = terminalStatus;
            const closed = await closeRecord(record);
            if (!closed.released) {
                const result = failure(closed.error.code, 'unknown', false);
                settle(record, result, 'unknown');
                return result;
            }
            const result = { success: terminalStatus === 'completed', status: terminalStatus, released: true,
                interrupted: terminalStatus === 'stopped' && record.startedPlayback };
            if (!result.success) result.error = { code: 'audio_playback_stopped', message: 'La reproducción fue detenida.' };
            settle(record, result, terminalStatus);
            return result;
        })();
        return record.finalizePromise;
    }

    async function stopRecord(record) {
        if (record.stopPromise) return record.stopPromise;
        record.stopRequested = true;
        record.stopPromise = (async () => {
            await record.ready;
            const stopDeadline = Date.now() + stopTimeoutMs;
            const remainingStopMs = () => Math.max(1, stopDeadline - Date.now());
            if (record.settled) return record.done;
            if (record.finalizePromise) return record.finalizePromise;
            if (!record.playAttempted) {
                if (record.openAttempted) {
                    if (!record.opened) {
                        const stopResult = await withTimeout(command(`stop ${record.alias}`), remainingStopMs(), 'audio_stop_timeout');
                        const status = await readMode(record, remainingStopMs());
                        if (!status.ok || status.mode !== 'stopped') {
                            const result = failure(status.code ?? stopResult.code ?? 'audio_stop_unconfirmed', 'unknown', false);
                            settle(record, result, 'unknown');
                            return result;
                        }
                    }
                }
                const closed = record.openAttempted ? await closeRecord(record) : { released: true };
                if (closed.released) {
                    const result = { success: false, status: 'stopped', released: true, interrupted: false,
                        error: { code: 'audio_playback_cancelled', message: 'La reproducción se canceló antes de comenzar.' } };
                    settle(record, result, 'stopped');
                    return result;
                }
                const result = failure(closed.error.code, 'unknown', false);
                settle(record, result, 'unknown');
                return result;
            }

            record.status = 'stop_requested';
            const beforeStop = await readMode(record, remainingStopMs());
            if (!beforeStop.ok) {
                const result = failure(beforeStop.code, 'unknown', false);
                settle(record, result, 'unknown');
                return result;
            }
            if (beforeStop.mode === 'stopped') {
                record.startedPlayback = false;
                return finish(record, record.playAttempted ? 'completed' : 'stopped');
            }
            if (beforeStop.mode === 'open' && !record.startedPlayback) return finish(record, 'stopped');
            if (beforeStop.mode !== 'playing') {
                const result = failure('audio_status_unknown', 'unknown', false);
                settle(record, result, 'unknown');
                return result;
            }
            const stoppedCommand = await withTimeout(command(`stop ${record.alias}`), remainingStopMs(), 'audio_stop_timeout');
            let mode = await readMode(record, remainingStopMs());
            if (!mode.ok) {
                const result = failure(mode.code, 'unknown', false);
                settle(record, result, 'unknown');
                return result;
            }
            if (mode.mode === 'playing') {
                while (mode.ok && mode.mode === 'playing' && Date.now() < stopDeadline) {
                    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
                    mode = await readMode(record, remainingStopMs());
                }
            }
            if (!mode.ok || mode.mode !== 'stopped') {
                const result = failure(mode.code ?? 'audio_stop_unconfirmed', 'unknown', false);
                settle(record, result, 'unknown');
                return result;
            }
            const stopConfirmed = !stoppedCommand.timedOut && !stoppedCommand.failed && stoppedCommand.value.code === 0;
            // If stop failed but mode is now stopped, release safely while treating it as a natural finish race.
            if (!stopConfirmed) {
                record.startedPlayback = false;
                return finish(record, 'completed');
            }
            return finish(record, 'stopped');
        })();
        return record.stopPromise;
    }

    async function start(record, audioPath) {
        if (platform !== 'win32') {
            record.readyResolve();
            settle(record, failure('unsupported_platform', 'failed', true), 'failed');
            return;
        }
        if (typeof audioPath !== 'string' || !audioPath || /["\r\n]/u.test(audioPath)) {
            record.readyResolve();
            settle(record, failure('invalid_audio_reference', 'failed', true), 'failed');
            return;
        }
        try {
            record.openAttempted = true;
            const startDeadline = Date.now() + startTimeoutMs;
            const remainingStartMs = () => Math.max(1, startDeadline - Date.now());
            const opening = await withTimeout(command(`open "${audioPath}" type waveaudio alias ${record.alias}`), remainingStartMs(), 'audio_start_timeout');
            if (opening.timedOut || opening.failed || opening.value.code !== 0) {
                record.readyResolve();
                const closed = opening.timedOut || opening.failed ? { released: false } : await closeRecord(record);
                const result = failure(opening.timedOut ? 'audio_start_timeout' : 'audio_open_failed', closed.released ? 'failed' : 'unknown', closed.released);
                settle(record, result, result.status);
                return;
            }
            record.opened = true;
            record.readyResolve();
            if (record.stopRequested) return;

            record.status = 'starting';
            record.playAttempted = true;
            const playing = await withTimeout(command(`play ${record.alias}`), remainingStartMs(), 'audio_start_timeout');
            if (playing.timedOut || playing.failed || playing.value.code !== 0) {
                const result = failure(playing.timedOut ? 'audio_start_timeout' : 'audio_playback_failed', 'unknown', false);
                settle(record, result, 'unknown');
                return;
            }
            record.startedPlayback = true;
            record.status = 'playing';
            if (record.stopRequested) { await stopRecord(record); return; }

            const deadline = Date.now() + completionTimeoutMs;
            while (!record.settled && !record.stopRequested) {
                const mode = await readMode(record, Math.max(1, deadline - Date.now()));
                if (!mode.ok) {
                    if (Date.now() >= deadline) {
                        settle(record, failure(mode.code, 'unknown', false), 'unknown');
                        return;
                    }
                } else if (mode.mode === 'stopped') {
                    await finish(record, 'completed');
                    return;
                } else if (mode.mode !== 'playing') {
                    settle(record, failure('audio_status_unknown', 'unknown', false), 'unknown');
                    return;
                }
                if (Date.now() >= deadline) {
                    settle(record, failure('audio_completion_timeout', 'unknown', false), 'unknown');
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            }
        } catch {
            record.readyResolve();
            const result = failure('audio_playback_failed', record.openAttempted ? 'unknown' : 'failed', !record.openAttempted);
            settle(record, result, result.status);
        }
    }

    function play(audioPath, { playbackId = idFactory() } = {}) {
        if (disposed) return Promise.resolve(failure('audio_player_disposed'));
        if (typeof playbackId !== 'string' || !playbackId || records.has(playbackId)) return Promise.resolve(failure('audio_playback_id_invalid'));
        if (degraded || active) return Promise.resolve(failure(degraded ? 'audio_player_degraded' : 'audio_player_busy', degraded ? 'unknown' : 'failed', false));
        let resolveDone;
        let readyResolve;
        const record = { playbackId, alias: `NexaAudio${randomBytes(6).toString('hex')}`, status: 'starting', opened: false, openAttempted: false,
            startedPlayback: false, stopRequested: false, settled: false, released: false,
            done: new Promise(resolve => { resolveDone = resolve; }), resolveDone,
            ready: new Promise(resolve => { readyResolve = resolve; }), readyResolve };
        // Assign resolvers after Promise construction to avoid exposing mutable callbacks.
        record.resolveDone = resolveDone;
        record.readyResolve = readyResolve;
        active = record;
        remember(record);
        void start(record, audioPath);
        return record.done;
    }

    async function stop(playbackId) {
        const record = records.get(playbackId);
        if (!record) return { playbackId, status: 'unknown', confirmed: false, released: false, interrupted: false };
        if (record.settled && !(record.status === 'unknown' && !record.released && active === record)) return { playbackId, status: record.status === 'completed' ? 'already_finished' : record.status,
            confirmed: record.released && terminalStates.has(record.status), released: record.released, interrupted: false,
            ...(record.status === 'unknown' && record.errorCode ? { error: { code: record.errorCode } } : {}) };
        if (record.status === 'unknown' && !record.released && active === record) {
            record.settled = false;
            record.stopPromise = null;
            record.finalizePromise = null;
        }
        if (active !== record) return { playbackId, status: 'unknown', confirmed: false, released: false, interrupted: false };
        const result = await stopRecord(record);
        return { playbackId, status: result.status === 'stopped' && result.interrupted ? 'stopped' : result.status === 'completed' ? 'already_finished' : result.status,
            confirmed: result.released === true, released: result.released === true,
            interrupted: result.status === 'stopped' && result.interrupted === true,
            ...(result.status === 'unknown' && result.error ? { error: result.error } : {}) };
    }

    function getStatus(playbackId) {
        const record = records.get(playbackId);
        if (!record) return Object.freeze({ playbackId, status: 'unknown', released: false, degraded });
        return Object.freeze({ ...snapshot(record), degraded });
    }

    async function dispose() {
        if (disposed) return { success: true, status: 'disposed', degraded: false };
        if (active) {
            const result = await stop(active.playbackId);
            if (!result.released) return { success: false, status: 'unknown', degraded: true };
        }
        if (degraded) return { success: false, status: 'unknown', degraded: true };
        if (clientPromise) {
            try { (await clientPromise).dispose?.(); }
            catch { return { success: false, status: 'unknown', degraded: true }; }
        }
        disposed = true;
        clientPromise = undefined;
        return { success: true, status: 'disposed', degraded: false };
    }

    return Object.freeze({ play, stop, getStatus, dispose, get degraded() { return degraded; } });
}
