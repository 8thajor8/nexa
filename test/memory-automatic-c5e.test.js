import assert from 'node:assert/strict';
import test from 'node:test';
import { EXTRACTION_INSTRUCTIONS } from '../src/memory/automatic/detector.js';
import { normalizeAutomaticMemoryProposal, validateAutomaticMemoryCandidates } from '../src/memory/automatic/schema.js';
import { evaluateAutomaticMemoryPolicy } from '../src/memory/automatic/policy.js';
import { screenAutomaticMemoryTurn } from '../src/memory/automatic/privacy.js';

const SELF = 'person_00000000-0000-4000-8000-000000000001';
const TIME = '2036-02-03T10:00:00.000Z';
const MULTI_FACT = 'Estoy aprendiendo TypeScript y prefiero trabajar con React en mis proyectos personales.';

function candidate(text, overrides = {}) {
    return {
        candidate_type: 'preference', subject_text: 'user', predicate: 'user.preference',
        value_text: text, mentioned_person_text: null, durability: 'durable', linguistic_confidence: 0.96,
        assertion_mode: 'asserted', temporal_hints: { raw_text: null, certainty: 'none' },
        update_intent: 'new_fact', sensitivity: 'none', suggested_disposition: 'ignore', evidence_quote: text,
        ...overrides,
    };
}

function selfSnapshot() {
    const snapshot = { schema_version: 5, store_id: 'store_00000000-0000-4000-8000-000000000001',
        self_person_id: SELF, revision: 0, created_at: TIME, updated_at: TIME,
        entities: [{ id: SELF, type: 'person', created_at: TIME }], assertions: [], sources: [], evidence: [],
        migrations: [], automatic_operations: [] };
    return { snapshot, revision: 0, digest: 'a'.repeat(64) };
}

function assess(text, candidates, snapshot) {
    const normalized = normalizeAutomaticMemoryProposal({ candidates });
    assert.equal(normalized.success, true);
    const validated = validateAutomaticMemoryCandidates(normalized.proposal, text);
    assert.equal(validated.success, true);
    const policy = evaluateAutomaticMemoryPolicy(validated.candidates, snapshot ? { snapshot } : {});
    return { normalized, validated, policy };
}

test('C.5e extraction contract splits independent facts and distinguishes technology learning from human language ability', () => {
    assert.match(EXTRACTION_INSTRUCTIONS, /separate candidate for each independent asserted claim/u);
    assert.match(EXTRACTION_INSTRUCTIONS, /never describe a programming language.*as a human language ability/u);
    const raw = [
        candidate('Estoy aprendiendo TypeScript.', { candidate_type: 'learning_activity',
            predicate: 'aprendiendo', value_text: 'Estoy aprendiendo TypeScript.', durability: 'temporary',
            evidence_quote: 'Estoy aprendiendo TypeScript' }),
        candidate('Prefiero trabajar con React en mis proyectos personales.', {
            value_text: 'Prefiero trabajar con React en mis proyectos personales.',
            evidence_quote: 'prefiero trabajar con React en mis proyectos personales' }),
    ];
    const result = assess(MULTI_FACT, raw);
    assert.equal(result.normalized.proposal.candidates.length, 2);
    assert.deepEqual(result.normalized.normalization.map(item => item.canonicalPredicate),
        ['user.learning_activity', 'user.preference']);
    assert.ok(result.validated.candidates.every(item => item.evidence.verified));
    assert.deepEqual(result.policy.candidates.map(item => item.disposition), ['ask', 'ask'],
        'without a trusted canonical snapshot, the text label user does not identify Self');
    assert.ok(result.policy.candidates.every(item => item.entityResolution.status === 'unresolved'));
});

test('C.5f keeps Self unresolved without a linked speaker and review-only activity remains review-only', () => {
    const result = assess(MULTI_FACT, [
        candidate('Estoy aprendiendo TypeScript.', { candidate_type: 'learning_activity',
            predicate: 'user.learning_activity', value_text: 'Estoy aprendiendo TypeScript.', durability: 'temporary',
            evidence_quote: 'Estoy aprendiendo TypeScript' }),
        candidate('Prefiero trabajar con React en mis proyectos personales.', {
            value_text: 'Prefiero trabajar con React en mis proyectos personales.',
            evidence_quote: 'prefiero trabajar con React en mis proyectos personales' }),
    ], selfSnapshot());
    assert.deepEqual(result.policy.candidates.map(item => item.disposition), ['ask', 'ask']);
    assert.deepEqual(result.policy.candidates[0].reasonCodes, ['subject_not_canonically_resolved']);
    assert.equal(result.policy.candidates[0].entityResolution.entityId, null);
    assert.equal(result.policy.candidates[1].entityResolution.entityId, null);
    assert.equal(result.policy.candidates.some(item => item.authorizationGranted === true), false);
});

