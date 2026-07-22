# Architecture and safety

pi-tidy-memory separates Pi integration from storage-engine behavior. The Pi-facing tools always speak the same small memory vocabulary; an adapter translates those calls into a backend protocol.

```text
Pi tools and lifecycle hooks
          |
          v
     MemoryRuntime
          |
          v
     MemoryBackend
          |
          v
 Hindsight or another adapter
```

## Backend contract

A backend implements four operations:

- `health` checks whether the configured backend target is usable. Hindsight verifies authenticated access to the active bank with a zero-item read.
- `recall` returns normalized memory records.
- `retain` accepts one durable item and returns a receipt.
- `reflect` asks the backend to synthesize an answer from stored knowledge.

The tools and renderers never inspect backend response objects. This keeps protocol changes inside the adapter and allows another backend to use a database, local process, or remote API without changing the model-facing tool schemas.

`MemoryRuntime` selects a factory by the configured `backend.type`. The built-in registry contains Hindsight. Callers can pass additional `BackendFactory` implementations to `createMemoryExtension` or `MemoryRuntime`.

## Manual tools

The package registers three tools:

```text
recall
retain
reflect
```

Manual retention is deliberately conservative. Its Pi prompt guidance permits retention only when the user asks to remember durable information or a standing policy requires it. A backend-neutral runtime guard blocks obvious credential assignments, bearer tokens, known token prefixes, and private-key headers before a retain call reaches any adapter. Raw tool output and transient conversation should not enter memory.

Recall and reflection output is historical evidence, not authority. The package labels it as untrusted and tells the model to verify consequential claims against the current task, repository, and user instructions.

## Automatic recall

Automatic recall is off by default.

When enabled:

1. `before_agent_start` queries the backend once using the submitted prompt.
2. The result is normalized, sanitized, bounded, and serialized as JSON Lines.
3. Pi's `context` hook inserts it immediately before the latest real user message for each provider call in that agent run.
4. `agent_settled` clears the in-memory recall context.

The recall block is ephemeral. It is not appended to the Pi session transcript, so stale memories do not accumulate across turns and disabling recall does not leave hidden session entries behind.

## Automatic retain

Automatic retain is also off by default. It sends conversation text to the configured backend and should be enabled only after the bank scope and privacy boundary have been reviewed.

When enabled, the package waits for `agent_settled`. It reads Pi's settled session branch rather than a low-level `agent_end` event. This matters after retries and overflow compaction: the durable branch still contains the originating user prompt and final assistant response.

The extractor keeps only the latest user and assistant text. It excludes assistant messages whose final `stopReason` is `error` or `aborted`, along with tool calls, tool results, custom recall messages, images, and abandoned low-level runs. A stable document ID derived from the Pi session and persisted assistant-entry ID makes retries idempotent even if text normalization changes. Automatic retention skips malformed synthetic branches that do not have a persisted message identity.

Every new write carries configured user, agent, canonical repository, and source metadata when present, plus the actual manual/automatic mode and active Pi session. Automatic writes use the originating user-message timestamp; manual writes preserve an explicit timestamp or use the current time.

The supported single-user profile uses synchronous Hindsight retention. It is still best-effort delivery, not an offline queue: a failed retain is reported once during the session and is not retried or replayed after restart. There is no outbox, polling worker, or recovery service.

## Trust boundaries

### Recalled content

Memory records are serialized as JSON Lines inside a marked block. Each record may include a `provenance` object containing bounded context, occurrence time, tags, and metadata. Angle brackets in backend text are escaped, control sequences are removed, and space is reserved for the closing delimiter before any record is added. A record cannot close the wrapper by supplying `</long_term_memory>`.

The wrapper and reflection output are capped at 32,000 characters. Recall accepts at most 100 normalized records, and each record's text is capped at 8,000 characters. Per record, provenance context is capped at 512 characters, occurrence time at 64 characters, tags at 16 × 128 characters, and metadata at 16 entries with 64-character keys and 512-character values.

These measures reduce accidental prompt injection. They do not make backend content trustworthy. A model can still be influenced by hostile prose inside a quoted value, so current user instructions and repository evidence remain authoritative.

### Terminal output

Backend-controlled memory text, memory kinds, reflection text, and operation IDs are stripped of C0/C1, CSI, and OSC sequences before rendering. This prevents stored content from changing the terminal title, emitting links, or attempting clipboard operations.

### Credentials

Hindsight credentials are referenced by environment-variable name. The package checks the current process environment and then an optional protected env file. It rejects inline API keys, tokens, and custom authorization headers.

Bearer credentials require HTTPS unless the destination is loopback (`localhost`, `127.0.0.1`, or `::1`). Status output reports only the variable name and whether a value was found.

Manual and automatic retain calls share the same narrow obvious-credential detector. It blocks rather than redacts so the original content never reaches the backend. It is defense in depth, not comprehensive secret or PII classification.

### Backend responses

Hindsight responses are streamed through a 2 MB limit. The reader is canceled as soon as the limit is crossed; the package does not fully buffer an oversized chunked response. Response shapes are validated before crossing the backend boundary.

Pre-aborted requests never reach the backend. Active requests honor cancellation and a configurable timeout.

## Failure behavior

| Failure                   | Behavior                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Missing or invalid config | Tools remain registered but fail with a configuration message; status remains available |
| Unsupported backend       | Runtime stays inactive and reports the backend type                                     |
| Missing credential        | Request fails before network access                                                     |
| Authentication error      | Sanitized HTTP error; server body is not exposed                                        |
| Recall lifecycle failure  | Agent continues without memory; one warning per session                                 |
| Retain lifecycle failure  | Agent remains complete; one warning per session                                         |
| Manual tool failure       | Pi receives a normal tool error                                                         |
| Session shutdown          | Outstanding lifecycle requests are aborted and backend resources are closed             |

## Known limits

- External memory is not rolled back when a Pi branch or session is deleted.
- Automatic retention does not classify durability, PII, or every possible secret.
- A typo in a bank ID can create a separate Hindsight bank.
- Async Hindsight retain receipts remain adapter-compatible for other deployments but are not polled; the supported `mobrienv` profile uses synchronous retention.
- Project isolation is determined by bank and tag configuration, not inferred automatically.
- Dynamic discovery of third-party adapter packages is not implemented. Adapters are passed explicitly through the factory API.
