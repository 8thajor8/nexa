import path from 'node:path';

export function resolveMemoryBackend(value) {
    if (value === undefined) return 'memory1';
    if (value === 'memory1' || value === 'memory2') return value;
    throw new Error('NEXA_MEMORY_BACKEND must be memory1 or memory2.');
}

export function resolveCliMemoryMode(value) {
    if (value === undefined) return 'memory1';
    if (value === 'memory1' || value === 'memory2' || value === 'memory2-readonly') return value;
    throw new Error('NEXA_MEMORY_BACKEND must be memory1, memory2, or memory2-readonly.');
}

const configuredCliMode = process.env.NEXA_MEMORY_BACKEND;

export const config = Object.freeze({
    model: 'gpt-6-luna',
    maxToolIterations: 5,
    // The read-only CLI mode composes its reader explicitly; never pass this
    // mode through the writable backend initializer.
    memoryBackend: configuredCliMode === 'memory2' ? 'memory2' : 'memory1',
    // Keep raw until CLI composition, inside its startup error boundary.
    cliMemoryMode: configuredCliMode,
    memory2StorePath: path.resolve('data/memory-v2.json'),
    memory2ReadOnlyStorePath: process.env.NEXA_MEMORY2_STORE_PATH,
});
