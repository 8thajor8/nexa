/**
 * Hypothetical, data-only contracts for future per-user Memory isolation.
 * This module selects opaque record references only: it performs no I/O,
 * returns no memory content, grants no executable access, and is not connected
 * to Memory2, the context provider, tools, or the conversational agent.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINCIPAL_ID = /^principal_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PERSON_ID = /^person_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PARTITION_ID = /^partition_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECORD_ID = /^memory_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function exactRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}

function denseArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
    }
    return true;
}

function canonicalMatch(pattern, value) { return typeof value === 'string' && value === value.toLowerCase() && pattern.test(value); }
function validPrincipalId(value) { return canonicalMatch(PRINCIPAL_ID, value); }
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

function validPartition(value) {
    return exactRecord(value, ['partitionId', 'installationId', 'kind', 'ownerPrincipalId'])
        && canonicalMatch(PARTITION_ID, value.partitionId)
        && canonicalMatch(UUID, value.installationId)
        && ['private', 'shared'].includes(value.kind)
        && validPrincipalId(value.ownerPrincipalId);
}

function validRecord(value) {
    return exactRecord(value, ['recordId', 'partitionId', 'installationId', 'ownerPrincipalId',
        'subjectPersonId', 'contributorPrincipalId', 'sourceRecordId'])
        && canonicalMatch(RECORD_ID, value.recordId)
        && canonicalMatch(PARTITION_ID, value.partitionId)
        && canonicalMatch(UUID, value.installationId)
        && validPrincipalId(value.ownerPrincipalId)
        && (value.subjectPersonId === null || canonicalMatch(PERSON_ID, value.subjectPersonId))
        && (value.contributorPrincipalId === null || validPrincipalId(value.contributorPrincipalId))
        && (value.sourceRecordId === null || canonicalMatch(RECORD_ID, value.sourceRecordId));
}

function validShare(value) {
    if (!exactRecord(value, ['shareId', 'installationId', 'sourceRecordId', 'sharedRecordId', 'ownerPrincipalId',
        'recipientPrincipalIds', 'approvedByPrincipalId', 'approvedAt', 'revokedAt', 'revision'])
        || !canonicalMatch(UUID, value.shareId)
        || !canonicalMatch(UUID, value.installationId)
        || !canonicalMatch(RECORD_ID, value.sourceRecordId)
        || !canonicalMatch(RECORD_ID, value.sharedRecordId)
        || !validPrincipalId(value.ownerPrincipalId) || !denseArray(value.recipientPrincipalIds)
        || value.recipientPrincipalIds.length === 0 || !value.recipientPrincipalIds.every(validPrincipalId)
        || new Set(value.recipientPrincipalIds).size !== value.recipientPrincipalIds.length
        || value.recipientPrincipalIds.includes(value.ownerPrincipalId)
        || value.approvedByPrincipalId !== value.ownerPrincipalId || !validTimestamp(value.approvedAt)
        || !(value.revokedAt === null || validTimestamp(value.revokedAt))
        || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
    return true;
}

function validateSnapshot(snapshot) {
    if (!exactRecord(snapshot, ['schemaVersion', 'installationId', 'revision', 'evaluatedAt', 'principalIds', 'partitions', 'records', 'shares'])
        || snapshot.schemaVersion !== 1 || !canonicalMatch(UUID, snapshot.installationId)
        || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
        || !validTimestamp(snapshot.evaluatedAt)
        || !denseArray(snapshot.principalIds) || !snapshot.principalIds.every(validPrincipalId)
        || new Set(snapshot.principalIds).size !== snapshot.principalIds.length
        || !denseArray(snapshot.partitions) || !snapshot.partitions.every(validPartition)
        || !denseArray(snapshot.records) || !snapshot.records.every(validRecord)
        || !denseArray(snapshot.shares) || !snapshot.shares.every(validShare)) return false;

    const partitions = new Map();
    const privateOwners = new Set();
    for (const partition of snapshot.partitions) {
        if (partition.installationId !== snapshot.installationId || !snapshot.principalIds.includes(partition.ownerPrincipalId)
            || partitions.has(partition.partitionId)) return false;
        if (partition.kind === 'private') {
            if (privateOwners.has(partition.ownerPrincipalId)) return false;
            privateOwners.add(partition.ownerPrincipalId);
        }
        partitions.set(partition.partitionId, partition);
    }

    const records = new Map();
    for (const record of snapshot.records) {
        const partition = partitions.get(record.partitionId);
        if (record.installationId !== snapshot.installationId || records.has(record.recordId) || !partition
            || partition.ownerPrincipalId !== record.ownerPrincipalId
            || (record.sourceRecordId === null && partition.kind !== 'private')
            || (record.sourceRecordId !== null && partition.kind !== 'shared')) return false;
        records.set(record.recordId, record);
    }

    const sharedTargets = new Set();
    const shareIds = new Set();
    for (const share of snapshot.shares) {
        const source = records.get(share.sourceRecordId);
        const target = records.get(share.sharedRecordId);
        const sourcePartition = source && partitions.get(source.partitionId);
        const targetPartition = target && partitions.get(target.partitionId);
        if (share.installationId !== snapshot.installationId || !source || !target
            || sourcePartition?.kind !== 'private' || targetPartition?.kind !== 'shared'
            || source.sourceRecordId !== null || target.sourceRecordId !== source.recordId
            || source.recordId === target.recordId || source.ownerPrincipalId !== share.ownerPrincipalId
            || target.ownerPrincipalId !== share.ownerPrincipalId
            || target.subjectPersonId !== source.subjectPersonId
            || target.contributorPrincipalId !== source.contributorPrincipalId
            || targetPartition.ownerPrincipalId !== share.ownerPrincipalId
            || !share.recipientPrincipalIds.every(id => snapshot.principalIds.includes(id))
            || shareIds.has(share.shareId) || sharedTargets.has(share.sharedRecordId)
            || Date.parse(share.approvedAt) > Date.parse(snapshot.evaluatedAt)
            || share.revision > snapshot.revision) return false;
        shareIds.add(share.shareId);
        sharedTargets.add(share.sharedRecordId);
    }

    // No orphan shared records: every shared projection must have an explicit share entry.
    for (const record of snapshot.records) {
        if (record.sourceRecordId !== null && !sharedTargets.has(record.recordId)) return false;
    }
    return true;
}

/** Validate a synthetic isolation snapshot; validity is not identity or consent proof. */
export function validateMemoryIsolationSnapshot(snapshot) {
    try { return validateSnapshot(snapshot); } catch { return false; }
}

