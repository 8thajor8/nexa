// Profiles are artistic presets, not literal human/digital percentages.
// Keep all audible tuning values here so they can be compared and adjusted.
export const voiceFxProfiles = Object.freeze({
    off: Object.freeze({ presence: 0, lowPassAlpha: 0, delayMix: 0, delayMs: 0, modulationDepthMs: 0, modulationHz: 0 }),
    subtle: Object.freeze({ presence: 0.025, lowPassAlpha: 0.18, delayMix: 0.012, delayMs: 6, modulationDepthMs: 0.25, modulationHz: 0.18 }),
    digital: Object.freeze({ presence: 0.045, lowPassAlpha: 0.18, delayMix: 0.025, delayMs: 8, modulationDepthMs: 0.4, modulationHz: 0.2 }),
    strong: Object.freeze({ presence: 0.065, lowPassAlpha: 0.18, delayMix: 0.04, delayMs: 10, modulationDepthMs: 0.55, modulationHz: 0.22 }),
});

function parsePcmWav(audio) {
    if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array)) throw new TypeError('invalid_audio_buffer');
    const wav = Buffer.from(audio);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new TypeError('invalid_wav');

    let format;
    let data;
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const id = wav.toString('ascii', offset, offset + 4);
        const size = wav.readUInt32LE(offset + 4);
        const body = offset + 8;
        if (size === 0xffffffff || body + size > wav.length) throw new TypeError('invalid_wav_chunk');
        if (id === 'fmt ') {
            if (size < 16) throw new TypeError('invalid_wav_format');
            format = {
                encoding: wav.readUInt16LE(body),
                channels: wav.readUInt16LE(body + 2),
                sampleRate: wav.readUInt32LE(body + 4),
                blockAlign: wav.readUInt16LE(body + 12),
                bitsPerSample: wav.readUInt16LE(body + 14),
            };
        } else if (id === 'data') {
            data = { offset: body, size };
        }
        offset = body + size + (size % 2);
    }
    if (!format || !data || format.encoding !== 1 || format.bitsPerSample !== 16 || ![1, 2].includes(format.channels)
        || format.blockAlign !== format.channels * 2 || !format.sampleRate || data.size % format.blockAlign !== 0) {
        throw new TypeError('unsupported_wav_format');
    }
    return { wav, format, data, frames: data.size / format.blockAlign };
}

function sampleAt(audio, offset) {
    if (offset < 0 || offset + 1 >= audio.length) return 0;
    return audio.readInt16LE(offset);
}

export function createVoiceFxProcessor() {
    return {
        process(audio, profile = 'off') {
            if (!Object.hasOwn(voiceFxProfiles, profile)) throw new TypeError('invalid_voice_fx_profile');
            const settings = voiceFxProfiles[profile];
            if (profile === 'off') {
                if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array)) throw new TypeError('invalid_audio_buffer');
                return Buffer.from(audio);
            }
            const parsed = parsePcmWav(audio);

            const output = Buffer.from(parsed.wav);
            const { channels, sampleRate } = parsed.format;
            const { offset, size } = parsed.data;
            const delayBase = Math.max(1, Math.round(sampleRate * settings.delayMs / 1000));
            const delayDepth = Math.round(sampleRate * settings.modulationDepthMs / 1000);
            const angularSpeed = (2 * Math.PI * settings.modulationHz) / sampleRate;
            const lowState = new Float64Array(channels);

            for (let frame = 0; frame < parsed.frames; frame++) {
                const delayFrames = delayBase + delayDepth * Math.sin(frame * angularSpeed);
                const delayWhole = Math.floor(delayFrames);
                const delayFraction = delayFrames - delayWhole;
                for (let channel = 0; channel < channels; channel++) {
                    const byteOffset = offset + (frame * channels + channel) * 2;
                    const dry = parsed.wav.readInt16LE(byteOffset);
                    lowState[channel] += settings.lowPassAlpha * (dry - lowState[channel]);
                    const presence = dry + settings.presence * (dry - lowState[channel]);
                    const delayedA = sampleAt(parsed.wav, offset + ((frame - delayWhole) * channels + channel) * 2);
                    const delayedB = sampleAt(parsed.wav, offset + ((frame - delayWhole - 1) * channels + channel) * 2);
                    const delayed = delayedA * (1 - delayFraction) + delayedB * delayFraction;
                    const processed = presence * (1 - settings.delayMix) + delayed * settings.delayMix;
                    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(processed))), byteOffset);
                }
            }
            return output;
        },
    };
}
