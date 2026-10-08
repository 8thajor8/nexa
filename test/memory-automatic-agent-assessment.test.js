import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function worker(mode) {
    return `
import assert from 'node:assert/strict';
import { createAgent } from './src/core/agent.js';
import { closeDirectUserInput } from './src/core/direct-user-input.js';
const mode = ${JSON.stringify(mode)};
const events = [], detected = [];
let askCount = 0, toolCount = 0, saveCount = 0, releaseDetector = null;
if (mode === 'missing-detector') {
  await assert.rejects(createAgent({ memoryBackend: 'memory1', load: async () => ({}),
    enableAutomaticMemoryAssessment: true }), /automatic_memory_assessment_configuration_invalid/u);
  console.log('__ASSESSMENT_RESULT__' + JSON.stringify({ accepted: false }));
} else {
  const detector = { detect: async input => {
    events.push('detector:start');
    detected.push({ keys: Object.keys(input).sort(), text: input.text });
    if (mode === 'failure') throw new Error('synthetic private extractor detail');
    if ((mode === 'hang' && detected.length === 1) || mode === 'hang-close') return new Promise(resolve => {
      releaseDetector = () => { events.push('detector:end'); resolve(); };
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    events.push('detector:end');
    return { success: true, proposal: { private: 'ignored result' } };
  } };
  const agent = await createAgent({ memoryBackend: 'memory1', load: async () => ({ user: {}, preferences: {}, facts: [] }),
    save: async () => { saveCount++; }, getTools: () => [{ name: 'synthetic_tool' }],
    execute: async (name, args) => { toolCount++; return { success: true, value: 'tool output must not be assessed' }; },
    ask: async () => {
      askCount++;
      if (mode === 'agent-error' && askCount === 1) throw new Error('synthetic model failure');
      if (mode === 'incomplete') return { status: 'incomplete', output_text: 'Respuesta parcial visible.', output: [] };
      if (mode === 'flow' && askCount === 1) return { status: 'completed', output_text: '', output: [
        { type: 'function_call', name: 'synthetic_tool', call_id: 'call-1', arguments: '{}' },
      ] };
      return { status: 'completed', output_text: askCount === 1 ? 'Respuesta sin evaluación habilitada.' : 'Respuesta conversacional visible.', output: [] };
    },
    ...(mode === 'disabled' ? {} : { enableAutomaticMemoryAssessment: true, automaticMemoryDetector: detector }),
  });

  if (mode === 'hang') {
    const first = await agent.readAndRun();
    events.push('response:visible:' + first.response);
    const completion = agent.completePresentedTurn();
    await new Promise(resolve => setTimeout(resolve, 40));
    let secondSettled = false;
    const secondPromise = agent.readAndRun().then(value => { secondSettled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 40));
    events.push('second_turn_waiting:' + !secondSettled);
    releaseDetector();
    await completion;
    const second = await secondPromise;
    events.push('response:visible:' + second.response);
    await agent.completePresentedTurn();
    await agent.close();
  } else if (mode === 'hang-close') {
    const first = await agent.readAndRun();
    events.push('response:visible:' + first.response);
    const completion = agent.completePresentedTurn();
    await new Promise(resolve => setTimeout(resolve, 40));
    await agent.close();
    events.push('closed_while_detector_pending');
    releaseDetector();
    await completion;
  } else if (mode === 'agent-error') {
    try { await agent.readAndRun(); } catch { events.push('agent:error'); }
    const second = await agent.readAndRun();
    events.push('response:visible:' + second.response);
    await agent.completePresentedTurn();
    await agent.close();
  } else if (mode === 'incomplete') {
    const first = await agent.readAndRun();
    events.push('response:visible:' + first.response);
    await agent.completePresentedTurn();
    await agent.close();
  } else if (mode === 'flow' || mode === 'failure') {
    const first = await agent.readAndRun();
    events.push('response:visible:' + first.response);
    const completed = await agent.completePresentedTurn();
    events.push('completion:' + completed.success);
    const repeated = await agent.completePresentedTurn();
    events.push('second_completion:' + repeated.assessed);
    await agent.run('caller supplied non-stdin text');
    await agent.completePresentedTurn();
    const second = await agent.readAndRun();
    events.push('response:visible:' + second.response);
    await agent.completePresentedTurn();
    await agent.close();
  } else {
    const turn = await agent.readAndRun();
    events.push('response:visible:' + turn.response);
    const completed = await agent.completePresentedTurn();
    events.push('completion:' + completed.assessed);
    await agent.close();
  }
  console.log('__ASSESSMENT_RESULT__' + JSON.stringify({ events, detected, askCount, toolCount, saveCount }));
}
closeDirectUserInput();
`;
}

