import path from 'node:path';
import { createAgent } from './agent.js';
import { createAutomaticMemoryDetector } from '../memory/automatic/detector.js';
import { openExistingMemory2Reader } from '../memory/read-existing.js';
import { config, resolveCliMemoryMode } from '../config.js';

const readOnlyConsentStore = Object.freeze({
    async load() { return null; },
    async grant() { throw new Error('automatic_memory_disabled'); },
    async revoke() { return { success: false }; },
});

const readOnlyProposalQueue = Object.freeze({
    async listGrouped() { return []; },
    async review() { return null; },
    async approve() { return { success: false }; },
    async reject() { return { success: false }; },
    async discard() { return { success: false }; },
    async excludeConversation() { return { success: false }; },
    async revokeConsent() { return { success: false }; },
});

/** Compose the standard CLI agent, or its explicitly selected read-only variant. */
export async function createCliAgent({
    memoryMode = config.cliMemoryMode,
    storePath = config.memory2ReadOnlyStorePath,
    agentOptions = {},
} = {}) {
    memoryMode = resolveCliMemoryMode(memoryMode);
    if (memoryMode === 'memory1') {
        return createAgent({
            automaticMemoryDetector: createAutomaticMemoryDetector(),
            enableAutomaticMemoryAssessment: false,
            ...agentOptions,
        });
    }

    if (memoryMode === 'memory2') {
        return createAgent({ memoryBackend: 'memory2', ...agentOptions });
    }

    if (memoryMode !== 'memory2-readonly') {
        throw new Error('NEXA_MEMORY_BACKEND must be memory1, memory2, or memory2-readonly.');
    }
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) {
        throw new Error('NEXA_MEMORY2_STORE_PATH must be an absolute path to an existing Schema v5 store.');
    }

    const reader = await openExistingMemory2Reader({ storePath });
    try {
        return await createAgent({
            ...agentOptions,
            memory2ReadOnlyReader: reader,
            memoryRetrievalEnabled: true,
            memory2ReadOnlyAllowExternalTools: true,
            enableAutomaticMemoryAssessment: false,
            automaticMemoryConsentStore: readOnlyConsentStore,
            automaticMemoryProposalQueue: readOnlyProposalQueue,
        });
    } catch (error) {
        await reader.close().catch(() => {});
        throw error;
    }
}
