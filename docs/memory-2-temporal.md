# Memory 2 C.2: Temporal Semantics

C.2 adds read-only valid-time operations over the existing schema-4 retrieval
result. It does not change the context provider or agent prompt. `recorded_at`
remains provenance metadata; it is never used to reconstruct the store as known
at an earlier transaction time. Results explicitly identify this as a
valid-time-only model, not bitemporal history.

`currentKnowledge(query)` reads the repository clock, considers active assertions
and relations, and returns definitely valid records in `assertions` and
`relations`. Records whose date precision leaves the present uncertain appear
in `indeterminateAssertions` and `indeterminateRelations`. An active assertion
with both validity endpoints absent remains current under its active lifecycle
status, but this does not establish its validity at an arbitrary historical
date.

`knowledgeValidAt(query, validTime)` accepts one schema-4 temporal value with
year, month, day, or instant precision. It returns definitely valid items in
`assertions` and `relations`, and possible-but-undetermined items in the
corresponding `indeterminate*` arrays. Definitely invalid items are omitted.
Intervals include both endpoints. A single absent endpoint is an open bound;
when both endpoints are absent, the schema cannot distinguish an unbounded
interval from unrecorded temporal knowledge, so a valid-at query is
indeterminate. No precision is added to stored or queried values.

For a partial boundary overlapping a finer query, validity is indeterminate.
For example, a year-precision start in 2024 cannot establish whether a fact was
valid on a particular day in March 2024. The same fact is definitely valid on
a day in 2025. A day-precision inclusive boundary is certain for a day query
covering that day, but remains uncertain for an instant within that day.

`history(query)` returns active and superseded assertions/relations using the
existing deterministic retrieval ordering, including evidence and source
provenance. It preserves each assertion's validity fields and status. It does
not infer an earlier `valid_to` or later `valid_from` from supersession or
`recorded_at` and does not claim to answer what Nexa knew at a past time.

All temporal results preserve snapshot revision/digest and `data_only` trust.
The operations do not write, create grants, authenticate, execute retrieved
text, or change MemoryContextProvider behavior. Forget remains physical
deletion; forgotten records and their evidence/source records cannot be
reconstructed by temporal history.
