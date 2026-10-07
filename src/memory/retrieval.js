import { canonicalSubject, eligibleNameAssertions, normalizeEntityName, projectPerson } from './entities.js';
import { getRelationPredicate } from './relation-predicates.js';
import { assertDenseArray, assertExactObject, validateId } from './schema.js';
import { classifyValidity, validateNow, validateValidTime } from './temporal.js';

export const MEMORY_RETRIEVAL_LIMITS = Object.freeze({
    maxSeedEntities: 5,
    maxRelationDepth: 1,
    maxNeighborsPerEntity: 8,
    maxRelations: 10,
    maxAssertions: 20,
    maxPerEntityPredicate: 3,
});

const QUERY_KEYS = ['entityIds', 'includeSelf', 'predicates', 'relationPredicates', 'statuses', 'limits'];
const LIMIT_KEYS = Object.keys(MEMORY_RETRIEVAL_LIMITS);
const VALID_STATUSES = Object.freeze(['active', 'superseded']);

function assertAllowedObject(value, keys, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('memory_retrieval_invalid');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('memory_retrieval_invalid');
    const own = Reflect.ownKeys(value);
    if (own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new TypeError('memory_retrieval_invalid');
    for (const key of own) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError('memory_retrieval_invalid');
    }
    return value;
}

function normalizedQuery(text) {
    if (typeof text !== 'string' || !text.isWellFormed() || text.length > 16000) throw new TypeError('memory_mention_invalid');
    // Sentence whitespace is query syntax; control and format characters other
    // than whitespace remain invalid, matching the conservative name policy.
    if (/[\p{Cc}\p{Cf}]/u.test(text.replace(/\s/gu, ''))) throw new TypeError('memory_mention_invalid');
    const result = text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase().normalize('NFC');
    if (!result) throw new TypeError('memory_mention_invalid');
    return result;
}

