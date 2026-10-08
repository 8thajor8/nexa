import { createAutomaticMemoryDetector } from './detector.js';
import { evaluateAutomaticMemoryPolicy, snapshotFingerprint } from './policy.js';
import { AUTOMATIC_MEMORY_MAX_INPUT_CHARS, validateAutomaticMemoryCandidates } from './schema.js';
import { screenMemorySecret } from '../secret-screening.js';

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
}

/** Offline evaluation composition. Its accepted inputs contain no writer/service/repository. */
export function createAutomaticMemoryDryRun(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
        || Reflect.ownKeys(options).some(key => key !== 'detector')) throw new TypeError('automatic_memory_dry_run_invalid');
    for (const key of Reflect.ownKeys(options)) {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
            throw new TypeError('automatic_memory_dry_run_invalid');
    }
    const detector = options.detector ?? createAutomaticMemoryDetector();
    if (!detector || typeof detector.detect !== 'function' || Reflect.ownKeys(detector).some(key => key !== 'detect'))
        throw new TypeError('automatic_memory_dry_run_invalid');
    return Object.freeze({
        async evaluate(input) {
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
                || Reflect.ownKeys(input).some(key => !['text', 'snapshot'].includes(key)))
                throw new TypeError('automatic_memory_dry_run_input_invalid');
            for (const key of Reflect.ownKeys(input)) {
                const descriptor = Object.getOwnPropertyDescriptor(input, key);
                if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
                    throw new TypeError('automatic_memory_dry_run_input_invalid');
            }
            if (typeof input.text !== 'string') throw new TypeError('candidate_input_invalid');
            if (input.snapshot && (Reflect.ownKeys(input.snapshot).length !== 3
                || !['snapshot', 'revision', 'digest'].every(key => Object.hasOwn(input.snapshot, key))))
                throw new TypeError('memory_snapshot_invalid');
            const snapshot = input.snapshot ? deepFreeze(structuredClone(input.snapshot)) : null;
            const before = snapshot ? snapshotFingerprint(snapshot) : null;
            const detected = await detector.detect({ text: input.text });
            const displayInput = input.text.length <= AUTOMATIC_MEMORY_MAX_INPUT_CHARS && screenMemorySecret(input.text).safe
                ? input.text : null;
            if (!detected.success) {
                const after = snapshot ? snapshotFingerprint(snapshot) : null;
                if (before !== after) throw new Error('automatic_memory_dry_run_mutated_snapshot');
                return { success: true, input: displayInput,
                    inputRedacted: displayInput === null, runtime: null,
                    candidates: [], rejected: detected.error.code, normalization: detected.normalization ?? [],
                    snapshotBeforeSha256: before, snapshotAfterSha256: after };
            }
            const validated = validateAutomaticMemoryCandidates(detected.proposal, input.text);
            if (!validated.success) return { success: true, input: displayInput,
                inputRedacted: displayInput === null, runtime: null,
                candidates: [], rejected: validated.error.code, normalization: detected.normalization ?? [],
                snapshotBeforeSha256: before, snapshotAfterSha256: before };
            const decision = evaluateAutomaticMemoryPolicy(validated.candidates, { snapshot });
            const after = snapshot ? snapshotFingerprint(snapshot) : null;
            if (before !== after) throw new Error('automatic_memory_dry_run_mutated_snapshot');
            return { success: true, input: displayInput,
                inputRedacted: displayInput === null, runtime: validated.runtime,
                candidates: decision.candidates, normalization: detected.normalization ?? [],
                snapshotBeforeSha256: before, snapshotAfterSha256: after };
        },
    });
}

/** Runs a supplied synthetic corpus in memory only; no result is written to disk. */
export async function evaluateAutomaticMemoryCorpus(cases, { dryRun = createAutomaticMemoryDryRun() } = {}) {
    if (!Array.isArray(cases) || cases.length > 200 || !dryRun || typeof dryRun.evaluate !== 'function')
        throw new TypeError('automatic_memory_corpus_invalid');
    const results = [];
    for (const item of cases) {
        if (!item || typeof item.name !== 'string' || typeof item.text !== 'string'
            || Reflect.ownKeys(item).some(key => !['name', 'text', 'snapshot'].includes(key)))
            throw new TypeError('automatic_memory_corpus_invalid');
        const output = await dryRun.evaluate({ text: item.text, ...(item.snapshot ? { snapshot: item.snapshot } : {}) });
        results.push({ name: item.name, input: output.input, inputRedacted: output.inputRedacted,
            rejected: output.rejected ?? null, candidates: output.candidates,
            normalization: output.normalization ?? [],
            snapshotBeforeSha256: output.snapshotBeforeSha256, snapshotAfterSha256: output.snapshotAfterSha256 });
    }
    return results;
}
