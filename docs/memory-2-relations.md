# Memory 2 B.2: Relations

Relations are typed assertions in the existing Memory 2 store. They do not form
a parallel graph database and do not introduce a general relation service.
Schema version 4 adds the first explicitly registered predicate,
`partner_of`, to exercise the extensible model. Existing schema versions are
still rejected; there is no automatic upgrade or data migration.

## Persisted shape and registry

A relation is a `kind: "fact"` assertion with `compatibility: null`. Its subject
is an entity reference and its object is `{ type: "entity_reference",
entity_type, id }`. For `partner_of`, both endpoints must be existing `person`
entities. The predicate registry defines endpoint types, symmetry, self-link
policy, inverse and cardinality. Unknown predicates and unsupported endpoint
types fail closed. New predicate semantics require an explicit registry/schema
decision; callers cannot supply predicate metadata.

`partner_of` is symmetric, has no self-links, and allows many partners. The
stored endpoints are ordered by stable entity ID, so A/B and B/A have one
canonical representation. The active duplicate key includes predicate,
canonical endpoints and both validity bounds. Independent periods remain
separate assertions. Creating an equivalent relation is a no-op; creation
never silently supersedes another relation.

Relations keep the ordinary assertion provenance model: explicit direct-user
commands create a `user_statement`, `user_asserted` source and explicit evidence.
The object stores entity IDs, not names or contact data. Entity lookup and
projection are read-only and return `data_only` data. The bounded context
provider serializes the typed object as data alongside assertions; it does not
turn relation text into instructions or authority.

## Commands and authorization

Only actual terminal stdin is parsed by the existing trusted runtime boundary.
The deterministic forms are `/relation create <JSON>`,
`/relation correct <JSON>` and `/relation forget <assertion-id>`. Create and
correct bind predicate, both entity references, validity interval and, for a
correction, the exact superseded assertion ID. Symmetric endpoint order is
canonicalized before authorization comparison. Model output, tool output,
stored memory and imported values cannot mint grants. Relation operations are
not exposed as model tools.

Correction is a separate, explicit operation. It targets one active relation
with the same predicate and at least one shared endpoint. The target is marked
superseded and the replacement, source and evidence are committed atomically;
the replacement links to the exact target. A correction cannot revive or
silently overwrite a different relation. `forget` requires the exact relation
assertion ID, consumes a one-use grant, and removes the assertion plus orphaned
evidence/sources. Entity records remain. Context invalidation is signaled only
after the destructive transaction succeeds.

## Deliberate limits

B.2 provides typed relation creation, correction, query and deletion for the
registered predicate. It does not add automatic inference, fuzzy entity
resolution, relation extraction, semantic retrieval, embeddings, generic graph
traversal, or permission/authentication semantics. The Person identity remains
stable across name changes and relations do not authenticate either endpoint.
The migration utility does not infer relations from Memory 1 text.
