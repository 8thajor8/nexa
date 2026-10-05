export function createWindowsAudioPlayer({ platform = process.platform, playSound } = {}) {
    return async function play(audioPath) {
        if (platform !== 'win32') return { success: false, error: { code: 'unsupported_platform', message: 'La reproducción local solo está disponible en Windows.' } };
        if (playSound) {
            try { await playSound(audioPath); return { success: true }; }
            catch { return { success: false, error: { code: 'audio_playback_failed', message: 'Windows no pudo reproducir el audio.' } }; }
        }
        let playSoundW;
        try {
            const { default: koffi } = await import('koffi');
            const winmm = koffi.load('winmm.dll');
            playSoundW = winmm.func('__stdcall', 'PlaySoundW', 'int32_t', ['str16', 'void *', 'uint32_t']);
        } catch {
            return { success: false, error: { code: 'audio_playback_unavailable', message: 'La reproducción de audio no está disponible en Windows.' } };
        }
        try {
            const succeeded = playSoundW(audioPath, null, 0x00020002); // SND_FILENAME | SND_NODEFAULT; synchronous playback
            return succeeded
                ? { success: true }
                : { success: false, error: { code: 'audio_device_unavailable', message: 'Windows no pudo reproducir el audio en el dispositivo predeterminado.' } };
        } catch {
            return { success: false, error: { code: 'audio_playback_failed', message: 'Windows no pudo reproducir el audio.' } };
        }
    };
}
