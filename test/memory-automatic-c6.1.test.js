import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simulateSelectiveMemoryAssessment } from '../src/memory/automatic/selective-simulation.js';

function candidate(evidence, overrides = {}) {
    return {
        candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference',
        value_text: evidence, mentioned_person_text: null, durability: 'durable',
        linguistic_confidence: 0.95, assertion_mode: 'asserted',
        temporal_hints: { raw_text: null, certainty: 'none' }, update_intent: 'new_fact',
        sensitivity: 'none', suggested_disposition: 'auto_save', evidence_quote: evidence,
        ...overrides,
    };
}

function input(text, proposal, overrides = {}) {
    return {
        text, proposal, sourceId: 'user:direct',
        consentScenario: { state: 'granted', messageOptOut: false },
        conversationOptOut: false, identityStatus: 'unverified', ...overrides,
    };
}

function assess(text, proposals, overrides) {
    return simulateSelectiveMemoryAssessment(input(text, { candidates: proposals }, overrides));
}

test('stable first-person preference remains ASK without authenticated identity or Self', () => {
    const text = 'Prefiero respuestas breves.';
    const result = assess(text, [candidate(text)]);
    assert.equal(result.candidates[0].classification, 'ask');
    assert.equal(result.candidates[0].operation, 'ASK');
    assert.ok(result.candidates[0].reasonCodes.includes('subject_not_canonically_resolved'));
    assert.equal(result.authorization.executable, false);
    assert.equal(result.persistence.performed, false);
});

test('stable textual project decision can be classified as a future candidate but planner still requires review', () => {
    const text = 'Decidí pausar el proyecto Atlas hasta que terminen las pruebas.';
    const item = candidate(text, { candidate_type: 'decision', subject_text: 'proyecto Atlas',
        predicate: 'project.decision', value_text: 'pausar el proyecto Atlas hasta que terminen las pruebas',
        durability: 'temporary', temporal_hints: { raw_text: 'hasta que terminen las pruebas', certainty: 'explicit' } });
    const result = assess(text, [item]);
    assert.equal(result.candidates[0].classification, 'auto_save_candidate');
    assert.equal(result.candidates[0].operation, 'ASK');
    assert.ok(result.candidates[0].reasonCodes.includes('canonical_project_identity_unavailable'));
    assert.equal(result.candidates[0].writeReady, false);
});

test('ephemeral messages are screened before the synthetic proposal is evaluated', () => {
    const text = 'Prefiero esto solo por hoy.';
    const result = assess(text, [candidate(text)]);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.provenance.reason, 'excluded_temporary_or_ephemeral');
});

test('synthetic credentials are rejected without echoing the secret material', () => {
    const text = 'Mi clave de acceso: SynthSecretValue934';
    const result = assess(text, []);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.provenance.reason, 'excluded_credential');
    assert.doesNotMatch(JSON.stringify(result), /SynthSecretValue934/u);
});

test('sensitive health information requires review and never becomes write-ready', () => {
    const text = 'Tengo migrañas.';
    const result = assess(text, [candidate(text, { candidate_type: 'situation', predicate: 'user.situation',
        value_text: 'migrañas', sensitivity: 'health' })]);
    assert.equal(result.candidates[0].classification, 'ask');
    assert.equal(result.candidates[0].operation, 'ASK');
    assert.ok(result.candidates[0].reasonCodes.includes('sensitive_or_unknown_category'));
});

test('multiple facts are returned independently and no candidate enables persistence', () => {
    const first = 'Prefiero respuestas breves.';
    const second = 'Me gusta cocinar.';
    const result = assess(`${first} ${second}`, [candidate(first), candidate(second, {
        candidate_type: 'hobby', predicate: 'user.hobby', value_text: 'cocinar',
    })]);
    assert.equal(result.candidates.length, 2);
    for (const item of result.candidates) {
        assert.equal(item.operation, 'ASK');
        assert.equal(item.writeReady, false);
    }
    assert.equal(result.persistence.requested, false);
    assert.equal(result.persistence.performed, false);
});

