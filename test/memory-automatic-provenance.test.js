import test from 'node:test';
import assert from 'node:assert/strict';
import { getAutomaticMemorySourcePolicy, getAutomaticMemoryToolSource,
    listAutomaticMemorySourcePolicies } from '../src/memory/automatic/source-registry.js';
import { createAutomaticMemoryAssessmentBoundary } from '../src/memory/automatic/assessment-boundary.js';
import { createPersistentAutomaticMemoryConsent } from '../src/memory/automatic/consent-store.js';
import { terminalTests, terminalTurn } from '../test-support/memory-terminal.js';
import { consumeTrustedLocalTurnContext, consumeTrustedLocalTurnExposure,
    finalizeTrustedLocalTurnContext, releaseDirectUserTurn } from '../src/core/direct-user-input.js';

const runTerminalTest = terminalTests(import.meta.url);

test('source registry assigns fixed fail-closed policies and ignores payload metadata claims', () => {
    const lifeguard = getAutomaticMemorySourcePolicy('api:lifeguard', { memoryPolicy: 'candidate_only' });
    assert.deepEqual(lifeguard, { source: 'api:lifeguard', dataType: 'financial_live',
        memoryPolicy: 'never_store', freshness: 'always_fetch' });
    assert.equal(getAutomaticMemorySourcePolicy('email').memoryPolicy, 'never_store');
    assert.equal(getAutomaticMemorySourcePolicy('calendar').freshness, 'always_fetch');
    assert.equal(getAutomaticMemorySourcePolicy('memory').memoryPolicy, 'never_store');
    assert.equal(getAutomaticMemorySourcePolicy('web').memoryPolicy, 'never_store');
    assert.deepEqual(getAutomaticMemorySourcePolicy('api:unregistered'), getAutomaticMemorySourcePolicy('tool:unclassified'));
    assert.equal(getAutomaticMemoryToolSource('search_emails').source, 'email');
    assert.equal(getAutomaticMemoryToolSource('get_calendar_event').source, 'calendar');
    assert.deepEqual(getAutomaticMemoryToolSource('model_invented_tool'), getAutomaticMemorySourcePolicy('tool:unclassified'));
    assert.equal(Object.isFrozen(lifeguard), true);
    assert.ok(listAutomaticMemorySourcePolicies().every(Object.isFrozen));
    assert.equal(getAutomaticMemorySourcePolicy('user:direct').memoryPolicy, 'candidate_only');
});

runTerminalTest('stdin issues independent one-use assessment and exposure proofs through post-response completion', async () => {
    const recipient = {};
    const turn = await terminalTurn(recipient, 'Synthetic independent preference.');
    releaseDirectUserTurn(turn.capability);
    const exposure = consumeTrustedLocalTurnExposure(turn.runtimeExposureCapability, recipient, turn.message);
    const context = consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message);
    assert.equal(exposure.sessionId, context.sessionId);
    assert.equal(exposure.turnId, context.turnId);
    assert.equal(exposure.purpose, 'automatic_memory_exposure_recording');
    assert.equal(context.purpose, 'automatic_memory_assessment');
    assert.equal(finalizeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient), true);
    assert.equal(finalizeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient), false);
    assert.throws(() => consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnExposure(turn.runtimeExposureCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' });
});

