import { assertDenseArray, validateMemoryRecord, validateTemporal, validateTemporalInterval,
    validateTimestamp } from './schema.js';
import { classifyValidity, compareTemporal } from './temporal.js';

const INTENTS = new Set(['fact', 'plan']);
const ACTIONS = new Set(['replace', 'cancel_plan']);

function exactObject(value, keys, code = 'memory_temporal_invalid') {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
        throw new TypeError(code);
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key)))
        throw new TypeError(code);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
            throw new TypeError(code);
    }
    return value;
}

function descriptorState(assertion, asOf, intent) {
    if (assertion.status === 'superseded') return { state: 'historical', reason: 'assertion_superseded' };
    if (intent === 'plan') {
        if (assertion.valid_from === null) return { state: 'unknown', reason: 'plan_start_unknown' };
        if (compareTemporal(asOf, assertion.valid_from) === 'before')
            return { state: 'planned', reason: 'future_plan_not_completed' };
        if (assertion.valid_to !== null && compareTemporal(asOf, assertion.valid_to) === 'after')
            return { state: 'unknown', reason: 'plan_window_elapsed_unconfirmed' };
        return { state: 'unknown', reason: 'plan_due_not_completion_evidence' };
    }
    const validity = classifyValidity(assertion.valid_from, assertion.valid_to, asOf);
    if (validity === 'valid') return { state: 'current', reason: 'valid_at_reference_time' };
    if (validity === 'indeterminate') return { state: 'unknown', reason: 'validity_not_established' };
    if (assertion.valid_from !== null && compareTemporal(asOf, assertion.valid_from) === 'before')
        return { state: 'future_fact', reason: 'future_validity_is_not_a_plan' };
    if (assertion.valid_to !== null && compareTemporal(asOf, assertion.valid_to) === 'after')
        return { state: 'historical', reason: 'validity_ended_before_reference_time' };
    return { state: 'unknown', reason: 'temporal_boundary_overlaps_reference_time' };
}

/**
 * Describes an existing Memory2 assertion without altering it. `source.occurred_at`
 * is exposed as source time, never assumed to be the real-world event date.
 * `intent` is a caller-supplied interpretation, not persisted authority.
 */
export function describeTemporalRecord(input) {
    exactObject(input, ['assertion', 'source', 'evidence', 'asOf', 'intent']);
    validateMemoryRecord('assertions', input.assertion);
    validateMemoryRecord('sources', input.source);
    validateMemoryRecord('evidence', input.evidence);
    validateTemporal(input.asOf, 'asOf');
    if (input.asOf === null || !INTENTS.has(input.intent)
        || input.evidence.assertion_id !== input.assertion.id
        || input.evidence.source_id !== input.source.id)
        throw new TypeError('memory_temporal_invalid');
    const lifecycle = descriptorState(input.assertion, input.asOf, input.intent);
    return Object.freeze({
        assertionId: input.assertion.id,
        subject: structuredClone(input.assertion.subject),
        predicate: input.assertion.predicate,
        object: structuredClone(input.assertion.object),
        assertionStatus: input.assertion.status,
        intent: input.intent,
        state: lifecycle.state,
        reason: lifecycle.reason,
        validFrom: structuredClone(input.assertion.valid_from),
        validTo: structuredClone(input.assertion.valid_to),
        eventOccurredAt: null,
        eventTimeStatus: 'not_recorded_on_assertion',
        sourceOccurredAt: structuredClone(input.source.occurred_at),
        receivedAt: input.evidence.learned_at,
        recordedAt: input.assertion.recorded_at,
        sourceRecordedAt: input.source.recorded_at,
        asOf: structuredClone(input.asOf),
    });
}

function slotKey(record) { return `${JSON.stringify(record.subject)}\u0000${record.predicate}`; }
function valueKey(record) { return JSON.stringify(record.object); }
function subjectKey(subject) {
    return subject.type === 'entity' ? `entity:${subject.entity_type}:${subject.id}` : subject.type;
}
function requireSameReferenceTime(records) {
    if (records.some(item => JSON.stringify(item.asOf) !== JSON.stringify(records[0].asOf)))
        throw new TypeError('memory_temporal_reference_time_mismatch');
}
function requireSingleSubjectAndUniqueAssertions(records) {
    if (new Set(records.map(item => subjectKey(item.subject))).size > 1)
        throw new TypeError('memory_temporal_subject_mismatch');
    if (new Set(records.map(item => item.assertionId)).size !== records.length)
        throw new TypeError('memory_temporal_duplicate_assertion');
}

/**
 * Summarizes one already-authorized snapshot. It reports conflicting current
 * values as ambiguous and deliberately does not decide which one wins.
 */