function result(decision, code, recordIds = []) {
    return Object.freeze({ decision, mode: 'hypothetical', executable: false, reasonCode: code,
        recordIds: Object.freeze([...recordIds]) });
}

/**
 * Select only opaque references visible in a synthetic snapshot. `execution`
 * mode is unconditionally DENY; no paths or record contents are returned.
 */
export function selectHypotheticalMemoryContext(input) {
    try {
        const mode = Object.getOwnPropertyDescriptor(input ?? {}, 'mode')?.value;
        if (mode === 'execution') return Object.freeze({ decision: 'DENY', mode: 'execution', executable: false,
            reasonCode: 'trusted_memory_authorization_unavailable', recordIds: Object.freeze([]) });
        if (!exactRecord(input, ['mode', 'installationId', 'principalId', 'snapshot']) || mode !== 'hypothetical'
            || !canonicalMatch(UUID, input.installationId)
            || !validPrincipalId(input.principalId) || !validateMemoryIsolationSnapshot(input.snapshot))
            return result('DENY', 'memory_isolation_input_invalid');
        const { installationId, principalId, snapshot } = input;
        if (installationId !== snapshot.installationId) return result('DENY', 'installation_mismatch');
        if (!snapshot.principalIds.includes(principalId)) return result('DENY', 'principal_missing');

        const sharesByTarget = new Map(snapshot.shares.map(share => [share.sharedRecordId, share]));
        const visibleRecords = snapshot.records.filter(record => {
            const partition = snapshot.partitions.find(item => item.partitionId === record.partitionId);
            if (!partition || record.installationId !== installationId) return false;
            if (partition.kind === 'private') return record.sourceRecordId === null && record.ownerPrincipalId === principalId;
            const share = sharesByTarget.get(record.recordId);
            return record.sourceRecordId !== null && share?.revokedAt === null
                && share.installationId === installationId && share.ownerPrincipalId === record.ownerPrincipalId
                && share.recipientPrincipalIds.includes(principalId);
        });
        // Return exact record references only. A shared partition ID could expose
        // sibling records addressed to other recipients if a later caller enumerated it.
        return result('ALLOW', 'hypothetical_references_selected', visibleRecords.map(record => record.recordId));
    } catch {
        return result('DENY', 'memory_isolation_input_invalid');
    }
}
