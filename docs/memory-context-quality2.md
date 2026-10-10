# Memory Context Quality 2

## Initial Git diagnosis

The repository was on `main` at `f9f19639e9ad3b97c19edd230c3d34de472ca640`, clean and aligned with the locally recorded `origin/main`. Initially, `git status` failed because the repository path and Git metadata were outside this session's granted filesystem access. After access to this repository was granted, `git status` succeeded and showed no changes. No Git environment variables or `core.bare`/`core.worktree` overrides were set; repository-local `core.bare` was `false`, and `.git` was a directory. No Git configuration, branches, or worktrees were changed.

## Findings and changes

QUALITY1 ranked exact lexical overlap but did not support bounded Spanish/English equivalents. Its continuity path only recognized broad phrases such as “something related to that”; question-shaped follow-ups like “¿Y cuánto costaba?”, “¿Cuál habíamos elegido?” and “¿Cuándo fue eso?” did not inherit a safe anchor from recent user messages. When continuity was accepted, all selected records could enter context even if none matched the current topic, allowing unrelated facts to travel with the answer.

Retrieval now expands a small, explicit vocabulary for price/cost, choice/selection, date/time, and architecture. The expansion is deterministic, bounded, and used only as a ranking signal; it does not infer arbitrary semantic similarity. The existing entity seed ordering and D.1 temporal filtering still occur before relevance ranking. Direct named-entity queries keep their graph results. For a direct Self query, specific lexical matches (or bounded equivalents where no specific term matches) narrow the context when available. For inferred continuity, a recent user turn must be a recognized follow-up chain with one unambiguous entity or Self anchor, and returned records must match topic terms. A non-follow-up intervening turn, ambiguous entity, changed repository digest, or missing anchor ends the chain. Only `recentUserMessages` are examined; assistant text is unavailable to this API and is not inferred.

The Context Provider's public inputs and output remain unchanged. Metadata still carries `authority: "data_only"`; lexical relevance grants no identity, authority, or permission. Memory1 remains the default backend. No writers, stores, Runtime source, UI, or Voice files were changed.

## Conversational benchmark

The new benchmark uses a synthetic Schema v5 store and manually labeled assertion IDs. It covers indirect price and choice wording, user-message follow-ups for price, choice, date, a named person, ambiguous anchors, broken chains, unanchored follow-ups, and topic changes. Answer-bearing scenarios have one manually selected fact as the target; explicit unrelated-record sets and empty-result scenarios count contextual contamination. Precision@5 uses K as the denominator, Recall@5 and MRR are macro-averaged over answer-bearing scenarios, and contamination counts answer cases whose top result is wrong plus no-answer cases that return any context.

| Metric | QUALITY1-style baseline | QUALITY2 |
| --- | ---: | ---: |
| Precision@5 | 0.067 | 0.200 |
| Recall@5 | 0.333 | 1.000 |
| MRR | 0.125 | 1.000 |
| Incorrect-context cases | 3 | 0 |

The baseline reproduces the earlier behavior on the same fixture: exact lexical ranking without the new equivalence vocabulary or question-shaped follow-up resolution. Expected targets were authored separately from the ranking implementation. The corpus is small and synthetic; these numbers demonstrate regression behavior for these cases only, not real-world accuracy.

The existing QUALITY1 benchmark remains a separate direct/topic benchmark. Its most recent run reported Precision@5 0.671 versus 0.743, Recall@5 1.000 in both, MRR 0.929 versus 1.000, and duplicate groups in top five 2 versus 0. These results include the updated synthetic wording needed to make its guitar/instrument continuity example lexically testable. They are not combined with QUALITY2's conversational averages.

## Limits and compatibility

This is not embedding or language-model retrieval. The equivalence lists are intentionally narrow; paraphrases outside them may return no result, particularly for continuity, which fails conservatively. Temporal follow-ups without an explicit date use current-knowledge filtering; this layer does not automatically search expired history. Entity resolution remains the existing exact/partial conservative resolver, and no authentication is added.

The repository/read-only facades, `readContext({ message, recentUserMessages })`, result shape `{ revision, digest, generation, items }`, context budget, exact duplicate projection, and `authority: "data_only"` contract remain in place. No new dependencies or persistent effects were introduced.
