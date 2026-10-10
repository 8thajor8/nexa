import { createRuntimeAgent } from './runtime-agent.js';

/** CLI-facing name for the shared Runtime agent composition. */
export function createCliAgent(options) {
    return createRuntimeAgent(options);
}
