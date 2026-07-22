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
    "bankId": "mobrienv",
    "dynamicBankId": false,
    "apiKeyEnv": "HINDSIGHT_API_KEY",
    "envFile": "~/.config/hindsight/homelab.env",
    "recallBudget": "mid",
    "recallTypes": ["observation", "world", "experience"],
    "asyncRetain": false
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

The supported single-user integration uses one static bank:

```json
{
  "bankId": "mobrienv",
  "dynamicBankId": false
}
```

Do not add a prefix, granularity, or directory map to this installation. Those settings intentionally select other banks; they do not partition or migrate the existing `mobrienv` bank. The adapter retains dynamic-bank support for other deployments, but it is outside this operational profile.

Every new ID creates a new empty bank; switching strategy does not migrate existing memories. `/tidy-memory status` reports the resolved bank. Do not mix coding history, personal assistant conversations, medical information, and arbitrary web chat in one bank.

The package's manual tools accept tags. When tags are supplied to recall or reflect, the Hindsight adapter uses `all_strict`: every requested tag must be present and untagged memories are excluded. This makes tag-scoped reads conservative rather than inheriting Hindsight's untagged-inclusive default.

Automatic retain adds `source:pi`; it does not infer a project tag. If automatic retention is enabled, the surrounding workflow still owns durability and privacy classification.

### Retention execution

The supported profile uses `asyncRetain: false`. The tool waits for Hindsight to finish the request, so success is a completed request rather than a queue receipt. This deliberately avoids an outbox, operation polling, restart replay, and a separate retry service in a single-user integration.

The adapter still accepts `asyncRetain: true` for other deployments, but pi-tidy-memory does not poll or replay those operation receipts. Do not enable it for the `mobrienv` installation.

### Verification

After changing configuration, reload Pi and verify authenticated read access to the active bank:

```text
/reload
/tidy-memory status
/tidy-memory check
```

The standard check is read-only. Any write-path integration test must use a uniquely named ephemeral bank and must verify that the bank was deleted through Hindsight's control plane before the test is considered complete. Never write smoke data into `mobrienv`.

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
