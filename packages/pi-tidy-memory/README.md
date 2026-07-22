# pi-tidy-memory

Long-term memory for [Pi](https://github.com/earendil-works/pi), with a small backend interface and compact tool output. Hindsight is the first backend. More backends can be added without changing the tools or Pi lifecycle code.

## Compatibility

- Node.js `>=22.19.0`
- `@earendil-works/pi-coding-agent` `>=0.80.6 <0.81.0`
- `@earendil-works/pi-tui` `>=0.80.6 <0.81.0`
- Hindsight `0.8.x` REST API

The package is ESM-only; CommonJS consumers must use dynamic `import()`. The Pi packages are peer dependencies and must match the Pi host. Test upgrades against the exact Pi version that will load the extension.

## 1.x stability contract

The documented `recall`, `retain`, and `reflect` tools, `/tidy-memory` command,
configuration schema and safe defaults, extension entry point, and
`MemoryBackend` / `BackendFactory` integration seam are stable throughout 1.x.
Renaming them, making optional configuration required, weakening safe defaults,
or changing backend semantics requires a new major version. Additive optional
backends, diagnostics, and visual refinements may ship in minor or patch
releases when they preserve those contracts.

## Install

Install the stable npm package:

```bash
pi install npm:@mobrienv/pi-tidy-memory
```

For a reproducible deployment, pin an exact published version in the package source and record it in the installation receipt described in [Operations](docs/operations.md):

```bash
pi install npm:@mobrienv/pi-tidy-memory@<version>
```

Use `pi update --extension npm:@mobrienv/pi-tidy-memory` for an intentional upgrade and `pi remove npm:@mobrienv/pi-tidy-memory` to remove the package.

### Pi-managed Git install

Install the reviewed monorepo commit with Pi's Git installer, embed that checkout's immutable revision, then install this package directory from the managed clone:

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@<verified-full-commit>
cd <pi-managed-checkout>
npm run revision:embed --workspace @mobrienv/pi-tidy-memory
pi install ./packages/pi-tidy-memory
```

Locate the checkout path reported by the Pi installer; do not assume Pi uses the same managed-package directory on every host.

The full 40-character commit is intentional. The source repository cannot truthfully contain its own final commit hash; the reviewed release or installation receipt supplies the pin. `/tidy-memory status` reads the generated `source-revision.json` shipped with the package without invoking Git. The supported static-bank configuration also performs no Git probing at startup. Optional dynamic routing with project scope may inspect local Git metadata but does not contact a remote.

### Existing checkout or explicit local path

From an existing checkout of the reviewed commit:

```bash
npm run revision:embed --workspace @mobrienv/pi-tidy-memory
pi install ./packages/pi-tidy-memory
```

Pi can also load an explicit local path listed in its `packages` settings. That path is operator-managed rather than pinned by a moving source directory: build and smoke an exact artifact, preserve the previous package and configuration, replace the active directory while automatic retention remains disabled, and verify the embedded revision before enabling writes. Follow [Operations](docs/operations.md) for the staged procedure and receipt format.

Use `-l` for project-local installs.

## Configure Hindsight

Create `~/.pi/agent/pi-tidy-memory/config.json`:

```json
{
  "version": 1,
  "enabled": true,
  "backend": {
    "type": "hindsight",
    "baseUrl": "https://hindsight-api.example.com",
    "bankId": "your-bank-id",
    "dynamicBankId": false,
    "apiKeyEnv": "HINDSIGHT_API_KEY",
    "envFile": "~/.config/hindsight/hindsight.env",
    "recallBudget": "mid",
    "recallTypes": ["observation", "world", "experience"],
    "asyncRetain": false
  },
  "provenance": {
    "user": "your-user-id",
    "agent": "pi",
    "repository": "owner/repository",
    "source": "pi-tidy-memory"
  },
  "requestTimeoutMs": 15000,
  "lifecycle": {
    "autoRecall": false,
    "autoRetain": false,
    "maxRecallTokens": 1024,
    "maxRetainChars": 16000
  }
}
```

`apiKeyEnv` names the credential variable. The package checks the process environment first, then the optional `envFile`. It never prints the credential. Inline `apiKey`, `token`, and custom authorization headers are rejected.

Configuration is strict: boolean fields must be JSON booleans, and unknown keys in the top-level, lifecycle, provenance, and Hindsight backend objects are rejected instead of being silently ignored.

For a shared single-user memory, choose one stable bank ID and keep `dynamicBankId: false` across participating agents. Use provenance and tags to distinguish agents, repositories, and subjects inside that bank. Use separate banks when users, authorization boundaries, or retention policies differ. A prefix, granularity rule, directory map, or different ID selects another bank; it does not migrate existing memory. Confirm the expected bank with `/tidy-memory status` before retaining data.

`provenance` supplies metadata defaults for new writes. `agent` defaults to `pi` and `source` defaults to `pi-tidy-memory`; `user` and the canonical `owner/repository` are optional. The extension adds the actual `manual` or `automatic` mode, active Pi session, and timestamp. Automatic writes use the originating user-message time and a document identity derived from Pi's persisted assistant entry. Manual writes use an explicit `occurredAt` when supplied and otherwise use the current time.

Synchronous retention is intentional for the supported single-user profile. A successful `retain` result means Hindsight completed the request; pi-tidy-memory does not operate an outbox, poll operation receipts, replay writes after restart, or run a retry service.

Reload Pi after changing the file:

```text
/reload
/tidy-memory status
/tidy-memory check
```

## Tools

- `recall` searches durable memory. Returned text and bounded provenance (`context`, occurrence time, tags, and metadata) are marked as untrusted historical data so the model does not mistake old content for current instructions.
- `retain` stores one self-contained fact, decision, preference, or lesson. Its prompt guidance limits use to explicit requests or a standing memory policy.
- `reflect` asks Hindsight to answer temporal, causal, or multi-hop questions over retained knowledge.

Each tool requires a bounded, single-line `reasoning` phrase—12 words or fewer,
64 characters or fewer, present tense, no period, and distinct from its query or
content. The rationale is display-only: the extension strips it before any backend
request or durable write.

Each tool renders as a compact two-line why-and-result block. Expand a result in Pi
to inspect recalled memories or reflection detail.

```text
· 🧠 recall restore release context
  deployment preferences → working
🧠 recall restore release context
  deployment preferences → 3 memories
🧠 retain preserve operator preference
  prefer exact release pins → 1 accepted
```

Cards start at Pi's left edge. Line one explains why the call helps; line two shows
its target and outcome. Only active work carries the live dot; settled success and
failure use Pi's native card backgrounds instead of duplicating state with
decorative rails or check/cross glyphs.

## Automatic memory

Automatic recall fetches once in `before_agent_start`, then injects the result ephemerally through Pi's `context` hook. It is never written into the session transcript. Automatic retain waits for `agent_settled`, reads the settled session branch, strips tool traffic, and saves the final user/assistant exchange. Assistant outcomes marked `error` or `aborted` are not retained. Successful automatic retention requires the persisted assistant-entry ID; retries reuse the same backend document identity rather than hashing the exchange text.

Both switches default to `false`. A shared runtime guard blocks common token, credential-assignment, bearer-header, and private-key patterns before either manual or automatic retention reaches a backend. This is a narrow leak-prevention check, not a PII classifier. Automatic retention still sends conversation text to the configured backend, so turn it on only after reviewing the privacy boundary and bank scope. During installation or upgrade, keep automatic retention disabled until the exact artifact and read-only bank access have been verified; then enable it as a separate authorized step with `asyncRetain: false`.

## Diagnostics

```text
/tidy-memory status
/tidy-memory check
```

Status shows the package version, embedded source revision, backend, host, bank, credential-variable presence, and lifecycle switches. Check performs an authenticated `GET` against the active bank's memory-list endpoint with `limit=0`; it returns no memory content and writes nothing. Neither command reveals credentials.

Packed artifacts expose one offline smoke path. Install the tarball into a temporary npm host so its Pi peer dependencies resolve, then run:

```bash
npm run smoke --prefix node_modules/@mobrienv/pi-tidy-memory
```

The smoke verifies package identity, the native Pi adapter entry, shipped source/build files, and the embedded revision-status contract. It does not contact Hindsight or write memory; use `/tidy-memory check` for authenticated read-only integration verification.

## Documentation

- [Architecture and safety](docs/architecture.md) covers the backend seam, ephemeral recall, settled-branch retention, trust boundaries, cancellation, output limits, and failure behavior.
- [Backend guide](docs/backends.md) covers complete Hindsight configuration, bank strategy, retention execution, package selection, and implementing another adapter.
- [Operations](docs/operations.md) covers pinned installation, two-phase activation, receipts, upgrades, credential rotation, troubleshooting, and rollback.
- [Changelog](CHANGELOG.md) records release and unreleased changes.

The interface is intentionally narrow. Bank administration, deletion, migration, and queue management remain backend-specific operational tasks rather than model-facing tools.

## Safety notes

- Recalled memory can be stale or malicious. Verify consequential claims against current files and user instructions.
- Do not retain secrets, credentials, raw tool output, or transient chatter.
- Common credential-shaped values are blocked on retention and redacted from recalled, reflected, and terminal-rendered output; this is defense in depth, not comprehensive secret or PII detection.
- A mistyped Hindsight bank ID creates or selects a separate bank. Check `/tidy-memory status` before retaining data.
- External memory is not rolled back when a Pi conversation is forked or deleted.
