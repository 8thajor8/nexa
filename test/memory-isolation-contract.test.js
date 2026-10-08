import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHypotheticalMemoryContext, validateMemoryIsolationSnapshot } from '../src/memory/isolation-contract.js';

const installationId = '11111111-1111-4111-8111-111111111111';
const otherInstallationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'principal_22222222-2222-4222-8222-222222222222';
const memberA = 'principal_33333333-3333-4333-8333-333333333333';
const memberB = 'principal_44444444-4444-4444-8444-444444444444';
const personOwner = 'person_55555555-5555-4555-8555-555555555555';
const personA = 'person_66666666-6666-4666-8666-666666666666';
const personB = 'person_77777777-7777-4777-8777-777777777777';
const privateOwner = 'partition_88888888-8888-4888-8888-888888888888';
const privateA = 'partition_99999999-9999-4999-8999-999999999999';
const privateB = 'partition_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sharedOwner = 'partition_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerRecord = 'memory_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memberARecord = 'memory_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const memberBRecord = 'memory_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const sharedRecord = 'memory_ffffffff-ffff-4fff-8fff-ffffffffffff';

function makeSnapshot(overrides = {}) {
    const snapshot = {
        schemaVersion: 1,
        installationId,
        revision: 3,
        evaluatedAt: '2030-03-01T00:00:00.000Z',
        principalIds: [ownerId, memberA, memberB],
        partitions: [
            { partitionId: privateOwner, installationId, kind: 'private', ownerPrincipalId: ownerId },
            { partitionId: privateA, installationId, kind: 'private', ownerPrincipalId: memberA },
            { partitionId: privateB, installationId, kind: 'private', ownerPrincipalId: memberB },
            { partitionId: sharedOwner, installationId, kind: 'shared', ownerPrincipalId: ownerId },
        ],
        records: [
            { recordId: ownerRecord, partitionId: privateOwner, installationId, ownerPrincipalId: ownerId,
                subjectPersonId: personB, contributorPrincipalId: ownerId, sourceRecordId: null },
            { recordId: memberARecord, partitionId: privateA, installationId, ownerPrincipalId: memberA,
                subjectPersonId: personA, contributorPrincipalId: memberA, sourceRecordId: null },
            { recordId: memberBRecord, partitionId: privateB, installationId, ownerPrincipalId: memberB,
                subjectPersonId: personB, contributorPrincipalId: memberB, sourceRecordId: null },
            { recordId: sharedRecord, partitionId: sharedOwner, installationId, ownerPrincipalId: ownerId,
                subjectPersonId: personB, contributorPrincipalId: ownerId, sourceRecordId: ownerRecord },
        ],
        shares: [{ shareId: '12121212-1212-4212-8212-121212121212', installationId,
            sourceRecordId: ownerRecord, sharedRecordId: sharedRecord, ownerPrincipalId: ownerId,
            recipientPrincipalIds: [memberA], approvedByPrincipalId: ownerId,
            approvedAt: '2030-01-01T00:00:00.000Z', revokedAt: null, revision: 2 }],
    };
    return { ...snapshot, ...overrides };
}

function select(principalId, snapshot = makeSnapshot(), overrides = {}) {
    return selectHypotheticalMemoryContext({ mode: 'hypothetical', installationId, principalId, snapshot, ...overrides });
}

test('hypothetical visibility isolates Owner and member private partitions; Owner role is not a bypass', () => {
    const snapshot = makeSnapshot();
    const owner = select(ownerId, snapshot);
    const a = select(memberA, snapshot);
    const b = select(memberB, snapshot);
    assert.equal(validateMemoryIsolationSnapshot(snapshot), true);
    assert.deepEqual(owner.recordIds, [ownerRecord]);
    assert.deepEqual(a.recordIds, [memberARecord, sharedRecord]);
    assert.deepEqual(b.recordIds, [memberBRecord]);
    for (const result of [owner, a, b]) {
        assert.equal(result.decision, 'ALLOW');
        assert.equal(result.mode, 'hypothetical');
        assert.equal(result.executable, false);
    }
    assert.equal(Object.hasOwn(a, 'partitionIds'), false, 'selection never exposes a broad partition reference');
    assert.deepEqual(Object.keys(a).sort(), ['decision', 'executable', 'mode', 'reasonCode', 'recordIds']);
});

test('a memory about another person remains private to its contributor/owner by default', () => {
    const result = select(ownerId);
    assert.ok(result.recordIds.includes(ownerRecord));
    assert.ok(!result.recordIds.includes(memberBRecord));
    assert.equal(makeSnapshot().records.find(record => record.recordId === ownerRecord).subjectPersonId, personB);
    assert.equal(makeSnapshot().records.find(record => record.recordId === ownerRecord).ownerPrincipalId, ownerId);
});

test('sharing is an exact-record reference for explicit recipients and revocation removes future visibility', () => {
    const snapshot = makeSnapshot();
    assert.deepEqual(select(memberA, snapshot).recordIds, [memberARecord, sharedRecord]);
    assert.deepEqual(select(memberB, snapshot).recordIds, [memberBRecord]);
    const revoked = makeSnapshot({ shares: [{ ...snapshot.shares[0], revokedAt: '2030-02-01T00:00:00.000Z' }] });
    assert.deepEqual(select(memberA, revoked).recordIds, [memberARecord]);
    assert.equal(select(memberA, revoked).executable, false);
});

