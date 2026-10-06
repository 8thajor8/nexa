// Profiles are artistic presets, not literal human/digital percentages.
// Keep all audible tuning values here so they can be compared and adjusted.
export const voiceFxProfiles = Object.freeze({
    off: Object.freeze({ presence: 0, lowPassAlpha: 0, delayMix: 0, delayMs: 0, modulationDepthMs: 0, modulationHz: 0 }),
    subtle: Object.freeze({ family: 'classic', presence: 0.08, lowPassAlpha: 0.18, delayMix: 0.035, delayMs: 6, modulationDepthMs: 0.35, modulationHz: 0.18 }),
    digital: Object.freeze({ family: 'classic', presence: 0.16, lowPassAlpha: 0.18, delayMix: 0.12, delayMs: 9, modulationDepthMs: 0.8, modulationHz: 0.22 }),
    strong: Object.freeze({ family: 'classic', presence: 0.28, lowPassAlpha: 0.18, delayMix: 0.32, delayMs: 13, modulationDepthMs: 1.8, modulationHz: 0.25 }),
    synthetic_companion: Object.freeze({
        family: 'filtered_companion',
        primaryGain: 0.82,
        layerGain: 0.42,
        formantOneHz: 1450,
        formantOneQ: 1.1,
        formantTwoHz: 2550,
        formantTwoQ: 1.35,
        formantBlend: 0.62,
        layerDelayMs: 3.5,
        peakTarget: 0.92,
    }),
    digital_spatial: Object.freeze({
        family: 'early_reflections',
        directGain: 0.82,
        leftDelayMs: 11,
        rightDelayMs: 19,
        reflectionGain: 0.25,
        reflectionLowPassAlpha: 0.48,
        peakTarget: 0.94,
    }),
    nexa_hybrid: Object.freeze({
        family: 'hybrid',
        primaryGain: 0.82,
        layerGain: 0.28,
        formantOneHz: 1650,
        formantOneQ: 1.05,
        formantTwoHz: 2800,
        formantTwoQ: 1.3,
        formantBlend: 0.55,
        leftDelayMs: 12,
        rightDelayMs: 21,
        reflectionGain: 0.13,
        reflectionLowPassAlpha: 0.5,
        peakTarget: 0.94,
    }),
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
                offset: body,
                encoding: wav.readUInt16LE(body),
                channels: wav.readUInt16LE(body + 2),
                sampleRate: wav.readUInt32LE(body + 4),
                blockAlign: wav.readUInt16LE(body + 12),
                bitsPerSample: wav.readUInt16LE(body + 14),
            };
        } else if (id === 'data') {
            data = { offset: body, headerOffset: offset, size };
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

            if (settings.family === 'filtered_companion') return processFilteredCompanion(parsed, settings);
            if (settings.family === 'early_reflections') return processSpatialReflections(parsed, settings);
            if (settings.family === 'hybrid') return processHybrid(parsed, settings);

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

function makeBandPass(sampleRate, frequency, q) {
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const alpha = Math.sin(omega) / (2 * q);
    const a0 = 1 + alpha;
    return {
        b0: alpha / a0,
        b1: 0,
        b2: -alpha / a0,
        a1: (-2 * Math.cos(omega)) / a0,
        a2: (1 - alpha) / a0,
        x1: 0,
        x2: 0,
        y1: 0,
        y2: 0,
    };
}

function filterSample(filter, input) {
    const output = filter.b0 * input + filter.b1 * filter.x1 + filter.b2 * filter.x2
        - filter.a1 * filter.y1 - filter.a2 * filter.y2;
    filter.x2 = filter.x1;
    filter.x1 = input;
    filter.y2 = filter.y1;
    filter.y1 = output;
    return output;
}

function sourceSample(parsed, frame, channel = 0) {
    if (frame < 0 || frame >= parsed.frames) return 0;
    const selectedChannel = parsed.format.channels === 1 ? 0 : channel;
    return parsed.wav.readInt16LE(parsed.data.offset + (frame * parsed.format.channels + selectedChannel) * 2);
}

function writeProcessedWav(parsed, samples, channels, peakTarget) {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const maxSample = 32767 * peakTarget;
    const gain = peak > maxSample ? maxSample / peak : 1;
    const outputData = Buffer.allocUnsafe(samples.length * 2);
    for (let index = 0; index < samples.length; index++) {
        const sample = Math.round(samples[index] * gain);
        outputData.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), index * 2);
    }

    const header = Buffer.from(parsed.wav.subarray(0, parsed.data.offset));
    const trailer = parsed.wav.subarray(parsed.data.offset + parsed.data.size);
    const bytesPerFrame = channels * 2;
    header.writeUInt16LE(channels, parsed.format.offset + 2);
    header.writeUInt32LE(parsed.format.sampleRate * bytesPerFrame, parsed.format.offset + 8);
    header.writeUInt16LE(bytesPerFrame, parsed.format.offset + 12);
    header.writeUInt32LE(outputData.length, parsed.data.headerOffset + 4);

    const result = Buffer.concat([header, outputData, trailer]);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
}

