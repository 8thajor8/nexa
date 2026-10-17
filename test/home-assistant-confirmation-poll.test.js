import assert from 'node:assert/strict';
import test from 'node:test';
import { pollForConfirmation } from '../src/integrations/home-assistant/confirmation-poll.js';

test('uses short bounded intervals, passes remaining time into reads, and stops immediately on confirmation', async () => {
    let clock = 0;
    const reads = [];
    const waits = [];
    const result = await pollForConfirmation({ budgetMs: 3000,
        nowImpl: () => clock,
        waitImpl: async ms => { waits.push(ms); clock += ms; },
        read: async remainingMs => { reads.push(remainingMs); clock += 25; return reads.length === 3 ? 'ready' : 'stale'; },
        isConfirmed: state => state === 'ready',
    });
    assert.deepEqual(result, { confirmed: true, state: 'ready', error: null });
    assert.deepEqual(waits, [100, 150]);
    assert.deepEqual(reads, [3000, 2875, 2700]);
});

test('returns unconfirmed at the 3000 ms ceiling and retries transient read errors within that budget', async () => {
    let clock = 0;
    const waits = [];
    const readBudgets = [];
    const result = await pollForConfirmation({ budgetMs: 3000,
        nowImpl: () => clock,
        waitImpl: async ms => { waits.push(ms); clock += ms; },
        read: async remainingMs => {
            readBudgets.push(remainingMs);
            clock += 10;
            if (readBudgets.length === 1) throw Object.assign(new Error('synthetic timeout'), { code: 'timeout' });
            return 'stale';
        },
        isConfirmed: () => false,
    });
    assert.equal(result.confirmed, false);
    assert.equal(result.state, 'stale');
    assert.equal(result.error, null);
    assert.ok(waits.reduce((sum, delay) => sum + delay, 0) <= 3000);
    assert.equal(clock, 3000);
    assert.ok(readBudgets.every(remaining => remaining > 0 && remaining <= 3000));
});
