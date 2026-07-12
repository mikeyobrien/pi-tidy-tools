# pi-fff adapter compatibility contract

**Status:** research resolution for [Define the pi-fff adapter compatibility contract](https://github.com/mikeyobrien/pi-tidy-tools/issues/12)

**Decision date:** 2026-07-11

**Minimum versions:** Pi / `@earendil-works/pi-coding-agent` **>=0.80.6** + legacy `pi-fff` **>=0.1.12** or scoped `@ff-labs/pi-fff` **>=0.6.0**, with no upper bound

**Verified baseline tuples:** Pi **0.80.6** + `pi-fff` **0.1.12**; Pi **0.80.6** + `@ff-labs/pi-fff` **0.9.6**

## Executive verdict

Ship a **forward-compatible, capability-validated adapter**, not an exact-version allowlist and not a generic extension-composition layer. Versions below either minimum are unsupported and must fail before factory evaluation or registration. Every tuple at or above both minima is eligible, without an upper bound, assuming it has not made a breaking change. The exact `0.80.6 × 0.1.12` tuple is verified; an eligible newer tuple is reported as **forward-compatible/unverified** until that tuple passes the release smoke matrix. Version numbers establish the support floor and status, while structural and runtime capabilities determine compatibility.

The adapter should resolve the active `npm:pi-fff` package from Pi's project or user npm root, construct an isolated loader using the running Pi's available Jiti and aliases, invoke the factory against a transactional recorder, validate Pi and pi-fff capabilities, and commit only after the complete recorded surface is safe. It must capture exactly one compatible `read` and one compatible `grep`, replace those slots with tidy composites, and replay compatible additional registrations in their original order.

The pi-fff contract is the required behavior-bearing baseline, not byte-exact equality with `0.1.12`. Required baseline schema properties and types and callable executors must remain. Additive optional schema fields other than tidy-reserved `reasoning`, and metadata including new prompt metadata, are accepted and preserved. Metadata wording changes alone are compatible. Additional non-overlapping registrations through known Pi registration methods may be recorded and forwarded in order. Missing or type-incompatible baseline fields, a captured source-owned `reasoning`, duplicate/overlapping built-ins, unknown registration methods, load failures, or a trace that cannot be committed without a known partial-registration risk fail closed before registration.

If any pre-commit check fails, the adapter must not replay any pi-fff registration or register pi-fff-backed composites. It leaves Pi's native `read`/`grep` in place, keeps tidy's other five owned overrides and `/tidy`, and emits one stable, actionable diagnostic. This does not mean every unsupported or unverified version is broken: below-minimum versions are outside the policy, while eligible newer versions remain usable when their capabilities validate.

## Scoped package profile addendum (GitHub #28)

The scoped package is a distinct capability profile, not a renamed legacy
artifact. Direct inspection of the installed `@ff-labs/pi-fff@0.9.6`
`src/index.ts`, manifest, and npm lock established:

- source identity `npm:@ff-labs/pi-fff` resolves to
  `node_modules/@ff-labs/pi-fff`; its manifest must identify that exact name;
- npm lock identity is `node_modules/@ff-labs/pi-fff` (and, for old lock forms,
  dependency key `@ff-labs/pi-fff`), with resolved artifact path
  `/@ff-labs/pi-fff/-/pi-fff-<version>.tgz`;
- default `tools-and-ui` / `tools-only` registers `ffgrep`, `fffind`, optional
  `fff-multi-grep`, four `fff-*` flags, `/fff-mode`, `/fff-health`,
  `/fff-rescan`, `session_start`, and `session_shutdown`; custom
  `renderCall`/`renderResult` functions are embedded in tool definitions;
- the factory calls `getFlag` while evaluating, so the recorder must expose the
  real nonmutating getter; command closures capture `appendEntry`, which must
  remain deferred until replay activates the plan;
- scoped default mode has no legacy `read`/`grep` capture surface. Tidy owns and
  registers native `read`/`grep`, while every validated nonconflicting scoped
  registration is replayed unchanged and status reports
  `tidy/native + pi-fff tools`;
- scoped `override` resolves names `grep`, `find`, and optional `multi_grep` and
  is rejected before replay: `grep` is an unsupported capture surface and
  `find` conflicts with tidy ownership.

A settings scope containing both identities is ambiguous. Project precedence
and no-fallback behavior otherwise remain unchanged. Lifecycle journals retain
the exact source identity and prior string/object entry, so teardown restores
bytes semantically to the original package entry rather than translating names.

## Evidence classification

### Directly verified baseline

- Pi 0.80.6 documents user npm installs at `~/.pi/agent/npm/`, project installs at `.pi/npm/`, `extensions: []` as “load none,” separate package module roots, and project-over-user package identity precedence ([packages docs](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md#package-sources), [filtering](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md#package-filtering), [precedence](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md#scope-and-deduplication)). Its implementation resolves those roots and makes project scope win by npm package name ([package manager lines 901–917](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L901-L917), [1671–1717](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L1671-L1717), [1992–2000](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L1992-L2000)).
- The resolved prototype loaded the real package in both npm scopes, captured `read`/`grep`, forwarded the remaining observed surface, produced one final `read` and `grep`, and executed a fuzzy read ([issue #10 resolution](https://github.com/mikeyobrien/pi-tidy-tools/issues/10#issuecomment-4948683638), [prototype commit `90f6e27`](https://github.com/mikeyobrien/pi-tidy-tools/tree/90f6e27/packages/pi-tidy-tools/prototypes/pi-fff-orchestration)).
- The exact `pi-fff@0.1.12` npm tarball contains four tool registrations, three commands, and two lifecycle handlers in the order recorded below. Its source is byte-for-byte the upstream tree at [`694837d`](https://github.com/ShpetimA/pi-fff/commit/694837d0644abc8527ebfa3ea50135e0f5d1ece4), except the npm manifest says `0.1.12` while that commit's repository manifest says `0.1.11`. The baseline artifact has integrity `sha512-nyBkFxst33//fKchgW9lDK7NF+rZxilAz8gN1bB+aDl0JVKjPNK9Y1yMy43Bb2fXxeN5Sa7vE5EUmvWIDCPBQQ==` ([tarball](https://registry.npmjs.org/pi-fff/-/pi-fff-0.1.12.tgz), [published versions](https://registry.npmjs.org/pi-fff)). Its manifest is ESM, declares `pi.extensions: ["./index.ts"]`, dependencies `@ff-labs/fff-node:^0.9.4`, `@sinclair/typebox:^0.34.41`, and `better-result:^2.8.2`, and wildcard legacy `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peers. These exact facts and hash prove the researched baseline; they are not eligibility requirements for newer artifacts.
- Loading `0.1.12` from an isolated package root with ordinary Node/Jiti resolution fails on `@mariozechner/pi-coding-agent`. Loading it with aliases to the running Pi 0.80.6 coding-agent and TUI entries succeeds. Pi itself deliberately aliases both legacy names to the running `@earendil-works/*` modules ([loader lines 45–68 and 97–125](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts#L45-L68)).
- A real pseudo-terminal run of Pi 0.80.6 through the aliased adapter rendered `/fff-features`, accepted Escape/cancel, and offered the expected FFF `@...` file suggestion. This establishes baseline dialog/editor interoperability, not coexistence with another custom editor.
- Pi resets extension UI, including the custom editor, during reload, then rebuilds it ([interactive mode lines 1950–1970](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1950-L1970)). `pi-fff@0.1.12` disposes its native runtime at every `session_start` and `session_shutdown` ([pi-fff `src/index.ts` lines 85–112](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/index.ts#L85-L112)).

### Decision and status interpretation

The capability contract, recorder/commit boundary, forward-version policy, diagnostics, and test matrices below are tidy's policy; neither Pi nor pi-fff exposes a public adapter ABI. `verified` means a tuple passed structural checks and the release smoke matrix. `forward-compatible/unverified` means both versions meet the floors and all startup structural checks passed, but that exact tuple has not completed smoke testing. It is an explicit support status, not a claim that the tuple is broken or semantically proven.

## Normative production contract

### Version, identity, root, and tuple status

1. The adapter **MUST** reject Pi versions below `0.80.6` or pi-fff versions below `0.1.12` as `BELOW_MINIMUM`. It **MUST** treat all parseable versions at or above those floors as eligible, with no upper bound and no exact-tuple allowlist.
2. The exact `0.80.6 × 0.1.12` tuple **MUST** be labeled `verified`. A newer eligible tuple **MUST** be labeled `forward-compatible/unverified` until its exact tuple passes the release smoke matrix; passing smoke may promote it to `verified` without changing eligibility.
3. Version eligibility **MUST NOT** bypass capability checks. Conversely, an eligible tuple **MUST NOT** be rejected merely because it is absent from a list or differs from the baseline artifact, metadata text, dependency versions, Jiti version, or nine-call count.
4. The adapter **MUST** consider only these managed paths:
   - project: `<cwd>/.pi/npm/node_modules/pi-fff`
   - user: `<getAgentDir()>/npm/node_modules/pi-fff` (normally `~/.pi/agent/npm/node_modules/pi-fff`)

   Git, local-path, temporary `-e`, arbitrary global npm, pnpm-global legacy locations, and `NODE_PATH` are out of scope.
5. Selection **MUST** validate that the running Pi retains the baseline managed-root semantics and settings precedence: active project `npm:pi-fff` identity shadows user identity, and a broken selected project entry never falls back to a user copy. The selected entry **MUST** be object form, identify `pi-fff`, meet the version floor, and have `extensions` exactly `[]` so standalone and adapter factories cannot both register.
6. The selected package root and manifest **MUST** resolve canonically inside the selected managed root. The manifest **MUST** identify `pi-fff`, provide a loadable extension entry consistent with its current Pi package metadata, and produce a callable default factory. Baseline `type`, entry, dependency declarations, and integrity remain evidence for `0.1.12`, not byte-exact constraints on newer versions.
7. Startup and setup **MUST NOT** require registry network access. Lock integrity, when present, **MUST** be checked for local consistency with the selected lock entry, package identity, and version. Registry metadata **SHOULD** be compared when already available without blocking; an unavailable registry leaves integrity `registry-unverified` and does not prevent capability validation. A confirmed local or registry mismatch is an artifact failure; missing integrity is not incompatibility, and a newer artifact's legitimate non-baseline hash is not.

### Pi capability validation

8. Before evaluating pi-fff code, the adapter **MUST** validate the Pi capabilities it relies on:
   - managed project/user npm roots and project-over-user settings precedence;
   - the required `ExtensionAPI` methods and binding behavior used by pi-fff and the recorder;
   - availability of a Pi-compatible Jiti loader and construction of aliases to the concrete running coding-agent, TUI, and any required shared TypeBox entries;
   - registration semantics sufficient to record first and then replay known methods in order without duplicate built-ins; and
   - all methods needed for diagnostics, settings, lifecycle, commands, tools, events, and TUI behavior used by the adapter or captured closures.
9. Pi compatibility **MUST** be determined by those capabilities, not exact Pi version, exact Jiti version, internal path equality, or copied private-loader source. A missing or incompatible required capability is `CAPABILITY_MISSING` and fails before pi-fff registration.
10. Capability probing **MUST NOT** itself leave registrations or mutate user settings. Any Pi behavior whose safety cannot be established without an irreversible test **MUST** be treated as a partial-commit risk and fail closed.

### Factory recording, surface validation, and commit

11. The adapter **MUST** invoke the loaded factory exactly once with a recorder proxy that records known Pi registration methods without forwarding during validation, binds non-registration methods and `events` correctly for later closure use, and prevents provider removal or any other known registration-time operation from escaping the transaction.
12. Known registration methods are the compatible methods exposed by the validated running Pi API, including baseline `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerEntryRenderer`, `registerProvider`, `unregisterProvider`, and `on` where present. A factory access to an unknown registration-like method **MUST** fail as `SURFACE_BREAKING`; it must not be guessed at or forwarded.
13. After factory resolution and before any Pi registration side effect, the adapter **MUST** validate the complete ordered trace. It **MUST** find exactly one capturable `read` and exactly one capturable `grep`. Missing, duplicate, or overlapping built-in registrations are breaking. Registrations that conflict with tidy-owned built-ins, existing names, commands, handlers, providers, or renderer slots are breaking unless the contract explicitly defines their composition.
14. For `read` and `grep`, every baseline schema property **MUST** remain with a compatible type and required/optional status, and `execute` **MUST** remain callable. Additive optional properties are compatible and **MUST** be preserved except for the tidy-reserved `reasoning` collision defined in rule 19. Removing a baseline field, making an optional baseline field required, changing its accepted type incompatibly, defining source-owned `reasoning`, or changing/removing a behavior-bearing callable is `SURFACE_BREAKING`.
15. Metadata text, descriptions, snippets, guidelines, labels, and ordering **MAY** change without breaking compatibility unless a behavior-bearing field disappears or changes type. All current and newly added prompt metadata **MUST** be preserved in the composite; validation **MUST NOT** compare metadata byte-for-byte.
16. Additional non-overlapping registrations through known Pi registration methods **MAY** be accepted, recorded, and forwarded unchanged in original order. Their definitions and callbacks **MUST** satisfy the running Pi method's structural contract. Unknown methods, duplicate names, overlapping built-ins, unsafe unregistration, registration-time side effects, or ordering/commit requirements that cannot be preserved are breaking.
17. On success, the adapter **MUST** replay the validated trace once in order, substituting tidy composites at the original `read` and `grep` slots and forwarding every compatible registration unchanged. It **MUST NOT** require exact nine-call equality for newer versions and **MUST NOT** call the factory again.
18. If replay unexpectedly throws, the adapter **MUST** stop immediately, register no later entry, mark the integration unusable, and require `/reload`. Because Pi may not provide rollback, validation must reject every foreseeable partial-commit risk before replay; an unexpected commit failure is a runtime incompatibility, not evidence that all forward versions are unsupported.

### Captured tools and composite execution

19. The composite **MUST** preserve every compatible pi-fff schema property and its requiredness, every metadata and prompt field, and every additive compatible extension. Tidy may apply only its mode-specific reasoning transformation and tool-named reasoning guidance. Because `reasoning` is tidy-owned and required in non-result modes, a captured pi-fff `read` or `grep` schema that defines its own `reasoning` property is `SURFACE_BREAKING`; tidy must never silently suppress its injection. Generic source composition follows the same fail-closed rule outside result mode. In `result` mode composition **MUST** retain a source schema and legitimate source `reasoning` parameters unchanged.
20. The composite executor **MUST** remove only tidy's injected `reasoning` field and call the captured function with the original receiver and exactly five unmodified argument values `(toolCallId, params, signal, onUpdate, ctx)`, including the original `onUpdate` function identity. It **MUST** return/await the exact pi-fff settled result and propagate thrown errors unchanged. It **MUST NOT** normalize content, details, updates, fallback behavior, or error signaling. Intercepting partial updates would require replacing `onUpdate` and therefore cannot simultaneously satisfy callback identity; exact argument identity is authoritative. Partial updates flow unchanged through pi-fff into Pi and tidy's existing live-rendering path, and are observed by release/runtime tests rather than adapter-guarded.
21. Runtime guards **MUST** validate settled results as objects with a `content` array whose entries have supported Pi content shapes; if present, `details` and `terminate` **MUST** be preserved. A malformed settled result is runtime incompatibility and never grounds for silent native fallback. The adapter **MUST NOT** wrap `onUpdate` to validate partial updates.
22. Representative invariants **MUST** cover both baseline result families:
   - `read`: native Pi results on successful/fallback reads; non-throwing text plus `{ resolution }` on path-resolution failure.
   - `grep`: native Pi details on compatibility fallback; FFF text plus `buildGrepDetails` fields (`truncation`, limits, scope, cursor, constraints, suggestion, structured error, disabled feature) on indexed execution.

Pi explicitly warns that built-in overrides must preserve exact result/details shapes ([extensions docs lines 1951–1977](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#overriding-built-in-tools)); structural checks cannot prove those semantics, so runtime guards and smoke tests remain mandatory.

### Lifecycle, features, and TUI

23. Both built-in enhancement feature keys **MUST** be enabled at factory load. Their absence is a missing required capture, not an accepted variant. The five baseline keys are `autocomplete`, `builtInReadEnhancement`, `builtInGrepEnhancement`, `agentTools`, and `statusUI` ([feature definitions](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/extension-common.ts#L17-L50)). New optional feature metadata is accepted and preserved when structurally safe.
24. Baseline `session_start` and `session_shutdown` behavior **MUST** remain available and be forwarded unchanged and in order. Tidy **MUST NOT** initialize, own, or dispose `FffRuntime`; pi-fff owns indexing, watcher startup, databases, warmup, and destruction. Pi's required start/shutdown discipline is documented at [extensions lines 219–223](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#long-lived-resources-and-shutdown).
25. `getAgentDir()` ownership **MUST** remain with the aliased running Pi module. Feature state and runtime databases remain under that Pi agent root; tidy **MUST NOT** duplicate or relocate them.
26. Commands and custom tools **MUST** be forwarded when structurally compatible even when their pi-fff feature is disabled; pi-fff controls activation during `session_start`.
27. Every verified tuple **MUST** pass a real-TUI/release smoke run. Structural checks cannot prove component behavior, semantic result compatibility, injected keybindings, focus, editor restoration, native-addon behavior, or watcher cleanup.
28. A competing custom editor remains unsupported unless a future tuple exposes a validated composition capability. Baseline `0.1.12` calls `setEditorComponent` without reading/wrapping `getEditorComponent` ([source lines 40–45](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/index.ts#L40-L45)); Pi 0.80.6 is last-writer-wins. The adapter **SHOULD** warn rather than claim composition.
29. Disabling autocomplete in the live baseline feature dialog does not restore the prior/default editor until reload. The UI/diagnostic **SHOULD** tell the user to `/reload`; tidy **MUST NOT** take editor ownership to mask this behavior.

## Observed baseline `pi-fff@0.1.12` registration surface

Default feature state (all five enabled) produced this nine-call trace. It is the verified baseline fixture and the source of required versus extensible properties; it is **not** an exact-count allowlist for forward versions. Source: [`register-tools.ts`](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/register-tools.ts#L35-L214), [`register-commands.ts`](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/register-commands.ts#L15-L145), and [`src/index.ts`](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/index.ts#L68-L112).

| # | Registration | Name | Observed `0.1.12` definition | Required anchors / forward extensions |
|---:|---|---|---|---|
| 1 | `registerTool` (captured) | `read` | label `read`; required `path:string`; optional `offset:number`, `limit:number`; Pi 0.80.6 read description plus FFF sentence; callable `execute`; no prompt/render metadata | exactly one capture; baseline properties/types and callable executor remain; additive optional schema/prompt metadata and metadata text changes are preserved |
| 2 | `registerTool` (captured) | `grep` | required `pattern:string`; optional `mode,path,glob,constraints,cursor,outputMode:string`, `ignoreCase,literal:boolean`, `context,limit:number`; observed description, snippet, and four guidelines; callable `execute`; no renderers | exactly one capture; baseline properties/types and callable executor remain; additive optional schema/prompt metadata and metadata text changes are preserved |
| 3 | `registerTool` (forwarded) | `find_files` | label/description/snippet/one guideline; required `query:string`; optional `limit:number`, `cursor:string`; callable `execute`; no renderers | registration must remain non-overlapping and structurally valid if present; compatible additive fields and additional non-overlapping tools are accepted |
| 4 | `registerTool` (forwarded) | `fff_multi_grep` | observed metadata; required `patterns:string[]` with `minItems:1`; optional `path,glob,constraints,cursor,outputMode:string`, `context,limit:number`; callable `execute`; no renderers | registration must remain non-overlapping and structurally valid if present; compatible additive fields and additional non-overlapping tools are accepted |
| 5 | `registerCommand` | `fff-features` | exactly two arguments; description `Toggle pi-fff features on or off`; callable `handler` | structurally valid if present; metadata/argument evolution compatible with running Pi and additional commands are accepted |
| 6 | `registerCommand` | `reindex-fff` | description `Trigger an fff rescan for the current project`; callable `handler` | structurally valid if present; metadata evolution and additional commands are accepted |
| 7 | `registerCommand` | `fff-status` | description `Show fff runtime status and index health`; callable `handler` | structurally valid if present; metadata evolution and additional commands are accepted |
| 8 | `on` | `session_start` | exactly two arguments; callable handler | baseline lifecycle capability remains; additional non-overlapping known events/handlers are accepted |
| 9 | `on` | `session_shutdown` | exactly two arguments; callable handler | baseline lifecycle capability remains; additional non-overlapping known events/handlers are accepted |

**Observed baseline counts:** 4 tools (2 captured + 2 forwarded), 3 commands, 2 event handlers; 9 calls total. **Observed absent:** shortcuts, flags, providers, provider removal, message renderers, entry renderers, event-bus registration, custom tool renderers, and registration-time action calls. The shipped README's mention of `resolve_file`, `related_files`, and `fff_grep` is stale; shipped baseline code is authoritative.

For forward validation, schemas should be canonicalized by property semantics and compatible types, not whole-object JSON equality. Baseline properties are required contract anchors; additive optional properties and all metadata are retained. Metadata strings and guideline order affect the model prompt and therefore must be preserved, but text differences alone do not reject a tuple.

## Loader boundary

Keep all private coupling in one `loadPiFffFactory()` module with this conceptual interface:

```ts
type LoadedPiFff = {
  packageRoot: string;
  piVersion: string;
  piFffVersion: string;
  status: "verified" | "forward-compatible/unverified";
  factory: (pi: ExtensionAPI) => void | Promise<void>;
};

loadPiFffFactory(context): Promise<Result<LoadedPiFff, PiFffDiagnostic>>;
```

The rest of tidy should know only the loaded factory, detected versions/status, and validated trace, never Jiti paths or aliases.

The loader **MUST**:

1. anchor resolution to the canonical running Pi package root, not tidy's or pi-fff's root;
2. use the running Pi installation's available compatible Jiti construction, without requiring baseline Jiti **2.7.0** exactly, disable unsafe stale module caching, and import the selected absolute entry once;
3. construct aliases from Pi's current loader capabilities so legacy `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` imports resolve to the concrete running coding-agent and TUI entries, preserving required shared TypeBox aliases where applicable;
4. never resolve legacy peers from pi-fff's root, arbitrary global npm, or tidy dependencies;
5. validate loader availability, alias targets, shared-module identity where behavior depends on it, and a callable default export before factory invocation; and
6. return a capability diagnostic rather than assuming private path/version equality when a newer Pi changes loader construction.

Pi 0.80.6's observed construction is documented at [Jiti construction lines 341–360](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts#L341-L360). It avoids separate TUI class/singleton copies. Pi itself uses duck typing because `instanceof` may fail across Jiti boundaries ([interactive mode lines 2392–2404](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2392-L2404)); adapter validation should likewise test component shape, not `instanceof`.

Do not import Pi's unexported loader internals or scatter loader discovery across tidy modules. A newer Pi is eligible when the loader and alias capabilities can be constructed and validated; otherwise it fails before factory registration as `CAPABILITY_MISSING`, without a claim that the Pi release itself is generally broken.

## Validation phases and fail-closed boundary

| Phase | Before factory? | Checks | On failure/status |
|---|---:|---|---|
| 0. Version floor/status | yes | parse detected Pi/pi-fff versions; both meet minima; baseline versus newer tuple | `BELOW_MINIMUM`, or continue with `verified` / `FORWARD_UNVERIFIED` status |
| 1. Settings/root | yes | managed-root semantics, active npm identity, project precedence, `extensions: []`, canonical selected root | no factory invocation; `CAPABILITY_MISSING` or config diagnostic |
| 2. Artifact | yes | manifest identity/version floor/current entry; local lock consistency when present; non-blocking registry comparison when available | no factory invocation; confirmed mismatch gets artifact diagnostic; unavailable registry continues as `INTEGRITY_UNVERIFIED` |
| 3. Pi/loader capabilities | yes | required ExtensionAPI methods, registration behavior, Jiti availability, concrete aliases, callable default export | import may have occurred; no factory invocation or registration; `CAPABILITY_MISSING`/load diagnostic |
| 4. Record | no | invoke once against side-effect-contained registration recorder | discard trace; replay nothing |
| 5. Surface | no | exactly one compatible `read`/`grep`; baseline schema/types/callables; additive preservation; known methods; no overlap or partial-commit risk | discard trace; replay nothing; `SURFACE_BREAKING` |
| 6. Commit | no | substitute captures and replay all validated registrations in original order | stop; runtime incompatibility; require reload if any call committed |
| 7. Runtime | no | registry uniqueness, result-shape guards, lifecycle and real-TUI observations | disable affected integration; never masquerade as FFF; runtime incompatibility |
| 8. Release status | no | exact tuple completes automated and manual smoke matrices | promote tuple from `FORWARD_UNVERIFIED` to verified evidence |

“Transactional” applies to Pi registration calls, not arbitrary JavaScript evaluation. A third-party module or factory can perform side effects before registering. Direct inspection shows `0.1.12` performs a synchronous feature-state read and registrations during factory execution; native runtime/watcher creation is deferred to `session_start`. Forward structural validation narrows this boundary but cannot prove absence of arbitrary evaluation side effects or same-shape semantic changes.

## Diagnostic taxonomy

Diagnostics must have a stable code, one of the policy categories below, severity, one-line summary, detected Pi and pi-fff versions, safe concrete detail, and a recovery action. Show at most one startup notification for a warning or error and expose full detail through `/tidy status`. Do not dump stacks by default or include file contents. `FORWARD_UNVERIFIED` is informational when validation succeeds; report it through status without a startup warning, and never imply incompatibility.

| Category / example code | Severity | Condition | Actionable message template |
|---|---|---|---|
| `BELOW_MINIMUM` / `PIFFF_BELOW_MINIMUM` | error | either detected version is below its floor | `pi-fff adapter inactive with Pi <pi> and pi-fff <fff>: minimums are Pi 0.80.6 and pi-fff 0.1.12. Upgrade the below-minimum component, then /reload. This version is outside the supported range, not necessarily broken.` |
| `CAPABILITY_MISSING` / `PIFFF_CAPABILITY_MISSING` | error | eligible Pi lacks required root/settings/API/loader/alias/registration capability | `pi-fff adapter inactive with Pi <pi> and pi-fff <fff>: required capability <capability> is unavailable. <concrete reinstall/upgrade/configure action>, then /reload.` |
| `SURFACE_BREAKING` / `PIFFF_SURFACE_BREAKING` | error | baseline field/type/callable removed, capture duplicate/missing, overlap, unknown registration, or unsafe commit trace | `Pi <pi> / pi-fff <fff> changed required adapter surface <detail>. No pi-fff registrations were forwarded. Install a structurally compatible release or disable orchestration, then /reload.` |
| `FORWARD_UNVERIFIED` / `PIFFF_FORWARD_UNVERIFIED` | info | eligible newer tuple passes startup validation but has not completed smoke | `Pi <pi> / pi-fff <fff> passed structural compatibility checks and is forward-compatible/unverified. Run the release smoke matrix before promoting this tuple to verified.` |
| runtime incompatibility / `PIFFF_RUNTIME_INCOMPATIBLE` | error/fatal | malformed result, semantic/TUI/lifecycle failure, or unexpected replay failure | `Pi <pi> / pi-fff <fff> failed at runtime: <safe concrete detail>. Stop using the affected integration and /reload; use the verified baseline or a smoke-tested release while investigating.` |
| `PIFFF_CONFIG_MISSING` | warning | no active npm package entry | `pi-fff adapter inactive with Pi <pi>: no npm:pi-fff package entry. Install pi-fff in a managed Pi npm scope, then run /tidy pi-fff setup.` |
| `PIFFF_CONFIG_FILTER_REQUIRED` | error | entry is string form or `extensions` is not `[]` | `pi-fff <fff> must use extensions: [] so its factory runs once. Run /tidy pi-fff setup, then /reload.` |
| `PIFFF_SCOPE_SHADOWED_INVALID` | error | selected project entry shadows a valid user copy but is invalid | `Pi <pi> selected project pi-fff <fff>, which shadows the user install and is invalid: <reason>. Fix/remove the project entry; tidy will not fall back.` |
| `PIFFF_PACKAGE_MISSING` | error | selected managed package is absent | `Configured pi-fff is missing from the selected <project|user> Pi npm root. Install npm:pi-fff@<version-at-or-above-0.1.12> with extensions: [], then /reload.` |
| `PIFFF_INTEGRITY_UNVERIFIED` | info | local lock/package data is consistent but registry metadata is unavailable | `pi-fff <fff> passed local artifact checks; registry integrity was not verified offline. Capability validation continues.` |
| `PIFFF_INTEGRITY_MISMATCH` | error | selected package conflicts with local lock data or available selected-version registry metadata | `Installed pi-fff <fff> fails artifact integrity validation. Reinstall that version through Pi, then /reload.` |
| `PIFFF_LOAD_FAILED` | error | selected entry import throws | `Pi <pi> could not load pi-fff <fff>: <sanitized cause>. Reinstall it and verify its native dependencies support this platform, then /reload.` |
| `PIFFF_FACTORY_FAILED` | error | factory throws/rejects before commit | `pi-fff <fff> factory failed under Pi <pi>: <sanitized cause>. No pi-fff registrations were forwarded.` |
| `PIFFF_FORWARD_PARTIAL` | fatal | replay unexpectedly throws after a registration | `Pi <pi> rejected pi-fff <fff> registration <n>; the runtime may be partially registered. Fix <cause> and /reload before using FFF tools.` |
| `PIFFF_EXEC_RESULT_INVALID` | error | captured executor returns malformed result | `pi-fff <fff> returned an unsupported <tool> result under Pi <pi>. The call failed closed; use a verified/smoke-tested tuple or update the incompatible component.` |
| `PIFFF_TUI_EDITOR_CONFLICT` | warning | another custom editor is already installed without composition capability | `pi-fff <fff> would replace an existing custom editor under Pi <pi>. Disable one editor feature and /reload.` |
| `PIFFF_TUI_RELOAD_REQUIRED` | info | autocomplete is off but FFF editor remains live | `Autocomplete is saved off, but the current pi-fff editor remains until reload. Run /reload.` |

Messages may include only selected scope and documented Pi-relative roots by default. Debug detail may include canonical paths after home contraction, but never environment values, config contents, query history, or source text.

## Automated verification matrix

These tests are release-blocking and deterministic.

| Area | Cases / assertions |
|---|---|
| Version/status policy | below each minimum rejects as `BELOW_MINIMUM`; `0.80.6 × 0.1.12` is verified; versions at/above floors have no upper-bound rejection; newer passing fixtures report `FORWARD_UNVERIFIED` until smoke-tested |
| Pi capabilities | synthetic compatible newer Pi API; missing managed-root semantics/settings precedence; missing/bad ExtensionAPI methods; unavailable Jiti; alias-construction failure; incompatible registration behavior; no capability probe mutates registry/settings |
| Scope/config | user only; project only; both (project wins); invalid project + valid user (no fallback); missing/string/nonempty filter; non-npm/git/local ignored with proper diagnostic |
| Artifact | missing root/manifest/entry; wrong identity; below-minimum manifest; current entry variants; path escape/symlink; local integrity match/mismatch; registry available match/mismatch; registry unavailable continues as `INTEGRITY_UNVERIFIED`; newer legitimate hash accepted |
| Loader | isolated baseline cannot resolve legacy peers ordinarily; aliased loader succeeds; compatible non-2.7.0 Jiti fixture; aliases target running Pi/TUI; missing/noncallable default; sanitized import/native load failure |
| Factory transaction | sync/async factory; throw before/after recorded calls; no real registration before full validation; called exactly once; registration-time side-effect/partial-commit risks rejected |
| Baseline surface | observed nine-call fixture passes; exactly one `read`/`grep`; every baseline schema property/type/callable enforced; missing/duplicate capture and overlapping built-ins reject |
| Additive-compatible forward fixture | optional schema fields, changed metadata text, new prompt metadata, and additional non-overlapping known-method registrations all pass, are preserved, and replay in order; call count may exceed nine |
| Breaking-forward fixtures | removed/type-changed baseline field; optional made required; noncallable executor; duplicate `read`/`grep`; overlapping tool/command; unknown registration method; unsafe unregistration; load failure; partial-commit requirement all fail before replay |
| Feature state | baseline all-enabled succeeds; missing read, grep, or both produces `SURFACE_BREAKING`; compatible optional feature metadata preserved |
| Replay | composites replace captures in original slots; all compatible forwarded arguments/handler identities unchanged; additions preserve order; induced unexpected failure produces runtime incompatibility and no later calls |
| Composite schema | tidy modes retain all compatible baseline/additive schema and prompt metadata while rejecting source-owned `reasoning`; generic `result` composition is current-schema identical; metadata text changes do not reject; render ownership remains tidy for captured tools |
| Executor/results | receiver/exactly five arguments/original update-callback identity; strips only tidy-injected reasoning; preserves settled value/details/`terminate`; errors/abort propagate; partial updates pass unchanged through Pi/tidy's existing path; exact/fuzzy/missing read and indexed/fallback/error/paginated grep; malformed settled shapes fail runtime guards |
| Registry/lifecycle | exactly one `read`/`grep`; all validated additional registrations present once; repeated start/shutdown/reload creates no stale runtime, cursor, handler, watcher, or callback |
| Diagnostics | each taxonomy category snapshots detected versions, safe detail, recovery, single notification; unsupported wording never says below-minimum or unverified versions are automatically broken |
| Newest releases | CI/release job installs the newest available Pi and newest available pi-fff, runs structural/integration suites, and records `FORWARD_UNVERIFIED` or concrete incompatibility without adding an upper bound |

The user/project installed-package probe from `90f6e27` should become a non-interactive integration fixture, updated to use the explicit alias boundary rather than incidental ambient resolution.

## Release-time/manual smoke matrix

Run against the packed tidy artifact. Always test the verified baseline tarball with Pi 0.80.6 and the newest available Pi/pi-fff releases, both paired together and in mixed baseline/newest combinations when installable. Structural acceptance of a newer tuple does not waive this matrix.

| Environment / flow | Manual evidence required |
|---|---|
| Tuple coverage | baseline `0.80.6 × 0.1.12`; newest Pi × newest pi-fff; newest Pi × baseline pi-fff; baseline Pi × newest pi-fff when version requirements permit; record detected versions and status |
| Linux user npm root | clean startup; no extension issues; one `read`/`grep`; fuzzy `read`; FFF `grep`; compatible custom tools, commands, and additions |
| Linux project npm root | same checks; project trust/install; verify project-over-user selection when both exist |
| Real TUI autocomplete | `@partial`, quoted path with spaces, selection insertion, Escape, fallback to Pi path completion, no crash on abort |
| `/fff-features` | dialog width/focus/keys; cancel leaves state; save changes active tools; built-in enhancement changes after reload; autocomplete-off message tells user to reload |
| Editor ownership | no competing editor baseline; then editor loaded before/after adapter to confirm warning, last-writer behavior, or a newly validated composition capability |
| Runtime result semantics | native and FFF read/grep result families, unchanged partial updates through the existing Pi/tidy path, exact update-callback identity, errors, aborts, details and `terminate`; settled-result guards reject malformed synthetic results |
| Lifecycle | `/reload`, `/new`, `/resume`, `/fork`, and exit; no stale editor, duplicate handler, orphan watcher/native process, locked database, or old-runtime callback |
| Modes | TUI fully works; RPC commands/notifications work and `custom()` limitation is understood; JSON/print do not hang due to background resources |
| Native/platform | supported Linux architectures at minimum; macOS and Windows only when claimed, including native addon load and file watching |
| Filesystem edges | non-ASCII filename regression from [pi-fff PR #8](https://github.com/ShpetimA/pi-fff/pull/8); spaces; large repo; cwd outside git; requested grep scope outside initial workspace |
| Setup/teardown | confirmed all-scope setup journals and filters entries transactionally; tidy disablement never edits package settings; explicit teardown restores exact prior entries; interrupted startup recovery rolls back safely and requires one user `/reload`; command-triggered reload has no duplicate registrations |

The 2026-07-11 real-TUI probe passed the baseline feature dialog and autocomplete rows for `0.80.6 × 0.1.12`. Competing-editor composition, all session replacement flows, macOS/Windows, setup/teardown, and future tuples were not directly verified by this research.

## Residual risks

1. **No public factory ABI.** Importing another extension's entry and replaying registrations remains intentional private coupling. Capability validation reduces version churn but cannot remove this risk.
2. **Same-shape semantic breaks are not detectable before use.** A forward release can preserve every schema, callable, registration, and result shape while changing executor, lifecycle, prompt, TUI, or fallback meaning. Runtime guards detect malformed shapes, not semantic equivalence; real-TUI/release smoke coverage and runtime observation remain required.
3. **Evaluation is not sandboxed.** The recorder prevents known Pi registration side effects, not arbitrary module/factory side effects. Baseline `0.1.12` was inspected; forward structural acceptance cannot prove a newer factory is side-effect free.
4. **Legacy import bridge.** Baseline pi-fff declares wildcard `@mariozechner/*` peers while Pi is `@earendil-works/*`. Aliases remain required when those imports remain. Pi alias/export changes are compatible only if equivalent running-module identity can be constructed. Pi's history confirms cross-root resolution regressions ([Pi PR #1821](https://github.com/earendil-works/pi/pull/1821)); separate TUI copies can split singleton state ([Pi issue #4748](https://github.com/earendil-works/pi/issues/4748)).
5. **Non-transactional commit.** Pi 0.80.6 has no unregister-tool/command/handler transaction. Validation rejects known partial-commit risks, but an unexpected replay failure after the first registration still requires a full reload. During teardown recovery, a partially removed linked journal set is intentional evidence that settings restoration completed and cleanup crashed; recovery idempotently removes the remaining journals rather than treating already-removed sidecars as drift.
6. **Editor is last-writer-wins at baseline.** `pi-fff@0.1.12` does not compose with or restore a preexisting editor, and live disabling leaves its editor until reload. A future same-shape implementation could alter this behavior; smoke testing must establish it.
7. **Global config ownership.** Even a project npm install reads/writes feature state through running Pi's `getAgentDir()`. Capability checks establish the root shape, not user expectations about project-local flags.
8. **Native runtime behavior.** `@ff-labs/fff-node` has platform, watcher, and indexing side effects. Open upstream issues include scanning a home directory/OneDrive ([#6](https://github.com/ShpetimA/pi-fff/issues/6)) and grep scope outside the initial workspace ([#4](https://github.com/ShpetimA/pi-fff/issues/4)). These are pi-fff behavior, not automatically adapter incompatibility, but belong in smoke coverage.
9. **Mixed error semantics.** Baseline semantic failures can return ordinary text rather than throw, so Pi does not mark them `isError`. Shape validation cannot infer intent; tidy must render the actual state without reclassification.
10. **Unversioned baseline source.** npm `0.1.12` matches upstream commit `694837d` except manifest version, but has no `v0.1.12` tag. The exact npm tarball remains baseline evidence; it does not constrain newer eligibility.
11. **Floating dependencies.** Baseline caret ranges resolved `@ff-labs/fff-node` 0.9.6, `better-result` 2.9.2, and `@sinclair/typebox` 0.34.51 during research. Later resolutions may preserve structures while changing semantics. Debug status should report resolved versions and release fixtures should lock evidence runs.
12. **Documentation drift and additive surface growth.** Runtime trace and loaded artifact outrank stale README lists. Accepting compatible additions broadens replay responsibility, so overlap, ordering, and real-runtime behavior must be tested rather than inferred from count.

## Source index

- Wayfinder map: [pi-tidy-tools #9](https://github.com/mikeyobrien/pi-tidy-tools/issues/9)
- Research ticket: [Define the pi-fff adapter compatibility contract](https://github.com/mikeyobrien/pi-tidy-tools/issues/12)
- Resolved prototype: [issue #10](https://github.com/mikeyobrien/pi-tidy-tools/issues/10), [commit `90f6e27`](https://github.com/mikeyobrien/pi-tidy-tools/commit/90f6e27b1d62fb3317e939b7e87af2bb738b43fd)
- Pi 0.80.6 release: [tag commit `2b3fda9`](https://github.com/earendil-works/pi/commit/2b3fda9921b5590f285165287bd442a25817f17b)
- Pi docs read in full: [extensions.md](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md), [packages.md](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md), [tui.md](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/tui.md)
- Pi loader/API/TUI: [`loader.ts`](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts), [`types.ts`](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/types.ts), [`interactive-mode.ts`](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- Exact baseline pi-fff artifact: [`pi-fff-0.1.12.tgz`](https://registry.npmjs.org/pi-fff/-/pi-fff-0.1.12.tgz)
- Matching upstream source tree: [`694837d`](https://github.com/ShpetimA/pi-fff/tree/694837d0644abc8527ebfa3ea50135e0f5d1ece4)
- Version-policy history: tool removals in [v0.1.7 release](https://github.com/ShpetimA/pi-fff/releases/tag/v0.1.7), load-time feature registration change [`2411eaf`](https://github.com/ShpetimA/pi-fff/commit/2411eaf0b21bc4652a81b28b127e8eeeb11d91c6), split read/grep flags [`5689be7`](https://github.com/ShpetimA/pi-fff/commit/5689be7a60462190aedb92b97605aff451784c7f), native dependency change [PR #8](https://github.com/ShpetimA/pi-fff/pull/8)