function processFilteredCompanion(parsed, settings) {
    const { sampleRate } = parsed.format;
    const first = makeBandPass(sampleRate, settings.formantOneHz, settings.formantOneQ);
    const second = makeBandPass(sampleRate, settings.formantTwoHz, settings.formantTwoQ);
    const delayFrames = Math.round(sampleRate * settings.layerDelayMs / 1000);
    const samples = new Float64Array(parsed.frames);
    for (let frame = 0; frame < parsed.frames; frame++) {
        const dry = sourceSample(parsed, frame);
        const formantLayer = filterSample(first, dry) * settings.formantBlend
            + filterSample(second, dry) * (1 - settings.formantBlend);
        const delayedLayer = sourceSample(parsed, frame - delayFrames);
        const syntheticLayer = formantLayer * 1.8 + delayedLayer * 0.18;
        samples[frame] = dry * settings.primaryGain + syntheticLayer * settings.layerGain;
    }
    return writeProcessedWav(parsed, samples, 1, settings.peakTarget);
}

function processSpatialReflections(parsed, settings) {
    const { sampleRate } = parsed.format;
    const leftDelay = Math.round(sampleRate * settings.leftDelayMs / 1000);
    const rightDelay = Math.round(sampleRate * settings.rightDelayMs / 1000);
    const samples = new Float64Array(parsed.frames * 2);
    let leftReflection = 0;
    let rightReflection = 0;
    for (let frame = 0; frame < parsed.frames; frame++) {
        const dry = sourceSample(parsed, frame);
        const leftDelayed = sourceSample(parsed, frame - leftDelay);
        const rightDelayed = sourceSample(parsed, frame - rightDelay);
        leftReflection += settings.reflectionLowPassAlpha * (leftDelayed - leftReflection);
        rightReflection += settings.reflectionLowPassAlpha * (rightDelayed - rightReflection);
        samples[frame * 2] = dry * settings.directGain + leftReflection * settings.reflectionGain;
        samples[frame * 2 + 1] = dry * settings.directGain + rightReflection * settings.reflectionGain;
    }
    return writeProcessedWav(parsed, samples, 2, settings.peakTarget);
}

function processHybrid(parsed, settings) {
    const { sampleRate } = parsed.format;
    const first = makeBandPass(sampleRate, settings.formantOneHz, settings.formantOneQ);
    const second = makeBandPass(sampleRate, settings.formantTwoHz, settings.formantTwoQ);
    const leftDelay = Math.round(sampleRate * settings.leftDelayMs / 1000);
    const rightDelay = Math.round(sampleRate * settings.rightDelayMs / 1000);
    const samples = new Float64Array(parsed.frames * 2);
    let leftReflection = 0;
    let rightReflection = 0;
    for (let frame = 0; frame < parsed.frames; frame++) {
        const dry = sourceSample(parsed, frame);
        const formantLayer = filterSample(first, dry) * settings.formantBlend
            + filterSample(second, dry) * (1 - settings.formantBlend);
        const leftDelayed = sourceSample(parsed, frame - leftDelay);
        const rightDelayed = sourceSample(parsed, frame - rightDelay);
        leftReflection += settings.reflectionLowPassAlpha * (leftDelayed - leftReflection);
        rightReflection += settings.reflectionLowPassAlpha * (rightDelayed - rightReflection);
        const companion = formantLayer * settings.layerGain;
        samples[frame * 2] = dry * settings.primaryGain + companion + leftReflection * settings.reflectionGain;
        samples[frame * 2 + 1] = dry * settings.primaryGain + companion + rightReflection * settings.reflectionGain;
    }
    return writeProcessedWav(parsed, samples, 2, settings.peakTarget);
}

export function measureVoiceFxDifference(sourceAudio, outputAudio) {
    const source = parsePcmWav(sourceAudio);
    const output = parsePcmWav(outputAudio);
    if (source.frames !== output.frames || source.format.sampleRate !== output.format.sampleRate) {
        throw new TypeError('voice_fx_duration_changed');
    }

    let squareSum = 0;
    let peakDifference = 0;
    let peakFinal = 0;
    let changedSamples = 0;
    let clippedSamples = 0;
    const totalSamples = output.frames * output.format.channels;
    for (let frame = 0; frame < output.frames; frame++) {
        for (let channel = 0; channel < output.format.channels; channel++) {
            const outputValue = output.wav.readInt16LE(output.data.offset + (frame * output.format.channels + channel) * 2);
            let sourceValue;
            if (source.format.channels === 1) sourceValue = sourceSample(source, frame);
            else if (output.format.channels === 1) {
                sourceValue = Math.round((sourceSample(source, frame, 0) + sourceSample(source, frame, 1)) / 2);
            } else sourceValue = sourceSample(source, frame, channel);
            const difference = outputValue - sourceValue;
            squareSum += difference * difference;
            peakDifference = Math.max(peakDifference, Math.abs(difference));
            if (difference !== 0) changedSamples++;
            peakFinal = Math.max(peakFinal, Math.abs(outputValue));
            if (outputValue === 32767 || outputValue === -32768) clippedSamples++;
        }
    }
    return {
        rmsDifference: Math.sqrt(squareSum / totalSamples),
        peakDifference,
        changedSamples,
        totalSamples,
        changedPercent: (changedSamples / totalSamples) * 100,
        peakFinal,
        clippedSamples,
        durationSeconds: output.frames / output.format.sampleRate,
    };
}