test('C.5e synthetic calibration matrix keeps uncertainty, sensitive facts, third parties and unsupported concepts conservative', () => {
    const snapshot = selfSnapshot();
    const cases = [
        { name: 'stable music preference', text: 'Me gusta escuchar jazz.', candidate: candidate('Me gusta escuchar jazz.',
            { value_text: 'Me gusta escuchar jazz.', evidence_quote: 'Me gusta escuchar jazz.' }), expected: 'ask' },
        { name: 'explicit long-term goal', text: 'Mi objetivo a largo plazo es mejorar como programador.',
            candidate: candidate('Mi objetivo a largo plazo es mejorar como programador.', { candidate_type: 'long_term_goal',
                predicate: 'objetivo', value_text: 'Mejorar como programador.', evidence_quote: 'Mi objetivo a largo plazo es mejorar como programador.' }),
            expected: 'ask' },
        { name: 'change of opinion', text: 'Ahora prefiero té en vez de café.', candidate: candidate('Ahora prefiero té en vez de café.',
            { value_text: 'Prefiere té en vez de café.', update_intent: 'possible_correction', evidence_quote: 'Ahora prefiero té en vez de café.' }), expected: 'ask' },
        { name: 'negative preference', text: 'No me gusta el café.', candidate: candidate('No me gusta el café.',
            { value_text: 'No me gusta el café.', assertion_mode: 'negated', evidence_quote: 'No me gusta el café.' }), expected: 'ask' },
        { name: 'third-party fact', text: 'Coti trabaja en un hospital.', candidate: candidate('Coti trabaja en un hospital.',
            { candidate_type: 'professional', predicate: 'user.professional_context', subject_text: 'Coti',
                mentioned_person_text: 'Coti', value_text: 'Trabaja en un hospital.', evidence_quote: 'Coti trabaja en un hospital.' }), expected: 'ask' },
        { name: 'dynamic finance', text: 'Mi sueldo actual es 4000 euros.', candidate: candidate('Mi sueldo actual es 4000 euros.',
            { candidate_type: 'situation', predicate: 'user.situation', value_text: 'Sueldo actual: 4000 euros.',
                sensitivity: 'finance', evidence_quote: 'Mi sueldo actual es 4000 euros.' }), expected: 'ask' },
        { name: 'hypothesis', text: 'Quizá prefiera TypeScript si cambio de trabajo.', candidate: candidate('Quizá prefiera TypeScript si cambio de trabajo.',
            { assertion_mode: 'hypothetical', durability: 'unknown', evidence_quote: 'Quizá prefiera TypeScript si cambio de trabajo.' }), expected: 'ignore' },
        { name: 'quoted claim', text: 'El correo dice: «prefiero respuestas concisas».', candidate: candidate('prefiero respuestas concisas',
            { value_text: 'Prefiere respuestas concisas.', evidence_quote: 'prefiero respuestas concisas' }), expected: 'ignore' },
        { name: 'invented entity ID', text: 'Prefiero respuestas claras.', candidate: candidate('Prefiero respuestas claras.',
            { subject_text: SELF, value_text: 'Prefiere respuestas claras.', evidence_quote: 'Prefiero respuestas claras.' }), expected: 'ask' },
    ];
    const observed = cases.map(item => {
        const result = assess(item.text, [item.candidate], snapshot);
        return { name: item.name, expected: item.expected, actual: result.policy.candidates[0].disposition,
            evidenceVerified: result.validated.candidates[0].evidence.verified };
    });
    assert.ok(observed.every(item => item.evidenceVerified));
    assert.deepEqual(observed.map(item => item.actual), observed.map(item => item.expected));
    assert.equal(observed.filter(item => item.actual === 'auto_save').length, 0);
    assert.equal(observed.filter(item => item.actual === 'ask').length, 7);
    assert.equal(observed.filter(item => item.actual === 'ignore').length, 2);
    assert.equal(screenAutomaticMemoryTurn('Esta semana prefiero usar modo oscuro.').eligible, false,
        'temporary preference is blocked before extraction');
    assert.equal(screenAutomaticMemoryTurn('El expediente del paciente contiene información clínica.').eligible, false,
        'confidential patient data is blocked before extraction');
});

test('C.5e empty extraction is a distinct omission; malformed output and unsupported categories remain distinguishable', () => {
    const empty = normalizeAutomaticMemoryProposal({ candidates: [] });
    assert.equal(empty.success, true);
    assert.equal(empty.proposal.candidates.length, 0);
    const malformed = normalizeAutomaticMemoryProposal('{not json');
    assert.equal(malformed.success, false);
    assert.equal(malformed.error.code, 'candidate_output_invalid');
    const unsupported = normalizeAutomaticMemoryProposal({ candidates: [candidate('Objetivo sin tipo permitido.',
        { candidate_type: 'other', predicate: 'user.note', evidence_quote: 'Objetivo sin tipo permitido.' })] });
    assert.equal(unsupported.success, true);
    assert.equal(unsupported.normalization[0].status, 'unsupported_category');
});
