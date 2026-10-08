# Automatic Memory A — Candidate Detection & Policy

Automatic Memory A is a standalone evaluation and dry-run pipeline:

`untrusted turn text → model proposal → exact-shape/evidence validation → code policy → dry-run result`

It is not wired into `agent.run()`, the CLI loop, tools, MemoryService, or a repository. It cannot write Memory 2. `auto_save` is only a recommendation for a later phase. No disposition writes, authorizes, or schedules work.

## Model proposal and runtime metadata

The dedicated extraction request uses the configured model with strict structured output and an empty tools list. It receives only the input turn text and extraction instructions. It does not receive conversation history, Memory Context, tools, a MemoryService, a repository, or authorization grants. The ordinary conversation request is unchanged.

The proposal schema is closed and bounded. It carries candidate type, textual subject and mentioned-person name, a proposed predicate label, a proposed value, durability, linguistic confidence, assertion mode, temporal hint, update intent, sensitivity hint, suggested disposition, and an exact evidence quote. It has no actor, `direct_user`, authentication, permission, approval, provenance, grant, canonical entity ID, assertion ID, or target-to-replace fields. Unknown fields reject the proposal. The model's confidence, sensitivity and disposition remain untrusted suggestions.

Predicate labels are not persisted directly. A closed category-specific normalizer maps recognized preference, decision, tool, purchase, hobby, professional, situation, and relationship labels to the existing A1 predicate IDs. An incompatible or unknown label for one of these categories is a normalization error; categories without an A1 mapping remain unsupported and cannot become auto-save candidates. This keeps semantic category names separate from the policy's canonical predicate vocabulary.

The validator checks the exact quote against the supplied turn and requires one occurrence. It computes UTF-16 offsets, a SHA-256 of the source text, an opaque ephemeral `dryrun_` turn ID, source class `dry_run_input`, and policy version. These values describe the evaluation input only; A does not claim that an arbitrary dry-run input was authenticated stdin. Runtime input integration is deliberately deferred.

Quotes or nearby external-source cues are conservatively marked quoted/imported. Missing or repeated spans cannot be auto-save candidates. Candidate output and errors do not echo suspected secret material.

## Policy A1

The code computes effective disposition; it does not copy the model's suggested disposition.

- **`ignore`**: suspected credentials/recovery codes; ephemeral or non-durable content; unasserted, hypothetical, negated, conditional, questioned, inferred, or quoted/imported content; missing or ambiguous evidence; unsupported candidate type/predicate; low linguistic confidence; exact active duplicates. An explicit negative preference is eligible only when the candidate preserves its negative polarity; a candidate that drops the negation is rejected.
- **`ask`**: sensitive or unknown categories; uncertain temporal scope; a person that is absent, partial, ambiguous, or otherwise unresolved; facts about third parties; correction/supersession proposals; unsupported relations; conflicts or contradictions that need review; missing project subject.
- **`auto_save`**: only an explicit, uniquely evidenced, durable, high-confidence, low-risk proposal whose type and predicate are on the initial allowlist, whose subject is Self or a textual project/workstream decision, and which is not a duplicate or unresolved conflict. A project/workstream subject is textual evidence only; it does not establish or link a canonical project identity. A bounded decision such as pausing work until a stated condition is met can be eligible when both the explicit decision and exact end condition are evidenced. This is a dry-run recommendation only. An addition may receive this recommendation without selecting any old assertion as a replacement target.

Initial low-risk allowlist: stable preference (`user.preference`), project decision (`project.decision`), tool/software/device use (`user.uses_tool`), relevant purchase/ownership (`user.owns_item`), hobby (`user.hobby`), general professional context (`user.professional_context`), and low-risk situation (`user.situation`). This is a conservative A1 evaluation policy, not the final product policy.

Health, personal finance, precise location, identity documents, intimate information, minors, credentials, and other/unknown sensitive classes never auto-save. Sensitive non-secret candidates are recommended `ask`; detected secrets and credential-like values are `ignore`. The deterministic secret screen was extended to catch labeled short credential values and recovery/backup/one-time codes. Pattern screening is defense in depth and not proof that every possible secret format is recognized.

## Entity resolution, duplicates, and updates