function isWordCharacter(value) { return value !== '' && /[\p{L}\p{N}\p{M}_]/u.test(value); }
function boundedOccurrences(text, phrase) {
    const hits = [];
    let from = 0;
    while (from <= text.length - phrase.length) {
        const start = text.indexOf(phrase, from);
        if (start < 0) break;
        const end = start + phrase.length;
        const before = Array.from(text.slice(0, start)).at(-1) ?? '';
        const after = Array.from(text.slice(end))[0] ?? '';
        if (!isWordCharacter(before) && !isWordCharacter(after)) hits.push({ start, end });
        from = start + Math.max(phrase.length, 1);
    }
    return hits;
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function uniqueSorted(values) { return [...new Set(values)].sort(compareText); }

/** Finds complete name/alias mentions within a sentence. Spans are offsets in
 * normalizedText, not offsets into the original string. Partial leading words
 * are clarification candidates only. */
export function resolveEntityMentions(text, current, { maxMentions = 20, maxCandidates = 10 } = {}) {
    const normalizedText = normalizedQuery(text);
    if (!current?.snapshot || !Number.isInteger(maxMentions) || maxMentions < 1 || maxMentions > 100
        || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 25) throw new TypeError('memory_mention_invalid');

    const variants = new Map();
    for (const assertion of eligibleNameAssertions(current.snapshot)) {
        const entityId = canonicalSubject(assertion.subject, current.snapshot).id;
        const name = normalizeEntityName(assertion.object.value);
        const exactKey = `exact:${name}`;
        if (!variants.has(exactKey)) variants.set(exactKey, { name, exact: true, matches: [] });
        variants.get(exactKey).matches.push({ entityId, assertionId: assertion.id });
        const words = name.split(' ');
        for (let count = 1; count < words.length; count++) {
            const partialName = words.slice(0, count).join(' ');
            const partialKey = `partial:${partialName}`;
            if (!variants.has(partialKey)) variants.set(partialKey, { name: partialName, exact: false, matches: [] });
            variants.get(partialKey).matches.push({ entityId, assertionId: assertion.id });
        }
    }

    const hits = [];
    for (const variant of variants.values()) {
        for (const span of boundedOccurrences(normalizedText, variant.name)) {
            hits.push({ ...span, exact: variant.exact, name: variant.name, matches: variant.matches });
        }
    }
    // Keep exact and partial overlaps together: an exact alias for one person
    // must not hide another person's longer name with the same leading words.
    hits.sort((a, b) => a.start - b.start || b.end - a.end || compareText(a.name, b.name));

    const components = [];
    for (const hit of hits) {
        const last = components.at(-1);
        if (last && hit.start < last.end) {
            last.end = Math.max(last.end, hit.end);
            last.hits.push(hit);
        } else components.push({ start: hit.start, end: hit.end, hits: [hit] });
    }
    const mentions = components.slice(0, maxMentions).map(component => {
        const candidates = new Map();
        for (const hit of component.hits) for (const match of hit.matches) {
            if (!candidates.has(match.entityId)) candidates.set(match.entityId, new Set());
            candidates.get(match.entityId).add(match.assertionId);
        }
        const ids = [...candidates.keys()].sort(compareText);
        const exact = component.hits.some(hit => hit.exact);
        const status = ids.length > 1 ? 'ambiguous' : exact ? 'resolved' : 'insufficient_evidence';
        return {
            status, match: exact ? 'exact' : 'partial', entityId: status === 'resolved' ? ids[0] : null,
            text: normalizedText.slice(component.start, component.end), start: component.start, end: component.end,
            candidates: ids.slice(0, maxCandidates).map(entityId => ({ entityId,
                matchedAssertionIds: [...candidates.get(entityId)].sort(compareText).slice(0, 10) })),
            totalCandidates: ids.length, truncated: ids.length > maxCandidates,
        };
    });
    const resolvedEntityIds = uniqueSorted(mentions.filter(item => item.status === 'resolved').map(item => item.entityId));
    return { normalizedText, mentions, resolvedEntityIds, truncated: components.length > maxMentions,
        storeId: current.snapshot.store_id, revision: current.revision, digest: current.digest,
        trust: { authority: 'data_only' } };
}

function normalizeQuery(query) {
    assertAllowedObject(query, QUERY_KEYS, 'query');
    const entityIds = query.entityIds ?? [];
    assertDenseArray(entityIds, 'query.entityIds');
    const checkedIds = entityIds.map(id => { validateId(id, 'person', 'query.entityIds'); return id; });
    const includeSelf = query.includeSelf ?? false;
    if (typeof includeSelf !== 'boolean') throw new TypeError('memory_retrieval_invalid');
    const predicates = query.predicates ?? null;
    if (predicates !== null) {
        assertDenseArray(predicates, 'query.predicates');
        for (const predicate of predicates) if (typeof predicate !== 'string' || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u.test(predicate)) throw new TypeError('memory_retrieval_invalid');
    }
    const relationPredicates = query.relationPredicates ?? [];
    assertDenseArray(relationPredicates, 'query.relationPredicates');
    for (const predicate of relationPredicates) if (!getRelationPredicate(predicate)) throw new TypeError('memory_retrieval_invalid');
    const statuses = query.statuses ?? VALID_STATUSES;
    assertDenseArray(statuses, 'query.statuses');
    if (statuses.some(status => !VALID_STATUSES.includes(status)) || new Set(statuses).size !== statuses.length) throw new TypeError('memory_retrieval_invalid');
    const rawLimits = query.limits ?? {};
    assertAllowedObject(rawLimits, LIMIT_KEYS, 'query.limits');
    const limits = { ...MEMORY_RETRIEVAL_LIMITS };
    for (const key of LIMIT_KEYS) {
        if (!Object.hasOwn(rawLimits, key)) continue;
        const value = rawLimits[key];
        if (!Number.isInteger(value) || value < 0 || value > MEMORY_RETRIEVAL_LIMITS[key]) throw new TypeError('memory_retrieval_limit_invalid');
        limits[key] = value;
    }
    return { entityIds: uniqueSorted(checkedIds), includeSelf, predicates: predicates === null ? null : uniqueSorted(predicates),
        relationPredicates: uniqueSorted(relationPredicates), statuses: uniqueSorted(statuses), limits };
}

function queryWithStatuses(query, statuses) {
    assertAllowedObject(query, QUERY_KEYS, 'query');
    const safe = Object.create(null);
    for (const key of Reflect.ownKeys(query)) safe[key] = Object.getOwnPropertyDescriptor(query, key).value;
    safe.statuses = statuses;
    return safe;
}

function atTime(current, rawQuery, validTime, statuses, useActiveStatusForUnboundedCurrent = false) {
    const time = validateValidTime(validTime);
    const candidates = retrieveCandidates(current, queryWithStatuses(rawQuery, statuses));
    const status = record => useActiveStatusForUnboundedCurrent && record.status === 'active'
        && record.valid_from === null && record.valid_to === null ? 'valid'
        : classifyValidity(record.valid_from, record.valid_to, time);
    const classify = item => ({ ...item, temporalStatus: status(item.record) });
    const classifyRelation = item => ({ ...item, temporalStatus: status(item.assertion) });
    const classifiedAssertions = candidates.assertions.map(classify);
    const classifiedRelations = candidates.relations.map(classifyRelation);
    return {
        ...candidates,
        assertions: classifiedAssertions.filter(item => item.temporalStatus === 'valid'),
        indeterminateAssertions: classifiedAssertions.filter(item => item.temporalStatus === 'indeterminate'),
        relations: classifiedRelations.filter(item => item.temporalStatus === 'valid'),
        indeterminateRelations: classifiedRelations.filter(item => item.temporalStatus === 'indeterminate'),
        metadata: { ...candidates.metadata, validTime: structuredClone(time),
            temporalModel: 'valid_time_only', bitemporal: false },
    };
}

function assertionEvidence(assertionId, evidenceByAssertion, sourcesById) {
    return (evidenceByAssertion.get(assertionId) ?? []).map(evidence => ({
        evidence: structuredClone(evidence),
        source: structuredClone(sourcesById.get(evidence.source_id)),
    }));
}

function relationNeighbor(record, entityId, definition, allowedPredicates) {
    if (record.subject.id === entityId) return { entityId: record.object.id, predicate: record.predicate, traversable: true };
    if (record.object.id !== entityId) return null;
    if (definition.symmetric) return { entityId: record.subject.id, predicate: record.predicate, traversable: true };
    if (definition.inverse && allowedPredicates.has(definition.inverse)) return { entityId: record.subject.id, predicate: definition.inverse, traversable: true };
    return { entityId: record.subject.id, predicate: null, traversable: false };
}

/** Pure structured candidate selection over one validated repository snapshot. */
export function retrieveCandidates(current, rawQuery) {
    if (!current?.snapshot || !Number.isSafeInteger(current.revision) || typeof current.digest !== 'string') throw new TypeError('memory_snapshot_invalid');
    const query = normalizeQuery(rawQuery);
    const store = current.snapshot;
    const entityById = new Map(store.entities.map(entity => [entity.id, entity]));
    const requested = query.entityIds.filter(id => entityById.get(id)?.type === 'person');
    const ignoredSeedCount = query.entityIds.length - requested.length;
    const selectedSeeds = uniqueSorted([...(query.includeSelf ? [store.self_person_id] : []), ...requested]);
    const seedEntityIds = [];
    if (query.includeSelf && entityById.has(store.self_person_id) && query.limits.maxSeedEntities > 0) seedEntityIds.push(store.self_person_id);
    for (const id of selectedSeeds) if (!seedEntityIds.includes(id) && seedEntityIds.length < query.limits.maxSeedEntities) seedEntityIds.push(id);
    seedEntityIds.sort(compareText);
    const seedSet = new Set(seedEntityIds);
    const seedTruncated = selectedSeeds.length > seedEntityIds.length;
    const statusSet = new Set(query.statuses);
    const predicateSet = query.predicates === null ? null : new Set(query.predicates);
    const relationPredicateSet = new Set(query.relationPredicates);

    const perEntityRelations = [];
    let neighborsTruncated = false;
    for (const entityId of seedEntityIds) {
        const neighbors = new Set();
        const incident = store.assertions.filter(record => statusSet.has(record.status)
            && relationPredicateSet.has(record.predicate)
            && (record.subject.id === entityId || record.object?.id === entityId))
            .sort((a, b) => compareText(a.id, b.id));
        for (const record of incident) {
            const definition = getRelationPredicate(record.predicate);
            const neighbor = relationNeighbor(record, entityId, definition, relationPredicateSet);
            if (!neighbor) continue;
            if (!neighbors.has(neighbor.entityId) && neighbors.size >= query.limits.maxNeighborsPerEntity) {
                neighborsTruncated = true;
                continue;
            }
            neighbors.add(neighbor.entityId);
            perEntityRelations.push({ record, traversalFrom: entityId, neighborId: neighbor.entityId,
                traversalPredicate: neighbor.predicate, canTraverse: neighbor.traversable });
        }
    }
    const uniqueRelations = new Map();
    for (const candidate of perEntityRelations) if (!uniqueRelations.has(candidate.record.id)) uniqueRelations.set(candidate.record.id, candidate);
    const allRelationCandidates = [...uniqueRelations.values()].sort((a, b) => compareText(a.record.id, b.record.id));
    const selectedRelationCandidates = allRelationCandidates.slice(0, query.limits.maxRelations);
    const relationTruncated = allRelationCandidates.length > selectedRelationCandidates.length;
    const neighborEntityIds = uniqueSorted(selectedRelationCandidates.map(item => item.neighborId).filter(id => !seedSet.has(id)));
    const traversedEntityIds = uniqueSorted(selectedRelationCandidates.filter(item => item.canTraverse)
        .map(item => item.neighborId).filter(id => !seedSet.has(id)));
    const retrievalEntityIds = uniqueSorted([...seedEntityIds, ...neighborEntityIds]);
    const assertionEntityIds = query.limits.maxRelationDepth === 0
        ? seedEntityIds : uniqueSorted([...seedEntityIds, ...traversedEntityIds]);

    const assertionCandidates = [];
    for (const entityId of assertionEntityIds) {
        const direct = store.assertions.filter(record => statusSet.has(record.status)
            && !getRelationPredicate(record.predicate)
            && (predicateSet === null || predicateSet.has(record.predicate))
            && canonicalSubject(record.subject, store).id === entityId)
            .sort((a, b) => compareText(a.predicate, b.predicate) || compareText(a.id, b.id));
        for (const record of direct) assertionCandidates.push({ record, entityId, isSeed: seedSet.has(entityId) });
    }
    assertionCandidates.sort((a, b) => Number(b.isSeed) - Number(a.isSeed)
        || compareText(a.entityId, b.entityId) || compareText(a.record.predicate, b.record.predicate) || compareText(a.record.id, b.record.id));
    const perKeyCounts = new Map(), seenAssertionIds = new Set(), selectedAssertions = [];
    for (const candidate of assertionCandidates) {
        const { record, entityId } = candidate;
        if (seenAssertionIds.has(record.id)) continue;
        const key = entityId + '\u0000' + record.predicate;
        const count = perKeyCounts.get(key) ?? 0;
        if (count >= query.limits.maxPerEntityPredicate || selectedAssertions.length >= query.limits.maxAssertions) continue;
        seenAssertionIds.add(record.id); perKeyCounts.set(key, count + 1); selectedAssertions.push(candidate);
    }
    const assertionTruncated = selectedAssertions.length < assertionCandidates.length;

    const evidenceByAssertion = new Map();
    for (const evidence of store.evidence) {
        if (!evidenceByAssertion.has(evidence.assertion_id)) evidenceByAssertion.set(evidence.assertion_id, []);
        evidenceByAssertion.get(evidence.assertion_id).push(evidence);
    }
    for (const items of evidenceByAssertion.values()) items.sort((a, b) => compareText(a.id, b.id));
    const sourcesById = new Map(store.sources.map(source => [source.id, source]));
    const assertions = selectedAssertions.map(({ record, entityId }) => ({
        record: structuredClone(record), entityId,
        evidence: assertionEvidence(record.id, evidenceByAssertion, sourcesById),
        trust: { authority: 'data_only' },
    }));
    const relations = selectedRelationCandidates.map(({ record, traversalFrom, neighborId, traversalPredicate, canTraverse }) => ({
        assertion: structuredClone(record), fromEntityId: traversalFrom, neighborEntityId: neighborId,
        traversalPredicate, canTraverse, evidence: assertionEvidence(record.id, evidenceByAssertion, sourcesById),
        trust: { authority: 'data_only' },
    }));
    const entities = retrievalEntityIds.map(id => {
        const person = projectPerson(store, id);
        return { id, type: entityById.get(id).type, isSelf: id === store.self_person_id,
            preferredName: person?.preferredName ?? null };
    });
    return {
        seedEntityIds, entities, assertions, relations,
        metadata: { storeId: store.store_id, revision: current.revision, digest: current.digest,
            statuses: query.statuses, ignoredSeedCount, truncated: { seeds: seedTruncated,
            neighbors: neighborsTruncated,
                relations: relationTruncated, assertions: assertionTruncated } },
        trust: { authority: 'data_only' },
    };
}

/** Repository-neutral adapter. It requires only the repository snapshot reader;
 * the supplied backend may be JSON today and indexed storage later. */
export function createMemoryRetriever({ readSnapshot, now = () => new Date().toISOString() } = {}) {
    assertExactObject({ readSnapshot, now }, ['readSnapshot', 'now'], 'retriever');
    if (typeof readSnapshot !== 'function' || typeof now !== 'function') throw new TypeError('memory_retriever_invalid');
    return Object.freeze({
        async resolveEntityMentions(text, options) { return resolveEntityMentions(text, await readSnapshot(), options); },
        async retrieveCandidates(query) { return retrieveCandidates(await readSnapshot(), query); },
        async currentKnowledge(query) {
            const validTime = validateNow(now());
            return atTime(await readSnapshot(), query, validTime, ['active'], true);
        },
        async knowledgeValidAt(query, validTime) {
            return atTime(await readSnapshot(), query, validTime, ['active', 'superseded']);
        },
        async history(query) {
            const candidates = retrieveCandidates(await readSnapshot(), queryWithStatuses(query, ['active', 'superseded']));
            return { ...candidates, metadata: { ...candidates.metadata, temporalModel: 'valid_time_only',
                bitemporal: false, historyMeaning: 'known_validity_and_supersession' } };
        },
    });
}
