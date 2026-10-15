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

/** Compose one independent agent with the configured Runtime memory mode. */
export async function createRuntimeAgent({
    memoryMode = config.cliMemoryMode,
    storePath = config.memory2ReadOnlyStorePath,
    agentOptions = {},
    initialConversationHistory = [],
    allowConfirmedMemoryWrites = agentOptions?.allowConfirmedMemoryWrites === true,
} = {}) {
    const confirmedWriteMode = memoryMode === 'memory2-confirmed-write';
    if (confirmedWriteMode && allowConfirmedMemoryWrites !== true) {
        throw new Error('confirmed_memory_writes_require_explicit_host_composition');
    }
    if (!confirmedWriteMode) memoryMode = resolveCliMemoryMode(memoryMode);
    if (memoryMode === 'memory1') {
        return createAgent({
            automaticMemoryDetector: createAutomaticMemoryDetector(),
            enableAutomaticMemoryAssessment: false,
            ...agentOptions,
            initialConversationHistory,
        });
    }

    if (memoryMode === 'memory2') {
        return createAgent({ memoryBackend: 'memory2', memory2StorePath: storePath, ...agentOptions, initialConversationHistory });
    }

    if (memoryMode === 'memory2-confirmed-write') {
        if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) {
            throw new Error('A dedicated absolute synthetic Memory 2 store is required for confirmed writes.');
        }
        const { allowConfirmedMemoryWrites: _hostGate, ...safeAgentOptions } = agentOptions;
        return createAgent({ ...safeAgentOptions, memoryBackend: 'memory2', memory2StorePath: storePath,
            ...(agentOptions.memory2Repository ? { memory2Repository: agentOptions.memory2Repository } : {}), initialConversationHistory,
            enableConfirmedMemoryWrites: true, enableAutomaticMemoryAssessment: false });
    }

    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) {
        throw new Error('NEXA_MEMORY2_STORE_PATH must be an absolute path to an existing Schema v5 store.');
    }

    const reader = await openExistingMemory2Reader({ storePath });
    try {
        return await createAgent({
            ...agentOptions,
            initialConversationHistory,
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
