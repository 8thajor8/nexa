import { canonicalSubject, eligibleNameAssertions, normalizeEntityName, projectPerson } from './entities.js';

/** Read-only, snapshot-bound result. Partial matches are clarification candidates
 * only. A unique partial match never resolves. No caller-provided trust labels.
 */
export function resolveEntities(current, { text, limit = 10 }) {
    const query = normalizeEntityName(text);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new TypeError('memory_resolution_invalid');
    const names = eligibleNameAssertions(current.snapshot);
    let matching = names.filter(record => normalizeEntityName(record.object.value) === query);
    const match = matching.length ? 'exact' : 'partial';
    if (!matching.length) matching = names.filter(record => normalizeEntityName(record.object.value).startsWith(query + ' '));
    const ids = [...new Set(matching.map(record => canonicalSubject(record.subject, current.snapshot).id))].sort();
    const status = ids.length === 0 ? 'not_found' : ids.length > 1 ? 'ambiguous'
        : match === 'exact' ? 'resolved' : 'insufficient_evidence';
    return { status, match: ids.length ? match : null, entityId: status === 'resolved' ? ids[0] : null,
        candidates: ids.slice(0, limit).map(id => ({ person: { id, preferredName: projectPerson(current.snapshot, id).preferredName,
            isSelf: id === current.snapshot.self_person_id },
            matchedAssertionIds: matching.filter(record => canonicalSubject(record.subject, current.snapshot).id === id)
                .map(record => record.id).sort().slice(0, 10) })),
        total: ids.length, truncated: ids.length > limit, storeId: current.snapshot.store_id,
        revision: current.revision, digest: current.digest, trust: { authority: 'data_only' } };
}
