# Backend guide

## Hindsight

Hindsight is the first built-in backend. pi-tidy-memory targets the Hindsight 0.8 REST surface and uses native `fetch`; it does not require the Hindsight TypeScript SDK.

### Configuration

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
  "requestTimeoutMs": 30000,
  "lifecycle": {
    "autoRecall": false,
    "autoRetain": false,
    "maxRecallTokens": 1024,
    "maxRetainChars": 16000
  }
}
```

### Fields

| Field                            | Required | Meaning                                                             |
| -------------------------------- | -------- | ------------------------------------------------------------------- |
| `backend.baseUrl`                | yes      | Hindsight API origin, without credentials, query, or fragment       |
| `backend.bankId`                 | yes      | Static bank, used when dynamic mode is off                          |
| `backend.dynamicBankId`          | no       | Derive the active bank from runtime context; default `false`        |
| `backend.dynamicBankGranularity` | no       | Ordered `agent`, `project`, `session`, `channel`, or `user` fields  |
| `backend.bankIdPrefix`           | no       | Safe namespace prepended to static, dynamic, and mapped banks       |
| `backend.agentName`              | no       | Dynamic `agent` value; default `pi`                                 |
| `backend.resolveWorktrees`       | no       | Share the main repository bank across Git worktrees; default `true` |
| `backend.directoryBankMap`       | no       | Absolute directory-to-bank overrides                                |
| `backend.apiKeyEnv`              | no       | Environment variable containing the bearer token                    |
| `backend.envFile`                | no       | Fallback env file read when the process variable is absent          |
| `backend.recallBudget`           | no       | Hindsight retrieval budget: `low`, `mid`, or `high`; default `mid`  |
| `backend.recallTypes`            | no       | Fact types requested from recall                                    |
| `backend.asyncRetain`            | no       | Queue retains in Hindsight; default `false`                         |
| `provenance.user`                | no       | Stable user identity added to new-write metadata                    |
| `provenance.agent`               | no       | Agent identity; default `pi`                                        |
| `provenance.repository`          | no       | Canonical `owner/name` repository identity                          |
| `provenance.source`              | no       | Source identity; default `pi-tidy-memory`                           |
| `requestTimeoutMs`               | no       | Per-request timeout, clamped to 1–60 seconds                        |
| `lifecycle.autoRecall`           | no       | Recall before each submitted Pi request; default `false`            |
| `lifecycle.autoRetain`           | no       | Retain the final exchange after settlement; default `false`         |
| `lifecycle.maxRecallTokens`      | no       | Backend recall token request, clamped to 128–4096                   |
| `lifecycle.maxRetainChars`       | no       | Maximum automatic exchange size, clamped to 256–64000               |

If `apiKeyEnv` is set, non-loopback HTTP is rejected. Use HTTPS for LAN and remote servers.

The parser rejects malformed boolean values and unknown keys in the top-level, lifecycle, and built-in Hindsight configuration objects. Generic third-party backend objects retain their adapter-specific fields.

### Environment file

The env file uses ordinary assignment syntax:

```bash
HINDSIGHT_API_KEY=replace-me
```

`export HINDSIGHT_API_KEY=...` and quoted values are also accepted. Protect the file with mode `600` and keep it outside Git.

The process environment wins over the file. This permits credential rotation without rewriting package configuration.

### API mapping

| Memory operation | Hindsight request                                      |
| ---------------- | ------------------------------------------------------ |
| Bank access      | `GET /v1/default/banks/{bankId}/memories/list?limit=0` |
| Recall           | `POST /v1/default/banks/{bankId}/memories/recall`      |
| Retain           | `POST /v1/default/banks/{bankId}/memories`             |
| Reflect          | `POST /v1/default/banks/{bankId}/reflect`              |

The bank ID is URL-encoded. Hindsight creates a bank with default settings on first use, so verify the value with `/tidy-memory status` before retaining data.

### Bank strategy

Banks are hard isolation boundaries. Tags are filters inside a bank.

One static bank can intentionally preserve continuity for one user across multiple agents, repositories, and subject domains:

```json
{
  "bankId": "your-bank-id",
  "dynamicBankId": false
}
```

Use provenance and tags to distinguish agents, repositories, sources, and subjects inside a shared user bank. Use separate banks for different users, authorization or trust boundaries, and materially different retention policies. Banks are an isolation decision, not a substitute for provenance.

If the chosen profile is static, do not add a prefix, granularity, or directory map during an ordinary upgrade. Those settings intentionally select other banks; they do not partition or migrate the existing bank. Every new ID creates a new empty bank, and switching strategy does not migrate memories. `/tidy-memory status` reports the resolved bank.

The package's manual tools accept tags. When tags are supplied to recall or reflect, the Hindsight adapter uses `all_strict`: every requested tag must be present and untagged memories are excluded. This makes tag-scoped reads conservative rather than inheriting Hindsight's untagged-inclusive default.

All new retains include configured provenance metadata plus the actual mode and Pi session. Hindsight receives the occurrence time as its item `timestamp`. Automatic retention uses the originating user-message time and a document ID derived from the persisted assistant-entry ID; manual retention uses the tool-call ID. Retry writes therefore upsert the same Hindsight document without requiring full-session replay semantics.

Automatic retain also adds `source:pi`; it does not infer a project tag. If automatic retention is enabled, the surrounding workflow still owns durability and privacy classification.

### Retention execution

The supported profile uses `asyncRetain: false`. The tool waits for Hindsight to finish the request, so success is a completed request rather than a queue receipt. This deliberately avoids an outbox, operation polling, restart replay, and a separate retry service in a single-user integration.

The adapter still accepts `asyncRetain: true` for other deployments, but pi-tidy-memory does not poll or replay those operation receipts. Do not enable it when the deployment requires a successful result to mean Hindsight completed the write.

### Verification

After changing configuration, reload Pi and verify authenticated read access to the active bank:

```text
/reload
/tidy-memory status
/tidy-memory check
```

The standard check is read-only. Any write-path integration test must use a uniquely named ephemeral bank and must verify that the bank was deleted through Hindsight's control plane before the test is considered complete. Never write smoke data into the live bank.

## Honcho

The `honcho` backend talks to a self-hosted or hosted [Honcho](https://honcho.dev) v3 server. It shares the same user peer with an existing Honcho deployment (for example a Hermes agent profile) by reusing that deployment's config file, while keeping this agent's own peer identity separate.

### Configuration

```json
{
  "backend": {
    "type": "honcho",
    "configFile": "~/.honcho/config.json",
    "aiPeer": "pi",
    "dynamicBankId": true,
    "dynamicBankGranularity": ["agent", "project"],
    "agentName": "pi",
    "recallMode": "hybrid",
    "reasoningLevel": "low"
  }
}
```

### Fields

- `configFile` — path to a Honcho client config (the same JSON the Hermes agent writes: `baseUrl`, `apiKey`, `workspace`, `peerName`, `aiPeer`). Values there act as defaults; explicit keys in the backend config override them.
- `baseUrl`, `workspace`, `userPeer`, `aiPeer` — explicit overrides. `userPeer` defaults to the file's `peerName` (the human), `aiPeer` defaults to the file's `aiPeer` or `pi`.
- `apiKeyEnv` / `envFile` — optional credential override; when set, they take precedence over the `configFile` `apiKey`.
- `staticSessionId` — session id when dynamic bank resolution is off (default `"<aiPeer>-default"`).
- `recallMode` — `hybrid` (default; dialectic synthesis plus raw search, degrading to whichever leg succeeds), `dialectic`, or `search`.
- `reasoningLevel` — Honcho dialectic reasoning level, default `low`.
- Dynamic bank fields (`dynamicBankId`, `dynamicBankGranularity`, `bankIdPrefix`, `agentName`, `resolveWorktrees`, `directoryBankMap`) mirror the Hindsight semantics: the resolved bank id becomes the Honcho session id after mapping runs of characters outside `[a-zA-Z0-9_-]` to a single dash (Honcho session ids reject dots and colons).

### API mapping

- `health` — `GET /health`.
- `recall` — `POST /v3/workspaces/{workspace}/peers/{aiPeer}/chat` (dialectic, target = user peer) and/or `POST .../peers/{aiPeer}/search` (raw messages). Hybrid recall merges the dialectic answer with search hits and only fails when both legs fail.
- `retain` — ensures the session exists (`POST /v3/workspaces/{workspace}/sessions` with both peers), then appends one message attributed to `aiPeer` via `POST .../sessions/{session}/messages` with the retention metadata attached.
- `reflect` — dialectic chat; returns the synthesized text.

Recently deleted session ids stay shadowed by a server-side tombstone and fail re-creation with 404 for a while. `ensureSession` retries once and then falls back to a unique time-suffixed session id so retention cannot hard-fail on a recycled id.

Note: dialectic chat and semantic search require the server's deriver to be healthy. When it is down, hybrid recall degrades to the working leg and reports a combined error when neither works; retain and health are unaffected.

## Choosing this package or a dedicated Hindsight extension

Use pi-tidy-memory when:

- the Pi-facing tool names should remain stable across storage engines;
- you want compact output consistent with the other pi-tidy packages;
- manual memory is the default and automatic lifecycle behavior should be opt-in;
- you expect to add or experiment with another backend.

A dedicated Hindsight extension may be a better fit when:

- you want Hindsight-specific bank templates, directives, mental models, imports, or queue management in Pi;
- every-turn Hindsight behavior is the product rather than one backend option;
- you need a full interactive settings interface or operation polling.

pi-tidy-memory intentionally keeps bank administration outside model-facing tools. The smaller surface is easier to audit and portable to other backends, but it does not expose every Hindsight feature.

## Adding another backend

A backend adapter implements `MemoryBackend` from `types.ts`:

```ts
import type {
  MemoryBackend,
  MemoryHealth,
  RecallInput,
  RecallOutput,
  ReflectInput,
  ReflectOutput,
  RetainInput,
  RetainOutput,
} from "@mobrienv/pi-tidy-memory";

