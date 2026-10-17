// Persisted predicate names and their meanings are stable. Add entries; do not
// silently change an existing entry's endpoint types or truth semantics.
const definitions = {
    partner_of: Object.freeze({
        subjectTypes: Object.freeze(['person']), objectTypes: Object.freeze(['person']),
        symmetric: true, inverse: null, allowSelf: false, cardinality: 'many',
    }),
    personal_relationship_of: Object.freeze({
        subjectTypes: Object.freeze(['person']), objectTypes: Object.freeze(['person']),
        // The edge points from the store owner to the other person; the type
        // label is interpreted from the owner's point of view (e.g. "hijo").
        symmetric: false, inverse: null, allowSelf: false, cardinality: 'many',
        requiresRelationshipType: true,
        ownerSubject: true,
    }),
};
export const RELATION_PREDICATES = Object.freeze(definitions);
export function getRelationPredicate(predicate) {
    return Object.hasOwn(RELATION_PREDICATES, predicate) ? RELATION_PREDICATES[predicate] : null;
}
