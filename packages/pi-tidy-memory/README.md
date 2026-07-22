# pi-tidy-memory

Long-term memory for [Pi](https://github.com/earendil-works/pi), with a small backend interface and compact tool output. Hindsight is the first backend. More backends can be added without changing the tools or Pi lifecycle code.

> **Experimental.** This package is **not published to npm yet**. The supported day-to-day installation is the immutable source revision below; do not install the moving `main` branch.

## Install

Install the pinned monorepo revision with Pi's git installer, then install this package directory from that clone:

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@069c46fd63a37343e34f758dab7055a85a3ae452
pi install ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools/packages/pi-tidy-memory
```

The full 40-character commit is intentional. `/tidy-memory status` reports the package version and checked-out source revision so the running installation can be compared with this pin.

From an existing local checkout of this repository:

```bash
pi install ./packages/pi-tidy-memory
```

Use `-l` for project-local installs. After the first npm release, the stable install path will be:

```bash
pi install npm:@mobrienv/pi-tidy-memory
```

## Configure Hindsight

Create `~/.pi/agent/pi-tidy-memory/config.json`:

```json
{
  "version": 1,
  "enabled": true,
  "backend": {
    "type": "hindsight",
    "baseUrl": "https://hindsight-api.example.com",
    "bankId": "mobrienv",
    "dynamicBankId": false,
    "apiKeyEnv": "HINDSIGHT_API_KEY",
    "envFile": "~/.config/hindsight/homelab.env",
    "recallBudget": "mid",
    "recallTypes": ["observation", "world", "experience"],
    "asyncRetain": false
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

`apiKeyEnv` names the credential variable. The package checks the process environment first, then the optional `envFile`. It never prints the credential. Inline `apiKey`, `token`, and custom headers are rejected.

Configuration is strict: boolean fields must be JSON booleans, and unknown keys in the top-level, lifecycle, and Hindsight backend objects are rejected instead of being silently ignored.

This integration intentionally uses the single static bank `mobrienv` with `dynamicBankId: false`. Do not add a prefix, granularity, or directory map: changing the resolved ID creates or selects another Hindsight bank rather than migrating the existing one. Confirm `bank=mobrienv` with `/tidy-memory status` before retaining data.

Synchronous retention is also intentional. A successful `retain` result means Hindsight completed the request; pi-tidy-memory does not operate an outbox, poll operation receipts, replay writes after restart, or run a retry service.

Reload Pi after changing the file:

```text
/reload
/tidy-memory check
```

## Tools

- `recall` searches durable memory. Returned text is marked as untrusted historical data so the model does not mistake old content for current instructions.
- `retain` stores one self-contained fact, decision, preference, or lesson. Its prompt guidance limits use to explicit requests or a standing memory policy.
- `reflect` asks Hindsight to answer temporal, causal, or multi-hop questions over retained knowledge.

Each tool renders as one compact line. Expand a result in Pi to inspect recalled memories or reflection detail.

## Automatic memory

Automatic recall fetches once in `before_agent_start`, then injects the result ephemerally through Pi's `context` hook. It is never written into the session transcript. Automatic retain waits for `agent_settled`, reads the settled session branch, strips tool traffic, and saves the final user/assistant exchange. Assistant outcomes marked `error` or `aborted` are not retained.

Both switches default to `false`. A shared runtime guard blocks common token, credential-assignment, bearer-header, and private-key patterns before either manual or automatic retention reaches a backend. This is a narrow leak-prevention check, not a PII classifier. Automatic retention still sends conversation text to the configured backend, so turn it on only after reviewing the privacy boundary and bank scope. Manual tools remain available when automatic behavior is off.

## Diagnostics

```text
/tidy-memory status
/tidy-memory check
```

Status shows the package version, source revision when installed from Git, backend, host, bank, credential-variable presence, and lifecycle switches. Check performs an authenticated `GET` against the active bank's memory-list endpoint with `limit=0`; it returns no memory content and writes nothing. Neither command reveals credentials.

Packed artifacts expose one dependency-light smoke path:

```bash
npm run smoke
```

Run it from the root of an extracted or installed `@mobrienv/pi-tidy-memory` tarball. It verifies the package identity, native Pi adapter entry, shipped source/build files, and revision-status contract without requiring publication or a copy of the monorepo test environment. It does not contact Hindsight or write memory; use `/tidy-memory check` for authenticated read-only integration verification.

## Documentation

- [Architecture and safety](docs/architecture.md) covers the backend seam, ephemeral recall, settled-branch retention, trust boundaries, cancellation, output limits, and failure behavior.
- [Backend guide](docs/backends.md) covers complete Hindsight configuration, bank strategy, retention execution, package selection, and implementing another adapter.
- [Operations](docs/operations.md) covers pinned upgrades, credential-rotation restarts, verification, and rollback.

The interface is intentionally narrow. Bank administration, deletion, migration, and queue management remain backend-specific operational tasks rather than model-facing tools.

## Safety notes

- Recalled memory can be stale or malicious. Verify consequential claims against current files and user instructions.
- Do not retain secrets, credentials, raw tool output, or transient chatter.
- A mistyped Hindsight bank ID creates a separate bank. Check `/tidy-memory status` before retaining data.
- External memory is not rolled back when a Pi conversation is forked or deleted.
