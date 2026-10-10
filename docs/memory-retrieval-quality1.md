# Memory Retrieval Quality 1

## Audit and change

Before this batch, `retrieval.js` selected current or historical candidates using entity orientation, status, relation scope, temporal validity, evidence confidence, predicate/ID ordering, and hard caps. `context-provider.js` then preferred direct entity facts over relations and neighbor facts, followed by temporal certainty, evidence confidence, recency within a predicate, and stable IDs. It did not use the current message's topic terms in candidate selection or ranking. Since candidate caps were applied before context assembly, a lexically earlier predicate or low-relevance record could occupy a limited slot before a later, on-topic fact was considered.

The synthetic Schema v5 benchmark includes programming preferences, hobbies, projects, relationships, historical/current employment, an exact duplicate, mixed-topic queries, a follow-up, and an ambiguous person mention. Expected records were labeled before measurement. The baseline reproduces the previous stable ranking over the same candidate set; the corpus stays below retrieval caps so the candidate set is unchanged by the ranking signal. Precision@5 and Recall@5 are macro-averaged over answer-bearing queries; MRR uses the first relevant result for those same queries. Ambiguous queries with no safely resolved subject are excluded from these three averages and separately assert that no context is returned.

| Metric | Baseline | After |
| --- | ---: | ---: |
| Precision@5 | 0.143 | 0.200 |
| Recall@5 | 0.643 | 0.857 |
| MRR | 0.429 | 0.714 |
| Superseded records in current-query top 5 | 0 | 0 |
| Exact duplicate groups in final top 5 | 0 | 0 |

These figures describe a small, hand-labeled synthetic fixture. They are reproducible regression measurements, not estimates of model or production retrieval quality. The benchmark verifies that an exact duplicate encountered in context is represented once and its compact evidence is combined, subject to the existing evidence and character budgets.

## Ranking behavior

Retrieval now accepts an optional bounded `relevanceText` on its structured query. The Context Provider supplies the current user message, or the most recent bounded user message when the existing continuity logic has safely oriented a follow-up. A deterministic Unicode-normalized token overlap score compares at most 64 unique query terms with assertion predicates and text values. Predicate matches receive a stronger lexical weight than value matches. A fixed stop-word list limits common function words. This score breaks ties after direct-seed priority and temporal certainty, and before evidence confidence and stable ordering; the same score is used before retrieval caps so relevant assertions are not discarded first.

The existing outer contracts are unchanged: `createMemory2ReadOnly({ repository })`, `openExistingMemory2Reader({ storePath })`, `readContext({ message, recentUserMessages })`, and `{ revision, digest, generation, items }`. `authority: "data_only"`, bounded output, and the untrusted-data policy remain unchanged. Exact duplicate assertions are collapsed only in the returned context when subject, predicate, object, status, validity interval, and temporal classification all match. Their compact evidence is combined without changing stored records. If the combined projection would exceed the context budget, it is omitted conservatively and the budget truncation flag is set.

## Limits

This is lexical matching, not semantic search: synonyms, paraphrases, implicit topic changes, and multilingual stemming are not inferred. The current explicit-entity/Self orientation rules still decide whether retrieval is attempted; query relevance does not resolve ambiguous identities or broaden the selected graph. Direct-seed facts remain ahead of relation and neighbor facts even when the latter have stronger term overlap. Temporal filtering continues to use D.1, and superseded records remain excluded from current knowledge.

Distinct assertions are deduplicated in the presented context only when their stored structured values and temporal state are exactly equivalent. This does not consolidate storage or resolve contradictions. Retrieved values remain untrusted data with `authority: "data_only"`; relevance does not confer authority, identity, consent, or permission. No writer, agent behavior, backend selection, or persistent store was changed by this batch.
