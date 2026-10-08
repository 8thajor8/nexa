import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { formatAutomaticMemoryAssessment } from '../src/memory/automatic/assessment-presentation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('C.5c presents only ephemeral reviewable candidates and redacts sensitive or secret-like values', () => {
    const lines = formatAutomaticMemoryAssessment({ success: true, assessed: true, candidates: [
        { disposition: 'ask', proposal: { candidate_type: 'preference', value_text: 'respuestas concisas', sensitivity: 'none' }, reasonCodes: ['subject_unresolved'] },
        { disposition: 'ask', proposal: { candidate_type: 'health', value_text: 'private health value', sensitivity: 'sensitive' }, reasonCodes: ['sensitive_requires_confirmation'] },
        { disposition: 'auto_save', proposal: { candidate_type: 'fact', value_text: 'password=x', sensitivity: 'none' }, reasonCodes: [] },
        { disposition: 'ignore', proposal: { candidate_type: 'fact', value_text: 'must not display', sensitivity: 'none' }, reasonCodes: [] },
        { disposition: 'duplicate', proposal: { candidate_type: 'fact', value_text: 'must not display', sensitivity: 'none' }, reasonCodes: [] },
    ] });

    assert.equal(lines.length, 4);
    assert.match(lines[0], /no se guardó ningún recuerdo/u);
    assert.match(lines[1], /respuestas concisas/u);
    assert.match(lines[2], /contenido omitido por seguridad/u);
    assert.match(lines[3], /contenido omitido por seguridad/u);
    assert.doesNotMatch(lines.join('\n'), /private health value|password=x|must not display/u);
});

test('C.5c CLI formats results only after the answer and completion phase, without persistence dependencies', async () => {
    const cli = await readFile(path.join(root, 'src/index.js'), 'utf8');
    const answer = cli.indexOf('console.log(`Nexa > ${response}`)');
    const complete = cli.indexOf('const assessment = await nexa.completePresentedTurn()');
    const present = cli.indexOf('formatAutomaticMemoryAssessment(assessment)');
    assert.ok(answer >= 0 && complete > answer && present > complete);
    assert.match(cli, /enableAutomaticMemoryAssessment:\s*false/u);
    assert.doesNotMatch(cli, /proposalQueue\.enqueue|\.save\(/u);
});

test('C.5c presents nothing for unassessed or failed extraction results', () => {
    assert.deepEqual(formatAutomaticMemoryAssessment({ success: false, assessed: false, candidates: [] }), []);
    assert.deepEqual(formatAutomaticMemoryAssessment({ success: true, assessed: false, candidates: [] }), []);
    assert.deepEqual(formatAutomaticMemoryAssessment(null), []);
});
