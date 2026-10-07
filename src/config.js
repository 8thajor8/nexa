import path from 'node:path';

export function resolveMemoryBackend(value) {
    if (value === undefined) return 'memory1';
    if (value === 'memory1' || value === 'memory2') return value;
    throw new Error('NEXA_MEMORY_BACKEND must be memory1 or memory2.');
}

export const config = Object.freeze({
    model: 'gpt-6-luna',
    maxToolIterations: 5,
    memoryBackend: resolveMemoryBackend(process.env.NEXA_MEMORY_BACKEND),
    memory2StorePath: path.resolve('data/memory-v2.json'),
});