test('mixed low-risk and sensitive candidates keep separate policy reasons and neither writes', () => {
    const first = 'Prefiero respuestas breves.';
    const second = 'Tengo migrañas.';
    const result = assess(`${first} ${second}`, [candidate(first), candidate(second, {
        candidate_type: 'situation', predicate: 'user.situation', value_text: 'migrañas', sensitivity: 'health',
    })]);
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates[0].reasonCodes.includes('subject_not_canonically_resolved'));
    assert.ok(result.candidates[1].reasonCodes.includes('sensitive_or_unknown_category'));
    assert.ok(result.candidates.every(item => item.operation === 'ASK' && item.writeReady === false));
    assert.equal(result.persistence.performed, false);
});

test('contradictory same-turn candidates are conservatively downgraded to ASK', () => {
    const first = 'Prefiero café.';
    const second = 'Prefiero té.';
    const result = assess(`${first} ${second}`, [candidate(first), candidate(second)]);
    assert.equal(result.candidates.length, 2);
    for (const item of result.candidates) {
        assert.equal(item.classification, 'ask');
        assert.equal(item.operation, 'ASK');
        assert.ok(item.reasonCodes.includes('same_turn_predicate_conflict_requires_review'));
    }
});

test('missing or revoked consent and both opt-outs stop assessment', () => {
    const text = 'Prefiero respuestas breves.';
    for (const scenario of [
        { consentScenario: { state: 'missing', messageOptOut: false } },
        { consentScenario: { state: 'revoked', messageOptOut: false } },
        { consentScenario: { state: 'granted', messageOptOut: true } },
        { conversationOptOut: true },
    ]) {
        const result = assess(text, [candidate(text)], scenario);
        assert.deepEqual(result.candidates, []);
        assert.equal(result.persistence.performed, false);
    }
    const explicitMessageOptOut = 'No aprendas de este mensaje.';
    assert.equal(assess(explicitMessageOptOut, []).provenance.reason, 'excluded_user_requested_message_exclusion');
});

test('tool, email, CRM, web, file, imported, assistant and retrieved-memory sources are blocked', () => {
    const text = 'Prefiero respuestas breves.';
    for (const sourceId of ['tool:unclassified', 'email', 'api:lifeguard', 'web', 'memory', 'file:import', 'assistant']) {
        const result = assess(text, [candidate(text)], { sourceId });
        assert.equal(result.provenance.reason, 'source_policy_never_store', sourceId);
        assert.deepEqual(result.candidates, []);
    }
});

test('third-party facts and attempted sharing never become automatic candidates', () => {
    const text = 'Coti trabaja como diseñadora.';
    const item = candidate(text, { candidate_type: 'professional', subject_text: 'Coti',
        mentioned_person_text: 'Coti', predicate: 'user.professional_context', value_text: 'diseñadora' });
    const result = assess(text, [item]);
    assert.equal(result.candidates[0].classification, 'ask');
    assert.equal(result.candidates[0].operation, 'ASK');
    assert.ok(result.candidates[0].reasonCodes.includes('person_resolution_unavailable'));
    assert.equal(result.provenance.status, 'untrusted_synthetic_input');
});

test('model-supplied sharing, IDs, identity claims or executable flags cannot enter the simulator contract', () => {
    const text = 'Prefiero respuestas breves.';
    const forged = candidate(text, { subject_text: 'person_00000000-0000-4000-8000-000000000001' });
    assert.equal(assess(text, [forged]).candidates[0].classification, 'ask');
    assert.equal(simulateSelectiveMemoryAssessment(input(text, { candidates: [candidate(text)] }, {
        identityStatus: 'verified',
    })).provenance.reason, 'simulation_input_invalid');
    assert.equal(simulateSelectiveMemoryAssessment({ ...input(text, { candidates: [candidate(text)] }), executable: true })
        .provenance.reason, 'simulation_input_invalid');
});

test('simulation module has no detector, API client, writer, service or repository dependency', async () => {
    const source = await readFile(new URL('../src/memory/automatic/selective-simulation.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from\s+['"].*(?:detector|openai|repository|service|authorization-coordinator|trusted-speaker-identity)/u);
});

test('all results are non-executable and never report a write', () => {
    const text = 'Estoy aprendiendo TypeScript.';
    const result = assess(text, [candidate(text, { candidate_type: 'learning_activity',
        predicate: 'user.learning_activity', value_text: 'TypeScript' })]);
    assert.equal(result.authorization.granted, false);
    assert.equal(result.authorization.executable, false);
    assert.equal(result.persistence.requested, false);
    assert.equal(result.persistence.performed, false);
    assert.equal(result.candidates[0].operation, 'ASK');
});