runTerminalTest('next stdin turn invalidates both proofs from the preceding turn', async () => {
    const recipient = {};
    const first = await terminalTurn(recipient, 'First synthetic turn.');
    const second = await terminalTurn(recipient, 'Second synthetic turn.');
    assert.throws(() => consumeTrustedLocalTurnExposure(first.runtimeExposureCapability, recipient, first.message),
        { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnContext(first.runtimeContextCapability, recipient, first.message),
        { code: 'memory_write_not_authorized' });
    assert.equal(consumeTrustedLocalTurnContext(second.runtimeContextCapability, recipient, second.message).origin, 'local_cli');
});

runTerminalTest('tampered exposure text consumes its proof without making a source event', async () => {
    const recipient = {};
    const turn = await terminalTurn(recipient, 'Original source-bound text.');
    assert.throws(() => consumeTrustedLocalTurnExposure(turn.runtimeExposureCapability, recipient, 'Changed text.'),
        { code: 'memory_write_not_authorized' });
    assert.throws(() => consumeTrustedLocalTurnExposure(turn.runtimeExposureCapability, recipient, turn.message),
        { code: 'memory_write_not_authorized' });
    assert.equal(consumeTrustedLocalTurnContext(turn.runtimeContextCapability, recipient, turn.message).origin, 'local_cli');
});

runTerminalTest('trusted source metadata marks CRM output never-store and blocks candidate assessment', async () => {
    const recipient = {};
    let detectorCalls = 0;
    const gate = createAutomaticMemoryAssessmentBoundary({ detector: { detect: async () => {
        detectorCalls++;
        return { success: true, proposal: { candidates: [] } };
    } }, consentStore: { load: async () => null }, analysisEnabled: async () => true,
    isConversationExcluded: async () => false });
    const turn = await terminalTurn(recipient, 'Synthetic user query about a business account.');
    const exposure = gate.recordUntrustedContextExposure({ capability: turn.runtimeExposureCapability,
        recipient, text: turn.message, kind: 'tool_result', sourceId: 'api:lifeguard' });
    assert.deepEqual(exposure, { success: true, blockedForSession: true, source: 'api:lifeguard',
        dataType: 'financial_live', memoryPolicy: 'never_store', freshness: 'always_fetch' });
    const result = await gate.assess({ capability: turn.runtimeContextCapability,
        recipient, text: turn.message });
    assert.equal(result.error.code, 'untrusted_context_exposed');
    assert.equal(detectorCalls, 0);
});

runTerminalTest('provider taint persists for the current session while a new empty runtime session is independently eligible', async () => {
    const firstRecipient = {};
    const secondRecipient = {};
    let detectorCalls = 0;
    const consent = createPersistentAutomaticMemoryConsent();
    const makeGate = () => createAutomaticMemoryAssessmentBoundary({ detector: { detect: async () => {
        detectorCalls++;
        return { success: true, proposal: { candidates: [] } };
    } }, consentStore: { load: async () => consent }, analysisEnabled: async () => true,
    isConversationExcluded: async () => false });

    const firstGate = makeGate();
    const exposedTurn = await terminalTurn(firstRecipient, 'Synthetic question with an external result.');
    firstGate.recordUntrustedContextExposure({ capability: exposedTurn.runtimeExposureCapability,
        recipient: firstRecipient, text: exposedTurn.message, kind: 'tool_result', sourceId: 'api:lifeguard' });
    const exposedAssessment = await firstGate.assess({ capability: exposedTurn.runtimeContextCapability,
        recipient: firstRecipient, text: exposedTurn.message });
    assert.equal(exposedAssessment.error.code, 'untrusted_context_exposed');

    const laterTurn = await terminalTurn(firstRecipient, 'A later direct turn in the same tainted session.');
    const sameSessionAssessment = await firstGate.assess({ capability: laterTurn.runtimeContextCapability,
        recipient: firstRecipient, text: laterTurn.message });
    assert.equal(sameSessionAssessment.error.code, 'untrusted_context_exposed');

    const isolatedGate = makeGate();
    const independentTurn = await terminalTurn(secondRecipient, 'A synthetic preference in a fresh runtime session.');
    const independentAssessment = await isolatedGate.assess({ capability: independentTurn.runtimeContextCapability,
        recipient: secondRecipient, text: independentTurn.message });
    assert.equal(independentAssessment.success, true);
    assert.equal(independentAssessment.assessed, true);
    assert.equal(independentAssessment.authorizationGranted, false);
    assert.equal(independentAssessment.writeReady, false);
    assert.equal(independentAssessment.persisted, false);
    assert.equal(detectorCalls, 1);
});
