import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulateSelectiveMemoryAssessment } from '../src/memory/automatic/selective-simulation.js';

function proposal(evidence, overrides = {}) {
    return { candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference',
        value_text: evidence, mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.95,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact',
        sensitivity: 'none', suggested_disposition: 'auto_save', evidence_quote: evidence, ...overrides };
}
function run(text, candidates, overrides = {}) {
    return simulateSelectiveMemoryAssessment({ text, proposal: { candidates }, sourceId: 'user:direct',
        consentScenario: { state: 'granted', messageOptOut: false }, conversationOptOut: false,
        identityStatus: 'unverified', ...overrides });
}
function assertNoWrites(result) {
    assert.equal(result.simulationOnly, true);
    assert.equal(result.authorization.granted, false);
    assert.equal(result.authorization.executable, false);
    assert.equal(result.persistence.requested, false);
    assert.equal(result.persistence.performed, false);
    for (const item of result.candidates) {
        assert.equal(item.writeReady, false);
        assert.equal(item.authorizationGate.executable, false);
        assert.equal(item.finalDecision, item.authorizationGate.decision);
        assert.ok(!['ADD', 'REPLACE'].includes(item.operation));
    }
}

test('C.6 trace keeps policy, planner, gate and final decision separate without returning source text', () => {
    const text = 'Decidí pausar el proyecto Atlas hasta que terminen las pruebas.';
    const item = proposal(text, { candidate_type: 'decision', subject_text: 'proyecto Atlas',
        predicate: 'project.decision', value_text: 'pausar el proyecto Atlas hasta que terminen las pruebas',
        durability: 'temporary', temporal_hints: { raw_text: 'hasta que terminen las pruebas', certainty: 'explicit' } });
    const result = run(text, [item]);
    const view = result.candidates[0];
    assert.equal(view.policyDisposition, 'auto_save');
    assert.equal(view.policyClassification, 'auto_save_candidate');
    assert.equal(view.plannerOperation, 'ASK');
    assert.ok(view.plannerReasonCodes.includes('canonical_project_identity_unavailable'));
    assert.equal(view.operation, 'ASK');
    assert.equal(view.authorizationGate.decision, 'ASK');
    assert.equal(view.authorizationGate.reasonCodes[0], 'candidate_requires_review');
    assertNoWrites(result);
    assert.doesNotMatch(JSON.stringify(result), /Atlas|pausar|pruebas/u);
});

test('C.6 end-to-end cases distinguish transient, sensitive, third-party and externally sourced information', () => {
    const ephemeral = run('Prefiero esto solo por hoy.', [proposal('Prefiero esto solo por hoy.')]);
    assert.equal(ephemeral.candidates.length, 0);
    assert.equal(ephemeral.provenance.reason, 'excluded_temporary_or_ephemeral');

    const healthText = 'Tengo migrañas.';
    const health = run(healthText, [proposal(healthText, { candidate_type: 'situation', predicate: 'user.situation',
        value_text: 'migrañas', sensitivity: 'health', suggested_disposition: 'ask' })]);
    assert.equal(health.candidates[0].policyDisposition, 'ask');
    assert.equal(health.candidates[0].plannerOperation, 'ASK');
    assert.equal(health.candidates[0].authorizationGate.decision, 'DENY');
    assert.equal(health.candidates[0].authorizationGate.reasonCodes[0], 'sensitive_candidate_never_autosaved');
    assert.doesNotMatch(JSON.stringify(health), /migrañas/u);
    assertNoWrites(health);

    const thirdPartyText = 'Coti trabaja como diseñadora.';
    const thirdParty = run(thirdPartyText, [proposal(thirdPartyText, { candidate_type: 'professional',
        subject_text: 'Coti', mentioned_person_text: 'Coti', predicate: 'user.professional_context', value_text: 'diseñadora' })]);
    assert.equal(thirdParty.candidates[0].policyDisposition, 'ask');
    assert.equal(thirdParty.candidates[0].authorizationGate.decision, 'ASK');
    assertNoWrites(thirdParty);

    const external = run('Prefiero respuestas breves.', [proposal('Prefiero respuestas breves.')], { sourceId: 'api:lifeguard' });
    assert.deepEqual(external.candidates, []);
    assert.equal(external.provenance.reason, 'source_policy_never_store');
    assertNoWrites(external);
});

