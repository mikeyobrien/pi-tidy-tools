# pi-tidy-memory

Long-term memory for [Pi](https://github.com/earendil-works/pi), with a small backend interface and compact tool output. Hindsight is the first backend. More backends can be added without changing the tools or Pi lifecycle code.

## Install

```bash
pi install npm:@mobrienv/pi-tidy-memory
```

During development, install the local workspace instead:

```bash
pi install ~/projects/pi-tidy-tools/packages/pi-tidy-memory
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
