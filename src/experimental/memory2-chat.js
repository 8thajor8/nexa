import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgent } from '../core/agent.js';
import { openExistingMemory2Reader } from '../memory/read-existing.js';

const isolatedConsentStore = Object.freeze({
    async load() { return null; },
    async grant() { throw new Error('automatic_memory_disabled'); },
    async revoke() { return { success: false }; },
});

const isolatedProposalQueue = Object.freeze({
    async listGrouped() { return []; },
    async review() { return null; },
    async approve() { return { success: false }; },
    async reject() { return { success: false }; },
    async discard() { return { success: false }; },
    async excludeConversation() { return { success: false }; },
    async revokeConsent() { return { success: false }; },
});

/**
 * Run an isolated terminal chat over an existing Memory 2 Schema v5 store.
 * The reader and agent are always closed when input ends or a turn fails.
 * `ask` is exposed for deterministic local tests; production uses the normal API.
 */
export async function runMemory2ReadOnlyChat({ storePath, input = stdin, output = stdout, ask, getTools, logger } = {}) {
    if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) {
        throw new Error('Provide an absolute path to an existing Memory 2 Schema v5 store.');
    }

    const reader = await openExistingMemory2Reader({ storePath });
    let agent, terminal;
    try {
        terminal = createInterface({ input, crlfDelay: Infinity });
        agent = await createAgent({
            memory2ReadOnlyReader: reader,
            memoryRetrievalEnabled: true,
            enableAutomaticMemoryAssessment: false,
            automaticMemoryConsentStore: isolatedConsentStore,
            automaticMemoryProposalQueue: isolatedProposalQueue,
            ...(ask ? { ask } : {}),
            ...(getTools ? { getTools } : {}),
            ...(logger ? { logger } : {}),
        });

        for await (const line of terminal) {
            if (line.trim().toLocaleLowerCase('es') === 'salir') break;
            if (!line.trim()) continue;
            try {
                const response = await agent.run(line);
                output.write(`Nexa > ${response ?? ''}\n\n`);
            } catch (error) {
                output.write(`Nexa ERROR > ${error.message}\n\n`);
            }
        }
    } finally {
        terminal?.close();
        if (agent) await agent.close();
        else await reader.close();
    }
}

function usageError() {
    return new Error('Usage: node src/experimental/memory2-chat.js <absolute-path-to-existing-memory-v2.json>');
}

async function main(argv) {
    if (argv.length !== 3 || !path.isAbsolute(argv[2])) throw usageError();
    await runMemory2ReadOnlyChat({ storePath: argv[2] });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    try { await main(process.argv); }
    catch (error) {
        console.error(`Nexa Memory2 read-only ERROR > ${error.message}`);
        process.exitCode = 1;
    }
}