test('C.6 opt-outs and missing or revoked analysis consent stop before policy, planner and gate', () => {
    const text = 'Prefiero respuestas breves.';
    for (const overrides of [
        { conversationOptOut: true },
        { consentScenario: { state: 'granted', messageOptOut: true } },
        { consentScenario: { state: 'missing', messageOptOut: false } },
        { consentScenario: { state: 'revoked', messageOptOut: false } },
    ]) {
        const result = run(text, [proposal(text)], overrides);
        assert.deepEqual(result.candidates, []);
        assert.equal(result.authorization.executable, false);
        assert.equal(result.persistence.performed, false);
    }
});

test('C.6 unverified identity and contradictory candidates remain review-only', () => {
    const preference = 'Prefiero respuestas breves.';
    const unresolved = run(preference, [proposal(preference)]);
    assert.equal(unresolved.candidates[0].policyDisposition, 'ask');
    assert.ok(unresolved.candidates[0].policyReasonCodes.includes('subject_not_canonically_resolved'));
    assert.equal(unresolved.candidates[0].authorizationGate.decision, 'ASK');
    assertNoWrites(unresolved);

    const contradiction = run('Prefiero café. Prefiero té.', [
        proposal('Prefiero café.', { value_text: 'café' }),
        proposal('Prefiero té.', { value_text: 'té' }),
    ]);
    assert.equal(contradiction.candidates.length, 2);
    for (const item of contradiction.candidates) {
        assert.ok(item.reasonCodes.includes('same_turn_predicate_conflict_requires_review'));
        assert.equal(item.operation, 'ASK');
        assert.equal(item.finalDecision, 'ASK');
    }
    assertNoWrites(contradiction);
});

test('C.6 multiple candidates preserve independent policy and gate outcomes and never echo a synthetic secret', () => {
    const preference = 'Prefiero respuestas breves.';
    const healthText = 'Tengo migrañas.';
    const mixed = run(`${preference} ${healthText}`, [
        proposal(preference),
        proposal(healthText, { candidate_type: 'situation', predicate: 'user.situation', value_text: 'migrañas',
            sensitivity: 'health', suggested_disposition: 'ask' }),
    ]);
    assert.equal(mixed.candidates.length, 2);
    assert.notEqual(mixed.candidates[0].authorizationGate.decision, mixed.candidates[1].authorizationGate.decision);
    assert.equal(mixed.candidates[0].authorizationGate.decision, 'ASK');
    assert.equal(mixed.candidates[1].authorizationGate.decision, 'DENY');
    assertNoWrites(mixed);

    const secretText = 'Mi clave sintética es SecretFixtureDoNotEcho991';
    const secret = run(secretText, []);
    assert.equal(secret.candidates.length, 0);
    assert.doesNotMatch(JSON.stringify(secret), /SecretFixtureDoNotEcho991/u);
    assert.equal(secret.persistence.performed, false);
});

test('C.6 rejects execution-shaped simulator input and has no model, logging or persistence dependency', async () => {
    const text = 'Prefiero respuestas breves.';
    const candidateValue = proposal(text);
    const invalid = simulateSelectiveMemoryAssessment({ text, proposal: { candidates: [candidateValue] },
        sourceId: 'user:direct', consentScenario: { state: 'granted', messageOptOut: false },
        conversationOptOut: false, identityStatus: 'unverified', executionRequested: true });
    assert.equal(invalid.provenance.reason, 'simulation_input_invalid');
    assert.equal(invalid.authorization.executable, false);
    assert.equal(invalid.persistence.performed, false);

    const source = await readFile(new URL('../src/memory/automatic/selective-simulation.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"].*(?:detector|openai|repository|service|authorization-coordinator|trusted-speaker-identity)/u);
    assert.doesNotMatch(source, /console\.(?:log|error)\s*\(|\b(?:writeFile|appendFile)\s*\(/u);
});
