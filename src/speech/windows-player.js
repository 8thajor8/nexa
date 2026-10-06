import { randomBytes } from 'node:crypto';

// MCI opens WAV files through Windows' multimedia subsystem and waits for the
// `play ... wait` command to finish before returning. The path comes only from
// Nexa's audio registry; this module never accepts model-provided commands.
export function createWindowsAudioPlayer({ platform = process.platform, sendCommand } = {}) {
    return async function play(audioPath) {
        if (platform !== 'win32') return { success: false, error: { code: 'unsupported_platform', message: 'La reproducción local solo está disponible en Windows.' } };

        let execute = sendCommand;
        if (!execute) {
            try {
                const { default: koffi } = await import('koffi');
                const winmm = koffi.load('winmm.dll');
                const mciSendStringW = winmm.func('__stdcall', 'mciSendStringW', 'uint32_t', ['str16', 'str16', 'uint32_t', 'void *']);
                execute = command => mciSendStringW(command, null, 0, null);
            } catch {
                return { success: false, error: { code: 'audio_playback_unavailable', message: 'El backend de reproducción de Windows no está disponible.' } };
            }
        }

        // Paths are from Nexa's own data directory. Reject unusual quotes so
        // they cannot escape the single MCI filename argument.
        if (typeof audioPath !== 'string' || !audioPath || /["\r\n]/u.test(audioPath)) {
            return { success: false, error: { code: 'invalid_audio_reference', message: 'La referencia interna de audio no es válida.' } };
        }

        const alias = `NexaAudio${randomBytes(6).toString('hex')}`;
        let opened = false;
        try {
            const openResult = await execute(`open "${audioPath}" type waveaudio alias ${alias}`);
            if (openResult !== 0) return playbackFailure('Windows no pudo abrir el archivo de audio.');
            opened = true;

            const playResult = await execute(`play ${alias} wait`);
            if (playResult !== 0) return playbackFailure('Windows no pudo completar la reproducción del audio.');
            return { success: true };
        } catch {
            return playbackFailure('Windows no pudo reproducir el audio.');
        } finally {
            if (opened) {
                try { await execute(`close ${alias}`); } catch { /* best-effort resource cleanup */ }
            }
        }
    };
}

function playbackFailure(message) {
    return { success: false, error: { code: 'audio_playback_failed', message } };
}
