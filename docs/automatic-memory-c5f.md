# Automatic Memory C.5f — Trusted speaker identity

## Status

C.5f adds a runtime-owned identity contract for direct local turns. It does not
enable automatic learning, persist a Self binding, grant memory-write authority,
or activate Memory2. The CLI continues to disable Automatic Memory assessment.

## Trust and identity contract

`readDirectUserTurn()` is the only issuer of the speaker proof. It reads the real
process `stdin` line and binds an opaque `WeakMap` capability to the recipient,
runtime session, unique turn, and SHA-256 of the original text. The proof is
consumed on the first resolution attempt and expires on the next turn, EOF, or
session close. Strings, object-shaped values, model output, tool output, and
entity IDs cannot stand in for it. Agent composition keeps the capability out
of model and tool inputs.

The Windows principal adapter reads the process account SID through an absolute
`SystemRoot\System32\whoami.exe` path with shell execution disabled and bounded
execution. Its result is explicitly `os_account_session_unverified`: the SID
identifies an account context, not the person at the keyboard.

The current Node CLI has no trusted HWND/native WinRT host for a Windows Hello
user-consent prompt. Accordingly, the production Hello provider always returns
`unavailable`; it does not infer authentication from Hello availability, the
Windows account, a PIN, or biometric configuration. The relevant Windows APIs
require a platform UI host; see [Windows Hello](https://learn.microsoft.com/en-us/windows/apps/develop/security/windows-hello) and
[RequestVerificationForWindowAsync](https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync).

Self binding is represented by an exact record linking a Windows principal to
the repository's structural `self_person_id`, marked active or revoked and
tagged with the verification method and timestamp. The store in this stage is
volatile only. The application does not load a real Self ID, create a real
binding, or persist binding data. Linking and revocation therefore fail closed
in the default CLI composition. A future native Hello UI and an approved durable
binding store are prerequisites to real binding operations.

`createTrustedSpeakerIdentityBoundary()` permits provider injection only while
running under Node's test runner (`NODE_TEST_CONTEXT`). Outside that test
environment it accepts only the fail-closed production providers. The
application singleton does not accept injected dependencies from `createAgent`,
the assessment boundary, the model, or tools. Even a test boundary uses the
fixed real-stdin proof consumer and fixed direct-confirmation consumer; no test
seam can issue or verify turn/confirmation capabilities from caller data.

## Identity-to-authorization handoff (C.5f.1)

The identity resolver returns an opaque, non-authorizing context only after
consuming a valid stdin speaker proof. The automatic-memory policy can use that
context to resolve Self for a candidate, and returns the opaque context only to
the internal assessment caller; the formatter emits neither it nor its fields.
The context is not an authorization and cannot reach the model or tools.

Before B.2b can prepare an operation, its coordinator consumes this context
once while the original source turn is still active. It rechecks the exact
recipient, session, turn, source-text hash, active Windows Hello binding, and
the structural Self ID from the supplied validated snapshot. It then computes
the canonical ADD/REPLACE plan and binds the private identity record to the
operation, candidate, snapshot revision/digest, and exact REPLACE target. A
separate trusted stdin confirmation is still required. The resulting B.2b
grant carries both bindings privately; the repository consumes the grant once
under lock, rechecks that the binding remains active and still matches the
store's Self ID, then applies the operation. Revocation between confirmation
and persistence therefore rejects the write and burns that grant.

Identity handoff and write authorization are separate one-use proofs. A failed
handoff attempt burns the identity context and requires a new direct-user turn.
A consumed write grant cannot authorize another mutation. The persistent
operation fingerprint remains content/snapshot based so identical applied
operations converge to the same receipt; the opaque grant separately binds the
source principal/session/turn and confirmation turn. The identity binding hash
is private to the live coordinator grant and is not written into the receipt.

The synthetic pre-verified principal and Self binding used by B.2b integration
tests lives only under `test-support/`; it starts with the real stdin-issued
capability, is guarded by the Node test-runner environment, and is never
imported by `src/`. It does not create a real link or change the production
providers. The production Windows Hello provider remains
fail-closed, the application has no real Self binding or persistent binding
store, and the CLI assessment hook remains disabled. No automatic writer is
connected to the agent or tools.

## Policy integration

Automatic Memory policy resolves `Self` only if all of these agree:

- the opaque identity capability was issued by the trusted boundary and is
  consumed once while its source turn remains current;
- the turn's exact original-text hash matches the candidate runtime metadata;
- the Windows account principal has an exact active binding;
- the binding points to the `self_person_id` in the validated snapshot;
- the model's role label is within the existing closed first-person vocabulary.

The model role label is only a consistency check. It never authenticates the
speaker or selects an entity ID. Third-party mentions keep their conservative
review behavior. With no binding, stale/mismatched context, an invalid binding,
or a revoked/ambiguous record, Self remains unresolved and policy returns
`ask`.

The pure persistence planner still cannot resolve Self from text alone. The
authorized B.2b coordinator has a separate internal route that first consumes
the opaque handoff above, then runs the same deterministic policy and planner
with that verified context. Neither `subject_text: "user"` nor a model/tool
entity ID is sufficient. `auto_save` remains a recommendation and is not
consent or write authorization.

## Tests and limitations

Synthetic child-process tests use actual stdin input to exercise opaque proof
issuance, active-turn binding, the identity-to-authorization handoff, and the
separate B.2b confirmation. Revoked, malformed, missing, altered, stale, or
replayed identity contexts fail closed. B.2b integration tests use temporary
repositories only. Separate tests verify the SID adapter's command boundaries
and the production Hello provider's fail-closed behavior.

No test invokes OpenAI or MemoryService. B.2b integration tests exercise the
real repository writer only against temporary synthetic stores. The injected
Hello/binding providers in unit tests model already-verified host state; they
are not Windows authentication tests. The default application
cannot establish a real binding until native Hello UI and durable binding
storage are separately designed and reviewed. A local Windows session remains
unverified, and Windows Hello alone would not grant permission to write memory.

Memory1 remains the active backend. Memory2 remains inactive and personal data
has not been migrated or modified.

## Future architecture requirements: multi-user identity and per-person memory

These are future requirements only. They do not change the current single-owner
`self_person_id` contract, create bindings, or authorize access:

- Nexa should support multiple authorized users, initially Jorge and potentially
  Coti. Each person needs a stable identity and correctly attributed memories.
- Voice speaker recognition may help identify a speaker, but is not sufficient
  authentication by itself.
- The system must distinguish the speaker, the subject of a memory, and the
  person who contributed the information.
- Personal, private, and shared memories need explicit, separate access rules.
- Each user needs their own permissions for tools, applications, and data.
- Identity and permissions must work across different devices and sessions.
- Any owner/Self model change must first be checked against Memory2's schema,
  repositories, assertions, and existing single-owner behavior. Do not redefine
  `self_person_id` globally as part of this stage.
