# Memory 2 C.1: Structured Retrieval Foundation

C.1 adds a read-only candidate layer over schema 4. It does not replace the
bounded context sent by the agent, decide final prompt contents, rank relevance,
interpret valid time, or write Memory. The API returns snapshot revision and
digest so later stages can detect stale candidates.

`createMemoryRetriever({ readSnapshot })` depends only on the repository snapshot
reader. Its `resolveEntityMentions(text)` and `retrieveCandidates(query)` methods
are backend-neutral; the current reader scans the JSON snapshot. MemoryService
exposes those methods for internal callers and accepts no authorization grant for
either operation.

Mention matching uses eligible explicit preferred-name and alias assertions,
existing NFC/case/whitespace normalization, and Unicode word boundaries. Exact
matches inside a sentence resolve only when the overlapping name candidates
identify one entity. Ambiguous overlaps return candidate IDs without selecting
one. Complete leading-word matches are clarification-only. No fuzzy matching,
model-generated ID, or partial match can resolve an entity.

Retrieval receives verified entity IDs, an optional explicit self seed, an
optional predicate filter for direct assertions, registered relation predicates,
statuses and bounded limits. Relations are collected where a seed is an endpoint.
Only registry-approved traversal direction is used to fetch adjacent-entity
assertions. Traversal is one relation hop and never recurses from neighbors.
Symmetric edges are deduplicated by assertion ID. Output includes minimal entity
projections, assertion/Relation records, their evidence and source, and the
original status, validity, recorded time and supersession metadata. No temporal
interpretation is applied; both statuses are returned unless the query narrows
them.

Default limits are five seeds, depth one, eight neighbors per entity, ten
relations, twenty assertions and three assertions per entity/predicate. Callers
may lower these limits but cannot raise them in C.1. Results are ordered by
stable IDs and predicate values rather than JSON array order. Every result is
`data_only`; provenance is preserved but never becomes instruction authority,
authentication, or permission.

The existing MemoryContextProvider and agent prompt behavior remain unchanged.
Selective assembly, temporal current/valid-at/history semantics and ranking are
reserved for later C phases. Forget remains physical deletion, so forgotten
records are not returned by retrieval.