The model supplies only names. With a supplied synthetic schema-v4 snapshot, policy uses the pure C.1 exact mention resolver and C.1 structured retrieval. Exact unique Person matches can be displayed as resolution results; partial, absent, or ambiguous names never select an entity. Third-party facts remain `ask` under A1. Without a snapshot, person resolution is unavailable and cannot become an auto-save recommendation.

Exact active duplicates are recommended `ignore`. A different value in a matching predicate is treated conservatively as a possible conflict unless the proposal explicitly says it is an addition. A correction or supersession is always `ask`; A never chooses a target assertion and never emits a `supersedes` ID. The existing `MemoryService.remember()` may supersede an active record in the same slot, so phase B must design explicit append-versus-replace semantics before any automatic persistence is connected.

Project decisions do not have canonical project entities in the current schema/resolver: schema v4 supports canonical `person` entities only. A clear project or workstream name may therefore be represented in a dry-run proposal as `textual_only` with `entityId: null`. The resolver cannot determine whether such a name refers to an existing project, distinguish a known project from an unknown one, or link the decision to a project record. Multiple explicit project names, a missing subject, an ID-shaped subject, or an unclear decision remain unresolved/review cases. No project entity or canonical ID is created.

## No-write boundary and evaluation

The detector accepts only an injected extraction function; the policy accepts validated candidate values and an optional read-only snapshot envelope. Neither accepts a repository/service/authorization object. Their import graph excludes Agent, direct-user input, authorization, MemoryService, and repository modules. The evaluation harness clones and freezes a synthetic snapshot and compares its digest before and after policy evaluation. It produces in-memory results only. There is no persistent log of ignored/rejected candidates and no personal-store access in A.

The direct-user capability from A.2/A.3 is not passed to the model or generated by A. Because the extractor is not connected to an authenticated runtime turn, its output cannot authorize anything. A future phase must establish a distinct automatic-persistence authorization path bound to the real runtime turn, policy result, exact operation, service recipient, and one-use lifetime. It must not reuse model fields or the string `direct_user` as proof.

The local evaluation CLI is offline unless `--live` is supplied. Only its live path loads the project `.env`; it runs the fixed synthetic corpus, sequentially, with at most 50 calls and a bounded output-token limit. It rejects the run before the first request if a test-secret example is not screened locally. It reports numeric provider usage when present and stops if usage is unavailable. The USD 0.50 amount is a conservative preflight/stop estimate, not an account-level billing cap; only provider billing controls can impose a hard monetary limit. No candidate results are written to disk.

## Real evaluation results

The latest manual evaluation used 40 synthetic cases and made 37 model calls; three credential-like examples were screened locally and blocked before transmission. It produced 39/40 correct outcomes, with zero false `auto_save`, zero extraction errors, and zero normalization errors. The only incorrect outcome was a false `ignore` for `negation_coffee`: the model's candidate did not preserve the source sentence's negative preference polarity. The deterministic policy correctly rejected that mismatched candidate rather than saving a polarity-inverted or unsupported fact. This is a detector proposal-quality miss, not a policy safety failure. The other 39 cases matched their expected classifications.

This evaluation was still dry-run. The detector was not connected to the conversational agent or a write-capable service, no candidate was persisted, and no real personal data or secrets were used. The 40-case result measures this synthetic corpus and does not establish general accuracy or guarantee detection of all secret formats.

## Deliberate limits for B

- No MemoryService writes, automatic grants, ask prompts, agent integration, or persistent candidate audit.
- No schema change; schema v4 already has inferred evidence and confidence fields, temporal precision, and supersession references. Current service methods hardcode explicit evidence, so phase B must preserve the difference between explicit user assertions and model-derived extraction.
- B must separately design safe automatic authority, source/turn references, deduplication, append-versus-replace behavior, correction target review, and sensitive-data policy before enabling persistence.
- A has no real stdin/runtime provenance and no personal Memory 2 store; all stateful tests use synthetic snapshots and fake extractors.
- Real results are limited to one synthetic 40-case evaluation. The negative-preference miss shows that model extraction can omit polarity; policy correctly fails closed. Project decisions can be represented only as `textual_only` until a later phase adds a canonical project model and resolver.