export function summarizeTemporalState(input) {
    exactObject(input, ['records']);
    assertDenseArray(input.records, 'records');
    const records = input.records.map(record => describeTemporalRecord(record));
    if (records.length) {
        requireSameReferenceTime(records);
        requireSingleSubjectAndUniqueAssertions(records);
    }
    const currentBySlot = new Map();
    for (const record of records.filter(item => item.state === 'current')) {
        const key = slotKey(record);
        const values = currentBySlot.get(key) ?? new Set();
        values.add(valueKey(record));
        currentBySlot.set(key, values);
    }
    const ambiguousKeys = new Set([...currentBySlot.entries()]
        .filter(([, values]) => values.size > 1).map(([key]) => key));
    const ids = state => records.filter(item => item.state === state).map(item => item.assertionId).sort();
    const ambiguousAssertionIds = records.filter(item => item.state === 'current' && ambiguousKeys.has(slotKey(item)))
        .map(item => item.assertionId).sort();
    return Object.freeze({
        currentAssertionIds: Object.freeze(ids('current')),
        historicalAssertionIds: Object.freeze(ids('historical')),
        plannedAssertionIds: Object.freeze(ids('planned')),
        futureFactAssertionIds: Object.freeze(ids('future_fact')),
        unknownAssertionIds: Object.freeze(ids('unknown')),
        ambiguousSlotCount: ambiguousKeys.size,
        ambiguousAssertionIds: Object.freeze(ambiguousAssertionIds),
        executable: false,
        persistencePerformed: false,
    });
}

/** A deterministic, read-only projection of records returned by a history query. */
export function orderTemporalHistory(input) {
    exactObject(input, ['records']);
    assertDenseArray(input.records, 'records');
    const records = input.records.map(record => describeTemporalRecord(record));
    if (records.length) {
        requireSameReferenceTime(records);
        requireSingleSubjectAndUniqueAssertions(records);
    }
    return Object.freeze(records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)
        || a.assertionId.localeCompare(b.assertionId)));
}

/**
 * Produces only a hypothetical transition preview for an exact active record.
 * It never changes assertion status or writes a repository.
 */
export function planTemporalTransition(input) {
    exactObject(input, ['record', 'action', 'effectiveAt']);
    if (!ACTIONS.has(input.action)) throw new TypeError('memory_temporal_action_invalid');
    validateTemporal(input.effectiveAt, 'effectiveAt');
    if (input.effectiveAt === null) throw new TypeError('memory_temporal_invalid');
    const current = describeTemporalRecord(input.record);
    if (current.assertionStatus !== 'active')
        return Object.freeze({ success: false, reason: 'target_not_active', executable: false, persistencePerformed: false });
    if (input.action === 'cancel_plan') {
        if (current.intent !== 'plan' || current.state !== 'planned'
            || compareTemporal(input.effectiveAt, input.record.assertion.valid_from) !== 'before')
            return Object.freeze({ success: false, reason: 'target_not_future_plan', executable: false, persistencePerformed: false });
        return Object.freeze({ success: true, action: 'cancel_plan', targetAssertionId: current.assertionId,
            fromState: 'planned', toState: 'cancelled', effectiveAt: structuredClone(input.effectiveAt),
            reason: 'hypothetical_cancellation_only', executable: false, persistencePerformed: false });
    }
    return Object.freeze({ success: true, action: 'mark_replaced', targetAssertionId: current.assertionId,
        fromState: current.state, toState: 'historical', effectiveAt: structuredClone(input.effectiveAt),
        reason: 'hypothetical_supersession_only', executable: false, persistencePerformed: false });
}

/**
 * Validates temporal fields for a proposed fact or plan without assigning IDs,
 * identity, provenance, status, or repository state.
 */
export function previewTemporalEntry(input) {
    exactObject(input, ['validFrom', 'validTo', 'eventOccurredAt', 'receivedAt', 'recordedAt', 'asOf', 'intent']);
    for (const key of ['validFrom', 'validTo', 'eventOccurredAt', 'asOf']) validateTemporal(input[key], key);
    if (input.receivedAt !== null) validateTimestamp(input.receivedAt, 'receivedAt');
    validateTimestamp(input.recordedAt, 'recordedAt');
    if (input.asOf === null || !INTENTS.has(input.intent)) throw new TypeError('memory_temporal_invalid');
    if (input.receivedAt !== null && Date.parse(input.receivedAt) > Date.parse(input.recordedAt))
        throw new TypeError('memory_temporal_order_invalid');
    validateTemporalInterval(input.validFrom, input.validTo, 'validity_interval');
    const state = descriptorState({ status: 'active', valid_from: input.validFrom, valid_to: input.validTo },
        input.asOf, input.intent);
    return Object.freeze({
        action: input.intent === 'plan' ? 'propose_plan' : 'propose_fact',
        state: state.state,
        reason: state.reason,
        validFrom: structuredClone(input.validFrom),
        validTo: structuredClone(input.validTo),
        eventOccurredAt: structuredClone(input.eventOccurredAt),
        receivedAt: input.receivedAt,
        recordedAt: input.recordedAt,
        executable: false,
        persistencePerformed: false,
    });
}