export class ExampleBackend implements MemoryBackend {
  readonly type = "example";
  readonly label = "Example";
  readonly capabilities = new Set([
    "health",
    "recall",
    "retain",
    "reflect",
  ] as const);

  async health(signal?: AbortSignal): Promise<MemoryHealth> {
    return { ok: true, message: "online" };
  }

  async recall(
    input: RecallInput,
    signal?: AbortSignal
  ): Promise<RecallOutput> {
    return { memories: [] };
  }

  async retain(
    input: RetainInput,
    signal?: AbortSignal
  ): Promise<RetainOutput> {
    return { accepted: 1, deferred: false };
  }

  async reflect(
    input: ReflectInput,
    signal?: AbortSignal
  ): Promise<ReflectOutput> {
    return { text: "No retained evidence." };
  }
}
```

Register a factory when constructing the extension:

```ts
import {
  createMemoryExtension,
  type BackendFactory,
} from "@mobrienv/pi-tidy-memory";
import { ExampleBackend } from "./example-backend.js";

const exampleFactory: BackendFactory = {
  type: "example",
  create(config, context) {
    return new ExampleBackend();
  },
};

export default createMemoryExtension({ factories: [exampleFactory] });
```

The global config can then select `"backend": { "type": "example", ... }`. Generic backend configuration is passed to the factory unchanged.

### Adapter requirements

A production adapter should:

1. validate its configuration before issuing requests;
2. reference credentials rather than storing them inline;
3. honor pre-aborted and active `AbortSignal` cancellation;
4. apply a request timeout;
5. bound response bytes before full buffering;
6. validate backend response shapes;
7. normalize records before returning them;
8. avoid including raw server bodies or credentials in errors;
9. make `close` idempotent if it owns resources;
10. use fixture tests for success, malformed data, authentication, timeout, cancellation, and oversized responses.

The common runtime applies model-facing output limits and terminal sanitization, but each adapter still owns transport limits and protocol validation.
