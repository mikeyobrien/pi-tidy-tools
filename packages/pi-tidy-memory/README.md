# pi-tidy-memory

Long-term memory for [Pi](https://github.com/earendil-works/pi), with a small backend interface and compact tool output. Hindsight is the first backend. More backends can be added without changing the tools or Pi lifecycle code.

> **Experimental.** This package is on `main` in [pi-tidy-tools](https://github.com/mikeyobrien/pi-tidy-tools) but is **not published to npm yet**. Tool schemas, config, and adapters may still change before a first release. Prefer a local checkout install and pin to a known commit if you rely on it day to day.

## Install

Install the monorepo with Pi's git installer, then install this package directory from that clone:

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@main
pi install ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools/packages/pi-tidy-memory
```

Other accepted git forms:

```bash
pi install https://github.com/mikeyobrien/pi-tidy-tools@main
pi install git:git@github.com:mikeyobrien/pi-tidy-tools@main
pi install git:github.com/mikeyobrien/pi-tidy-tools@<commit>   # pin experimental builds
```

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
    "bankId": "pi-coding",
    "dynamicBankId": true,
    "dynamicBankGranularity": ["agent", "project"],
    "agentName": "pi",
    "resolveWorktrees": true,
    "apiKeyEnv": "HINDSIGHT_API_KEY",
    "envFile": "~/.config/hindsight/homelab.env",
    "recallBudget": "mid",
    "recallTypes": ["observation", "world", "experience"],
    "asyncRetain": true
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

`dynamicBankId` follows Hindsight's coding-agent convention. The fields in `dynamicBankGranularity` are joined with `::`; the example resolves to `pi::<project>`. Supported fields are `agent`, `project`, `session`, `channel`, and `user`. Project identity uses the Git repository name, and linked worktrees share the main repository bank by default. Unrelated repositories with the same directory name need `directoryBankMap` overrides to avoid sharing a bank. `bankId` remains the static fallback when dynamic mode is off. Optional `bankIdPrefix` namespaces every resolved bank, while `directoryBankMap` can bind absolute directories to explicit bank IDs. Channel and user fields come from `HINDSIGHT_CHANNEL_ID` and `HINDSIGHT_USER_ID`; session comes from Pi's active session.

A newly resolved ID creates a new empty Hindsight bank. Existing static-bank memories are not moved automatically. Confirm the active value with `/tidy-memory status` before retaining data.

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

Automatic recall fetches once in `before_agent_start`, then injects the result ephemerally through Pi's `context` hook. It is never written into the session transcript. Automatic retain waits for `agent_settled`, reads the settled session branch, strips tool traffic, and saves the final user/assistant exchange.

Both switches default to `false`. Automatic retention sends conversation text to the configured backend, so turn it on only after reviewing the privacy boundary and bank scope. Manual tools remain available when automatic behavior is off.

## Diagnostics

```text
/tidy-memory status
/tidy-memory check
```

Status shows the backend, host, bank, credential-variable presence, and lifecycle switches. Check also calls the backend health endpoint. Neither command reveals credentials.

## Documentation

- [Architecture and safety](docs/architecture.md) covers the backend seam, ephemeral recall, settled-branch retention, trust boundaries, cancellation, output limits, and failure behavior.
- [Backend guide](docs/backends.md) covers complete Hindsight configuration, bank strategy, async retention, package selection, and implementing another adapter.

The interface is intentionally narrow. Bank administration, deletion, migration, and queue management remain backend-specific operational tasks rather than model-facing tools.

## Safety notes

- Recalled memory can be stale or malicious. Verify consequential claims against current files and user instructions.
- Do not retain secrets, credentials, raw tool output, or transient chatter.
- A mistyped Hindsight bank ID creates a separate bank. Check `/tidy-memory status` before retaining data.
- External memory is not rolled back when a Pi conversation is forked or deleted.