test('shared references cannot enumerate sibling records addressed to different recipients', () => {
    const base = makeSnapshot();
    const otherOwnerRecord = 'memory_16161616-1616-4616-8616-161616161616';
    const otherSharedRecord = 'memory_17171717-1717-4717-8717-171717171717';
    const snapshot = makeSnapshot({
        records: [...base.records,
            { recordId: otherOwnerRecord, partitionId: privateOwner, installationId, ownerPrincipalId: ownerId,
                subjectPersonId: personOwner, contributorPrincipalId: ownerId, sourceRecordId: null },
            { recordId: otherSharedRecord, partitionId: sharedOwner, installationId, ownerPrincipalId: ownerId,
                subjectPersonId: personOwner, contributorPrincipalId: ownerId, sourceRecordId: otherOwnerRecord }],
        shares: [...base.shares, { shareId: '18181818-1818-4818-8818-181818181818', installationId,
            sourceRecordId: otherOwnerRecord, sharedRecordId: otherSharedRecord, ownerPrincipalId: ownerId,
            recipientPrincipalIds: [memberB], approvedByPrincipalId: ownerId,
            approvedAt: '2030-02-01T00:00:00.000Z', revokedAt: null, revision: 3 }],
    });
    assert.equal(validateMemoryIsolationSnapshot(snapshot), true);
    assert.deepEqual(select(memberA, snapshot).recordIds, [memberARecord, sharedRecord]);
    assert.deepEqual(select(memberB, snapshot).recordIds, [memberBRecord, otherSharedRecord]);
    assert.ok(!select(memberA, snapshot).recordIds.includes(otherSharedRecord));
    assert.ok(!select(memberB, snapshot).recordIds.includes(sharedRecord));
});

test('missing, malformed, unauthorized-looking, or ambiguous shares fail closed', () => {
    const snapshot = makeSnapshot();
    assert.equal(select(memberA, makeSnapshot({ shares: [] })).decision, 'DENY');
    assert.equal(select(memberA, makeSnapshot({ shares: [{ ...snapshot.shares[0], approvedByPrincipalId: memberA }] })).decision,
        'DENY');
    assert.equal(select(memberA, makeSnapshot({ shares: [{ ...snapshot.shares[0], recipientPrincipalIds: [memberA, memberA] }] })).decision,
        'DENY');
    assert.equal(select(memberA, makeSnapshot({ shares: [snapshot.shares[0],
        { ...snapshot.shares[0], shareId: '13131313-1313-4313-8313-131313131313' }] })).decision, 'DENY');
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ shares: [{ ...snapshot.shares[0],
        recipientPrincipalIds: ['principal_15151515-1515-4515-8515-151515151515'] }] })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ shares: [{ ...snapshot.shares[0],
        approvedAt: '2030-04-01T00:00:00.000Z' }] })), false);
});

test('identity absence and installation mismatch never fall back to another partition', () => {
    assert.equal(select('principal_14141414-1414-4414-8414-141414141414').reasonCode, 'principal_missing');
    assert.equal(select(memberA, makeSnapshot(), { installationId: otherInstallationId }).reasonCode, 'installation_mismatch');
    assert.equal(select(memberA, makeSnapshot({ principalIds: [ownerId, memberA, memberA] })).decision, 'DENY');
    assert.deepEqual(selectHypotheticalMemoryContext({ mode: 'hypothetical', installationId,
        principalId: memberA, snapshot: makeSnapshot({ installationId: otherInstallationId }) }).decision, 'DENY');
});

test('partition and record references are opaque, validated identifiers and cannot traverse paths', () => {
    const snapshot = makeSnapshot();
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ partitions: [
        { ...snapshot.partitions[0], partitionId: '../private' }, ...snapshot.partitions.slice(1),
    ] })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ partitions: [
        { ...snapshot.partitions[0], partitionId: privateOwner.toUpperCase() }, ...snapshot.partitions.slice(1),
    ] })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ partitions: [
        ...snapshot.partitions, snapshot.partitions[0],
    ] })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ records: [
        ...snapshot.records, { ...snapshot.records[0], recordId: sharedRecord },
    ] })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ records: snapshot.records.map(record => record.recordId === sharedRecord
        ? { ...record, sourceRecordId: memberARecord } : record) })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ shares: [{ ...snapshot.shares[0], ownerPrincipalId: memberA }] })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ records: snapshot.records.map(record => record.recordId === ownerRecord
        ? { ...record, partitionId: privateA } : record) })), false);
    assert.equal(validateMemoryIsolationSnapshot(makeSnapshot({ records: snapshot.records.map(record => record.recordId === sharedRecord
        ? { ...record, partitionId: privateB } : record) })), false);
});

test('context selection returns only references and re-evaluates when the principal changes', () => {
    const snapshot = makeSnapshot();
    const privatePayload = new Map([[ownerRecord, 'owner-only private text'],
        [memberARecord, 'member-a private text'], [memberBRecord, 'member-b private text'],
        [sharedRecord, 'explicitly shared reference']]);
    const firstContext = select(memberA, snapshot).recordIds.map(id => privatePayload.get(id));
    const nextContext = select(memberB, snapshot).recordIds.map(id => privatePayload.get(id));
    assert.deepEqual(firstContext, ['member-a private text', 'explicitly shared reference']);
    assert.deepEqual(nextContext, ['member-b private text']);
    assert.deepEqual(select(memberB, snapshot).recordIds, [memberBRecord]);
});

test('execution access always denies and hostile shapes cannot produce an executable result', () => {
    assert.deepEqual(selectHypotheticalMemoryContext({ mode: 'execution', installationId, principalId: ownerId,
        snapshot: makeSnapshot() }), { decision: 'DENY', mode: 'execution', executable: false,
        reasonCode: 'trusted_memory_authorization_unavailable', recordIds: [] });
    const hostile = {};
    Object.defineProperty(hostile, 'mode', { enumerable: true, get() { throw new Error('must not invoke'); } });
    assert.equal(selectHypotheticalMemoryContext(hostile).decision, 'DENY');
    assert.equal(validateMemoryIsolationSnapshot(hostile), false);
});
