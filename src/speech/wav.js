// OpenAI may return a seekable WAV with 0xffffffff placeholders in the RIFF
// and data lengths. Media players often tolerate this, but Windows' native
// waveform playback APIs expect the actual lengths for file-based playback.
export function normalizeWavLengths(audio) {
    if (!(Buffer.isBuffer(audio) || audio instanceof Uint8Array)) return audio;
    const wav = Buffer.from(audio);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return wav;

    if (wav.readUInt32LE(4) === 0xffffffff) wav.writeUInt32LE(wav.length - 8, 4);

    // Locate the data chunk instead of assuming every WAV has a 44-byte header.
    let offset = 12;
    while (offset + 8 <= wav.length) {
        const chunkSize = wav.readUInt32LE(offset + 4);
        const chunkData = offset + 8;
        if (wav.toString('ascii', offset, offset + 4) === 'data' && chunkSize === 0xffffffff) {
            wav.writeUInt32LE(wav.length - chunkData, offset + 4);
            break;
        }
        if (chunkSize === 0xffffffff || chunkData + chunkSize > wav.length) break;
        offset = chunkData + chunkSize + (chunkSize % 2);
    }
    return wav;
}
