# Memory 2 B.1: Entities, People and Self

Memory 2 is the product name; its persisted format is now schema 4. Schema 1,
schema 2, schema 3 and unknown versions are rejected explicitly, including when
they lack the new fields. There is no automatic schema upgrade or entity inference. The
personal file remains `data/memory-v2.json`, ignored by Git. Default configuration
still selects Memory 1. This implementation does not provision a personal store.

## Identity and data

The same store contains `entities`, with records `{ id, type, created_at }`.
Only `person` is supported. IDs use generated `person_<uuid>` identifiers, never
names. Future types require explicit validators rather than free-form properties.
Entity type and creation time are immutable; deletion and merges are unsupported.

`self_person_id` is a required root reference to one existing Person. Initializing
a new store explicitly creates exactly one anonymous structural Person and no
assertions, sources or evidence. This is empty of personal knowledge. Reopening
preserves the same ID. No normal commit operation changes the root reference.
Self has no permissions or authentication significance.

`{type:"owner"}` and the explicit entity subject of self compare as the same
subject for deduplication, supersession, queries and compatibility-slot deletion.
`unspecified` remains unspecified. Authorization still binds the exact original
request; equivalence is applied inside the service, never to accept a substituted
grant payload. Every explicit entity subject, including historical assertions,
must reference an existing entity of the correct type.

Names are assertions, with ordinary sources/evidence and no duplicate metadata:

- `entity.preferred_name`: one active value per canonical subject.
- `entity.alias`: multiple active values, keyed by normalized value per subject.

Both predicates require `kind: "fact"`, no compatibility slot and null validity
bounds in B.1. An equivalent normalized alias is a no-op; different aliases do
not supersede one another. Renaming retains superseded history but never creates
an alias of the old name. Names are limited to 200 Unicode code points. Empty,
ill-formed, control and format-character names are rejected. Secret screening
applies to the original text before persistence.

## API and explicit terminal commands

MemoryService exposes `createPerson(request, grant)`, `getPerson({id})`, `getSelf()`
and `resolvePerson({text})`, alongside remember/forget/find/getById. Person views
derive `{id,type,createdAt,preferredName,aliases,isSelf}` from the current snapshot.
Names backed by explicit user-statement evidence are eligible for projections
and resolution. Imported or inferred assertions do not establish canonical names.
An explicit remember can supersede an ineligible name with newly authorized
evidence; deduplication does not silently promote its old provenance.

Creation syntax, using fictional data:

```text
/person create {"preferredName":"Synthetic Rowan","allowDuplicate":false}
```

The real stdin boundary parses this exact request. `authorizePersonCreation`
consumes its opaque proof and creates a one-use `create_person` grant bound to
the request, service and live turn. Creation atomically persists Person, initial
preferred-name assertion, source and evidence. Existing exact name/alias matches
produce ambiguity unless the same explicit request includes `allowDuplicate:true`.
That flag intentionally creates a distinct person; it never merges. Partial
matches do not establish identity. UUID collisions abort rather than update.

Rename/add-alias use the existing structured `/remember <JSON proposal>` command
with the exact entity ID and reserved predicate. There is no model extraction,
implicit alias generation or new model-facing write tool. Ordinary agent.run,
tool output and memory content cannot produce grants. A note grant cannot create
a Person or mutate an alias. Changing any field after authorization invalidates
the grant. Input is copied before asynchronous work.

`/forget assertion <id>` removes a name/alias and its evidence under the existing
policy. The entity remains, potentially anonymous; self always remains. Forgotten
names are absent from subsequent projections, resolution and rebuilt context.
There is no name index or cache to purge. Only successful deletion emits context
invalidation. Historical names never resolve, even when retained by supersession.

## Resolution

Normalization is NFC, trim, collapsed spaces and locale-independent lowercase,
followed by NFC. Accents, meaningful punctuation and script distinctions remain.
Changing these rules later requires an explicit compatibility decision.

Exact eligible preferred-name and alias matches are unioned and deduplicated by
entity ID. One ID resolves; multiple IDs are ambiguous. When there are no exact
matches, complete leading words may produce clarification candidates only:
one is `insufficient_evidence`, multiple are `ambiguous`, none is `not_found`.
For example, Juan Pérez and Juan García queried as Juan are ambiguous. Even one
Juan Pérez never resolves from Juan without an explicit alias.

Results include status, match kind, total, truncated flag, bounded candidates,
storeId, revision and digest. Candidate truncation never turns ambiguity into a
unique resolution. A caller must revalidate snapshot identity before using an
old result; resolution is read-only and confers no mutation authority. B.1 write
commands identify their exact subject directly, with repository revision/digest
checks. No probabilistic matching, embeddings or merges are present.

## Context and future boundaries

The existing bounded assertion context remains data_only; owner subjects are
presented as their canonical entity reference. The provider does not dump the
entity collection or add names to system instructions. No new retrieval system
is introduced. Existing budgets, history reset and forget invalidation remain.

Contacts/Communications may later explicitly reference `(store_id, person_id)`.
Provider labels, email addresses and phone numbers are channel data, not Person
identity or proof for merging. Shared contacts need not map to one person. Future
Identity may link an authenticated provider principal to this reference without
granting permissions by the link itself. No changes to Communications, Calendar,
WhatsApp, Speech or Permissions are included. `speech/voice-identity.js` processes
Nexa's output audio; it does not identify/authenticate speakers.

The existing Memory 1 migration utility remains an explicit offline operation.
Its synthetic validation skeleton uses the current schema, without creating entities from
legacy person text. The only empty destination permitted has revision zero, only
the structural self and no knowledge/receipts. This is not a schema-upgrade migration
and does not run during initialization or normal runtime.