async function run(mode, input = 'Mensaje sintético original uno.\nMensaje sintético original dos.\n') {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker(mode)], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdin.write(input);
    child.stdin.end();
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('exit', resolve);
        setTimeout(() => { if (child.exitCode === null) child.kill(); }, 10000).unref();
    });
    assert.equal(exitCode, 0, stderr + stdout);
    const marker = stdout.indexOf('__ASSESSMENT_RESULT__');
    assert.notEqual(marker, -1, stdout);
    return { result: JSON.parse(stdout.slice(marker + '__ASSESSMENT_RESULT__'.length).trim()), stdout, stderr };
}

test('C.2 assessment is disabled by default even when a synthetic detector is available', async () => {
    const { result } = await run('disabled', 'Solo este mensaje sintético.\n');
    assert.equal(result.detected.length, 0);
    assert.equal(result.saveCount, 0);
    assert.ok(result.events.includes('completion:false'));
});

test('C.2 assesses only original direct-user turns once, after visible response, and serializes before next stdin turn', async () => {
    const { result } = await run('flow');
    assert.equal(result.detected.length, 2);
    assert.deepEqual(result.detected.map(item => item.text), [
        'Mensaje sintético original uno.', 'Mensaje sintético original dos.',
    ]);
    assert.ok(result.detected.every(item => JSON.stringify(item.keys) === JSON.stringify(['text'])));
    assert.ok(!result.detected.some(item => item.text.includes('tool output') || item.text.includes('Respuesta conversacional')));
    assert.equal(result.toolCount, 1);
    assert.equal(result.saveCount, 0);
    assert.equal(result.events.filter(item => item.startsWith('detector:start')).length, 2);
    assert.ok(result.events.indexOf('response:visible:Respuesta conversacional visible.') < result.events.indexOf('detector:start'));
    assert.ok(result.events.indexOf('detector:end') < result.events.lastIndexOf('response:visible:Respuesta conversacional visible.'));
    assert.ok(result.events.includes('second_completion:false'));
});

test('C.2 detector failure is sanitized and does not alter responses, trigger writes, or leak details', async () => {
    const { result, stdout, stderr } = await run('failure');
    assert.equal(result.detected.length, 2);
    assert.equal(result.events.filter(item => item.startsWith('response:visible:')).length, 2);
    assert.equal(result.saveCount, 0);
    assert.ok(result.events.includes('completion:false'));
    assert.equal(stdout.includes('synthetic private extractor detail'), false);
    assert.equal(stderr.includes('synthetic private extractor detail'), false);
});

test('C.2 refuses explicit enablement without an injected detector and agent has no automatic writer imports', async () => {
    const { result } = await run('missing-detector', '');
    assert.equal(result.accepted, false);
    const source = await (await import('node:fs/promises')).readFile(path.join(root, 'src/core/agent.js'), 'utf8');
    assert.doesNotMatch(source, /automatic\/authorization-coordinator|commitAutomaticOperation|json-repository/u);
    const cli = await (await import('node:fs/promises')).readFile(path.join(root, 'src/index.js'), 'utf8');
    assert.ok(cli.indexOf('console.log(`Nexa > ${response}`)') < cli.indexOf('await nexa.completePresentedTurn()'));
});

test('C.2 skips assessment after a model failure, then assesses only the next completed direct turn', async () => {
    const { result } = await run('agent-error');
    assert.ok(result.events.includes('agent:error'));
    assert.equal(result.detected.length, 1);
    assert.equal(result.detected[0].text, 'Mensaje sintético original dos.');
});

test('C.2 skips assessment when the conversational response is incomplete', async () => {
    const { result } = await run('incomplete', 'Turno con respuesta parcial.\n');
    assert.equal(result.events[0], 'response:visible:Respuesta parcial visible.');
    assert.equal(result.detected.length, 0);
});

test('C.2 documents current serialization: a detector that never settles holds later turns', async () => {
    const { result } = await run('hang');
    assert.equal(result.detected.length, 2);
    assert.ok(result.events.includes('second_turn_waiting:true'));
    assert.ok(result.events.indexOf('detector:end') < result.events.lastIndexOf('response:visible:Respuesta conversacional visible.'));
});

test('C.2 closing during an in-flight detector does not cancel that detector', async () => {
    const { result } = await run('hang-close', 'Mensaje sintético para cierre.\n');
    assert.equal(result.detected.length, 1);
    assert.ok(result.events.includes('closed_while_detector_pending'));
    assert.ok(result.events.indexOf('closed_while_detector_pending') < result.events.indexOf('detector:end'));
});
