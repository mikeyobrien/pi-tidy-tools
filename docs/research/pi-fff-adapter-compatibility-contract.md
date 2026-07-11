# pi-fff adapter compatibility contract

**Status:** research resolution for [Define the pi-fff adapter compatibility contract](https://github.com/mikeyobrien/pi-tidy-tools/issues/12)  
**Decision date:** 2026-07-11  
**Initial compatibility tuple:** Pi / `@earendil-works/pi-coding-agent` **0.80.6** + `pi-fff` **0.1.12**

## Executive verdict

Ship a **closed, exact-version adapter**, not a generic extension-composition layer. The adapter should accept only the tuple above, resolve the active `npm:pi-fff` package from Pi's project or user npm root, reproduce Pi 0.80.6's Jiti aliases at one private loader boundary, invoke the factory against a transactional recorder, and commit registrations only after an exact surface check passes. It should replace the recorded `read` and `grep` slots with tidy composites while replaying every other observed registration in its original order.

The compatibility unit is not “any `0.1.x`.” Patch releases have changed tool presence, feature-state semantics, and the native dependency; `0.1.12` has no matching upstream tag, and its npm manifest still declares wildcard legacy `@mariozechner/*` peers. New tuples should be added to an explicit allowlist only after this contract and both verification matrices pass.

If any required check fails, the adapter must **fail closed**: do not replay any pi-fff registration, do not register pi-fff-backed composites, and never silently fall back to a different package root or version. Leave Pi's native `read`/`grep` in place, keep tidy's other five owned overrides and `/tidy`, and emit one stable, actionable diagnostic. This preserves truthful execution rather than presenting native execution as FFF-backed execution.

## Evidence classification

### Directly verified

- Pi 0.80.6 documents user npm installs at `~/.pi/agent/npm/`, project installs at `.pi/npm/`, `extensions: []` as “load none,” separate package module roots, and project-over-user package identity precedence ([packages docs](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md#package-sources), [filtering](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md#package-filtering), [precedence](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md#scope-and-deduplication)). Its implementation resolves those exact roots and makes project scope win by npm package name ([package manager lines 901–917](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L901-L917), [1671–1717](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L1671-L1717), [1992–2000](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/package-manager.ts#L1992-L2000)).
- The resolved prototype loaded the real package in both npm scopes, captured `read`/`grep`, forwarded the remaining observed surface, produced one final `read` and `grep`, and executed a fuzzy read ([issue #10 resolution](https://github.com/mikeyobrien/pi-tidy-tools/issues/10#issuecomment-4948683638), [prototype commit `90f6e27`](https://github.com/mikeyobrien/pi-tidy-tools/tree/90f6e27/packages/pi-tidy-tools/prototypes/pi-fff-orchestration)).
- The exact npm tarball contains four tool registrations, three commands, and two lifecycle handlers in the order recorded below. Its source is byte-for-byte the upstream tree at [`694837d`](https://github.com/ShpetimA/pi-fff/commit/694837d0644abc8527ebfa3ea50135e0f5d1ece4), except the npm manifest says `0.1.12` while that commit's repository manifest says `0.1.11`. The authoritative npm artifact has integrity `sha512-nyBkFxst33//fKchgW9lDK7NF+rZxilAz8gN1bB+aDl0JVKjPNK9Y1yMy43Bb2fXxeN5Sa7vE5EUmvWIDCPBQQ==` ([tarball](https://registry.npmjs.org/pi-fff/-/pi-fff-0.1.12.tgz), [published versions](https://registry.npmjs.org/pi-fff)).
- Loading `0.1.12` from an isolated package root with ordinary Node/Jiti resolution fails on `@mariozechner/pi-coding-agent`. Loading it with aliases to the running Pi 0.80.6 coding-agent and TUI entries succeeds. Pi itself deliberately aliases both legacy names to the running `@earendil-works/*` modules ([loader lines 45–68 and 97–125](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts#L45-L68)).
- A real pseudo-terminal run of Pi 0.80.6 through the aliased adapter rendered `/fff-features`, accepted Escape/cancel, and offered the expected FFF `@...` file suggestion. This establishes baseline dialog/editor interoperability, not coexistence with another custom editor.
- Pi resets extension UI, including the custom editor, during reload, then rebuilds it ([interactive mode lines 1950–1970](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1950-L1970)). `pi-fff` disposes its native runtime at every `session_start` and `session_shutdown` ([pi-fff `src/index.ts` lines 85–112](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/index.ts#L85-L112)).

### Recommendations, not upstream guarantees

The exact tuple allowlist, recorder/commit transaction, validation signatures, fail-closed policy, diagnostics, and test matrices below are the recommended tidy contract. Neither Pi nor pi-fff exposes a public adapter ABI.

## Normative production contract

### Version, identity, and root selection

1. The adapter **MUST** enable orchestration only when the running Pi version is exactly `0.80.6` and the selected package manifest is exactly `{ name: "pi-fff", version: "0.1.12", type: "module" }`.
2. It **MUST NOT** use `^0.1.12`, `~0.1.12`, `<0.2`, or infer support from a newer package's similar-looking factory. Supported tuples **MUST** be an explicit data allowlist.
3. It **MUST** consider only these managed paths:
   - project: `<cwd>/.pi/npm/node_modules/pi-fff`
   - user: `<getAgentDir()>/npm/node_modules/pi-fff` (normally `~/.pi/agent/npm/node_modules/pi-fff`)

   Git, local-path, temporary `-e`, arbitrary global npm, pnpm-global legacy locations, and `NODE_PATH` are out of scope.
4. Selection **MUST** mirror Pi package identity precedence, not “first directory that exists”: an active project `npm:pi-fff` entry shadows the user entry. If the selected project entry is broken, the adapter **MUST NOT** fall back to a valid user copy.
5. The selected settings entry **MUST** be object form, have npm identity `pi-fff`, target `0.1.12`, and have `extensions` exactly `[]`. A missing filter risks the standalone factory and adapter both registering tools.
6. The package root and `package.json` **MUST** resolve canonically inside the selected managed root. `pi.extensions` **MUST** be exactly `["./index.ts"]`; `index.ts` **MUST** be a regular readable file resolving inside that root and contain a callable default factory after load. The manifest dependency declarations **MUST** remain `@ff-labs/fff-node:^0.9.4`, `@sinclair/typebox:^0.34.41`, and `better-result:^2.8.2`, with wildcard legacy `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` peers; changed declarations require a new artifact review.
7. The adapter **SHOULD** compare npm lock metadata to the published integrity when available. Integrity absence is not a compatibility failure; a present mismatch is.

### Factory recording and commit

8. The adapter **MUST** complete manifest, filter, version, entry, Pi, Jiti, and alias checks before evaluating pi-fff code.
9. It **MUST** invoke the factory with a recorder proxy that:
   - intercepts every Pi 0.80.6 registration method (`registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerEntryRenderer`, `registerProvider`, and `on`) and `unregisterProvider` so factory-time provider removal cannot escape the transaction;
   - records arguments without forwarding during validation;
   - binds non-registration API methods and `events` transparently to the real Pi API for later closure use;
   - treats a registration method/count/name not listed below as an incompatible surface, not as an automatically forwardable novelty.
10. After factory resolution, the adapter **MUST** validate the complete ordered trace and every captured definition before causing any Pi registration side effect.
11. On success it **MUST** replay the trace in order, substituting the tidy composite at the original `read` and `grep` entries and forwarding the other seven entries unchanged. It **MUST NOT** call the factory a second time.
12. If replay unexpectedly throws, the adapter **MUST** stop immediately, register no later entry, mark the integration unusable, and require `/reload`; Pi has no registration transaction or unregister-tool API, so rollback cannot be promised.

### Captured tools and composite execution

13. `read` and `grep` **MUST** have the exact schema and metadata signatures in the observed table, callable `execute`, and no `renderCall`, `renderResult`, `prepareArguments`, `renderShell`, or `executionMode` fields. Their renderers are intentionally absent; tidy owns both render slots.
14. The composite **MUST** retain all pi-fff schema properties, required fields, descriptions, prompt snippet, and prompt guidelines; apply tidy's mode-specific reasoning schema; and add only tidy's tool-named reasoning guidance. In `result` mode it **MUST** retain the native pi-fff schema unchanged.
15. The composite executor **MUST** remove only tidy's `reasoning` field and call the captured function with the original receiver and unmodified `(toolCallId, params, signal, onUpdate, ctx)` values. It **MUST** return/await the exact pi-fff result and propagate thrown errors unchanged. It **MUST NOT** normalize content, details, updates, fallback behavior, or error signaling.
16. At runtime, a settled or partial result **MUST** be an object with a `content` array whose entries have supported Pi content shapes; if present, `details` and `terminate` **MUST** be preserved. A malformed result is an adapter compatibility error, never grounds for a silent native fallback.
17. Representative invariants **MUST** cover both pi-fff result families:
   - `read`: native Pi results on successful/fallback reads; non-throwing text plus `{ resolution }` on path-resolution failure.
   - `grep`: native Pi details on compatibility fallback; FFF text plus `buildGrepDetails` fields (`truncation`, limits, scope, cursor, constraints, suggestion, structured error, disabled feature) on indexed execution.

Pi explicitly warns that built-in overrides must preserve exact result/details shapes ([extensions docs lines 1951–1977](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#overriding-built-in-tools)); therefore the adapter preserves pi-fff's results rather than inventing a third shape.

### Lifecycle, features, and TUI

18. Both built-in enhancement feature keys **MUST** be enabled at factory load. Because pi-fff conditionally omits these registrations based on synchronous global state, an absent `read` or `grep` is `PIFFF_SURFACE_FEATURE_STATE`, not a surface variant to accept. The five exact keys are `autocomplete`, `builtInReadEnhancement`, `builtInGrepEnhancement`, `agentTools`, and `statusUI` ([feature definitions](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/extension-common.ts#L17-L50)).
19. The adapter **MUST** forward `session_start` and `session_shutdown` unchanged and in order. It **MUST NOT** initialize, own, or dispose `FffRuntime`; pi-fff owns indexing, watcher startup, databases, warmup, and destruction. Pi's required start/shutdown discipline is documented at [extensions lines 219–223](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md#long-lived-resources-and-shutdown).
20. `getAgentDir()` ownership **MUST** remain with the aliased running Pi module. Consequently pi-fff feature state remains global at `~/.pi/agent/extensions/pi-fff.json` (or the documented `PI_CODING_AGENT_DIR` equivalent), and runtime databases remain under the same Pi agent root. Tidy **MUST NOT** duplicate or relocate this state.
21. Commands and custom tools **MUST** be forwarded even when their feature is disabled; pi-fff itself controls activation through `getActiveTools`/`setActiveTools` during `session_start`.
22. Release verification **MUST** exercise a real TUI. Structural validation alone cannot prove component behavior, injected keybindings, focus, editor restoration, or native-addon watcher cleanup.
23. A competing custom editor is **not supported by this initial contract**. `pi-fff@0.1.12` calls `setEditorComponent` without reading/wrapping `getEditorComponent` ([source lines 40–45](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/index.ts#L40-L45)); Pi is last-writer-wins. If a prior editor exists when pi-fff installs its editor, the adapter **SHOULD** emit `PIFFF_TUI_EDITOR_CONFLICT` rather than claim composition.
24. Disabling autocomplete in the live feature dialog does not restore the previous/default editor immediately; pi-fff only avoids installing it on the next reload. The UI/diagnostic **SHOULD** tell the user to `/reload`. Tidy **MUST NOT** “fix” this by taking editor ownership.

## Exact observed `pi-fff@0.1.12` registration surface

Default feature state (all five enabled) produces exactly this trace. Source: [`register-tools.ts`](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/register-tools.ts#L35-L214), [`register-commands.ts`](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/register-commands.ts#L15-L145), and [`src/index.ts`](https://github.com/ShpetimA/pi-fff/blob/694837d0644abc8527ebfa3ea50135e0f5d1ece4/src/index.ts#L68-L112).

| # | Registration | Name | Required validation |
|---:|---|---|---|
| 1 | `registerTool` (captured) | `read` | label `read`; required `path:string`; optional `offset:number`, `limit:number`; exact Pi 0.80.6 read description plus FFF sentence; callable `execute`; no prompt/render metadata |
| 2 | `registerTool` (captured) | `grep` | label `grep`; required `pattern:string`; optional `mode,path,glob,constraints,cursor,outputMode:string`, `ignoreCase,literal:boolean`, `context,limit:number`; exact description, snippet, and four guidelines; callable `execute`; no renderers |
| 3 | `registerTool` (forwarded) | `find_files` | label/description/snippet/one guideline exact; required `query:string`; optional `limit:number`, `cursor:string`; callable `execute`; no renderers |
| 4 | `registerTool` (forwarded) | `fff_multi_grep` | exact metadata; required `patterns:string[]` with `minItems:1`; optional `path,glob,constraints,cursor,outputMode:string`, `context,limit:number`; callable `execute`; no renderers |
| 5 | `registerCommand` | `fff-features` | exactly two arguments; description `Toggle pi-fff features on or off`; callable `handler` |
| 6 | `registerCommand` | `reindex-fff` | description `Trigger an fff rescan for the current project`; callable `handler` |
| 7 | `registerCommand` | `fff-status` | description `Show fff runtime status and index health`; callable `handler` |
| 8 | `on` | `session_start` | exactly two arguments; callable handler |
| 9 | `on` | `session_shutdown` | exactly two arguments; callable handler |

**Counts:** 4 tools (2 captured + 2 forwarded), 3 commands, 2 event handlers; 9 calls total. **Absent:** shortcuts, flags, providers, provider removal, message renderers, entry renderers, event-bus registration, custom tool renderers, and registration-time action calls. The shipped README's mention of `resolve_file`, `related_files`, and `fff_grep` is stale; shipped code is authoritative.

Schemas should be canonicalized as JSON (sorted object keys while preserving array order) and compared to checked-in signatures. Metadata strings and guideline order are part of the contract because they affect the model prompt.

## Loader boundary

Keep all private coupling in one `loadPiFffFactory()` module with this conceptual interface:

```ts
type LoadedPiFff = {
  packageRoot: string;
  version: "0.1.12";
  factory: (pi: ExtensionAPI) => void | Promise<void>;
};

loadPiFffFactory(context): Promise<Result<LoadedPiFff, PiFffDiagnostic>>;
```

The rest of tidy should know only the loaded factory and validated trace, never Jiti paths or aliases.

For the initial tuple the loader **MUST**:

1. anchor `createRequire` to the canonical running Pi package root, not tidy's or pi-fff's root;
2. require Pi's installed Jiti **2.7.0**, use `moduleCache: false`, and import the selected absolute `index.ts` once;
3. alias `@mariozechner/pi-coding-agent` to Pi's concrete running coding-agent entry and `@mariozechner/pi-tui` to Pi's concrete running TUI entry; also preserve Pi's `@sinclair/typebox`/`typebox` aliases if the loader centralizes the full table;
4. never resolve legacy peers from pi-fff's package root, arbitrary global npm, or tidy dependencies;
5. validate the resulting default export before returning it.

This mirrors the relevant Pi loader behavior ([Jiti construction lines 341–360](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts#L341-L360)). It also avoids separate TUI class/singleton copies. Pi itself uses duck typing because `instanceof` may fail across Jiti boundaries ([interactive mode lines 2392–2404](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2392-L2404)); adapter validation should likewise test component shape, not `instanceof`.

Do not import Pi's unexported loader internals or copy loader discovery into unrelated tidy modules. A Pi patch that changes Jiti or aliases requires a new compatibility tuple and smoke run.

## Validation phases and fail-closed boundary

| Phase | Before factory? | Checks | On failure |
|---|---:|---|---|
| 0. Eligibility | yes | adapter enabled; exact Pi tuple | native `read`/`grep`; diagnostic |
| 1. Settings/root | yes | active npm identity, project precedence, `extensions: []`, canonical managed root | no factory invocation |
| 2. Artifact | yes | manifest identity/version/type/entry, optional lock integrity | no factory invocation |
| 3. Loader | yes | Pi root, Jiti 2.7.0, concrete aliases, callable default export | import may have occurred; no factory invocation |
| 4. Record | no | invoke once against side-effect-free registration recorder | discard trace; replay nothing |
| 5. Surface | no | exact 9-call trace, counts/order/names/arity, definitions/schemas/metadata/callables, both built-in feature registrations | discard trace; replay nothing |
| 6. Commit | no | replace calls 1–2, replay calls 3–9 in original slots | stop; require reload if any call committed |
| 7. Runtime | no | final registry uniqueness, command presence, result-shape guards, lifecycle/TUI observations | disable affected integration; never masquerade as FFF |

“Transactional” applies to Pi registration calls, not arbitrary JavaScript evaluation. A third-party factory can perform side effects before registering. Direct inspection shows `0.1.12` performs a synchronous feature-state read and registrations during factory execution; native runtime/watcher creation is deferred to `session_start`. Exact version gating keeps this residual boundary narrow.

## Diagnostic taxonomy

Diagnostics should have a stable code, severity, one-line summary, detected/expected detail, and a concrete next action. Show one startup notification; expose full detail through `/tidy status`. Do not dump stacks by default or include file contents.

| Code | Severity | Condition | Actionable message template |
|---|---|---|---|
| `PIFFF_CONFIG_MISSING` | warning | no active npm package entry | `pi-fff adapter inactive: no npm:pi-fff package entry. Run /tidy pi-fff setup, then /reload.` |
| `PIFFF_CONFIG_FILTER_REQUIRED` | error | entry is string form or `extensions` is not `[]` | `pi-fff must be installed with extensions: [] so its factory runs once. Run /tidy pi-fff setup; do not enable pi-fff standalone.` |
| `PIFFF_SCOPE_SHADOWED_INVALID` | error | project entry wins but its artifact/config is invalid | `Project pi-fff shadows the user install and is invalid: <reason>. Fix/remove the project entry; tidy will not fall back to the user copy.` |
| `PIFFF_PACKAGE_MISSING` | error | selected managed root/package manifest absent | `Configured pi-fff is not installed in the selected <project|user> Pi npm root. Run pi install <scope option> npm:pi-fff@0.1.12, preserve extensions: [], then /reload.` |
| `PIFFF_PACKAGE_IDENTITY` | error | manifest name/type/pi entry or canonical path wrong | `Expected npm package pi-fff with ESM entry ./index.ts; found <safe summary>. Reinstall pi-fff@0.1.12 through Pi.` |
| `PIFFF_VERSION_UNSUPPORTED` | error | version is not exactly allowed | `pi-fff <found> is not validated with Pi <pi>. Install pi-fff@0.1.12 or disable the adapter; no semver fallback was attempted.` |
| `PIFFF_PI_UNSUPPORTED` | error | running Pi not exactly allowed | `Pi <found> is not validated for the pi-fff adapter (expected 0.80.6). Use a validated tuple or disable orchestration.` |
| `PIFFF_INTEGRITY_MISMATCH` | error | present lock integrity differs | `Installed pi-fff@0.1.12 does not match the published npm artifact. Reinstall it through Pi before retrying.` |
| `PIFFF_LOADER_UNAVAILABLE` | error | Pi root/Jiti/version/alias target unavailable | `Cannot construct the Pi 0.80.6 extension loader boundary: <stage>. Reinstall Pi 0.80.6; adapter stayed inactive.` |
| `PIFFF_LOAD_FAILED` | error | entry import throws, including native dependency load | `pi-fff@0.1.12 could not load from the selected Pi root: <sanitized cause>. Reinstall the package and verify @ff-labs/fff-node supports this platform.` |
| `PIFFF_FACTORY_INVALID` | error | default export not callable | `pi-fff entry did not export the validated factory. Reinstall pi-fff@0.1.12.` |
| `PIFFF_FACTORY_FAILED` | error | factory throws/rejects | `pi-fff factory failed before registration commit: <sanitized cause>. No pi-fff registrations were forwarded.` |
| `PIFFF_SURFACE_FEATURE_STATE` | error | `read` or `grep` omitted | `pi-fff must have both Built-in read enhancement and Built-in grep enhancement enabled for tidy composition. Re-enable them in /fff-features (standalone recovery if needed), then /reload.` |
| `PIFFF_SURFACE_CHANGED` | error | call trace/count/order/name/unknown registration differs | `pi-fff registration surface changed at call <n>: expected <expected>, found <found>. Install 0.1.12; adapter forwarded nothing.` |
| `PIFFF_TOOL_CONTRACT` | error | schema, metadata, or callable field differs | `pi-fff <tool> no longer matches the validated <schema|metadata|executor> contract. Adapter forwarded nothing; reinstall the validated version.` |
| `PIFFF_FORWARD_PARTIAL` | fatal | replay throws after one or more calls | `Pi rejected pi-fff registration <n>. This runtime may be partially registered; run /reload after fixing <cause>. Do not use FFF tools in this runtime.` |
| `PIFFF_REGISTRY_MISMATCH` | fatal | final tool/command counts are wrong | `Expected one read, one grep, two pi-fff custom tools, and three pi-fff commands after commit. Found <counts>. Run /reload; integration is disabled.` |
| `PIFFF_EXEC_RESULT_INVALID` | error | captured executor returns malformed result | `pi-fff <tool> returned an unsupported result shape. The call failed closed; update only to a validated compatibility tuple.` |
| `PIFFF_TUI_EDITOR_CONFLICT` | warning | another custom editor is already installed | `pi-fff autocomplete replaces an existing custom editor in 0.1.12. Disable one editor feature and /reload; editor composition is not supported.` |
| `PIFFF_TUI_RELOAD_REQUIRED` | info | autocomplete turned off while FFF editor remains live | `Autocomplete is saved off, but pi-fff restores the default editor only on reload. Run /reload.` |

Messages may include only the selected scope and documented Pi-relative roots by default. A debug view may include canonical paths after home contraction; never include environment values, config contents, query history, or source text.

## Automated verification matrix

These tests are release-blocking and deterministic.

| Area | Cases / assertions |
|---|---|
| Tuple policy | exact `0.80.6 × 0.1.12` accepts; adjacent Pi and every published pi-fff version reject unless separately allowlisted |
| Scope/config | user only; project only; both (project wins); invalid project + valid user (no fallback); missing entry; string entry; nonempty/omitted extension filter; non-npm/git/local ignored with proper diagnostic |
| Artifact | missing root/manifest/entry; wrong name/version/type/`pi.extensions`; entry escape/symlink; optional integrity match/mismatch |
| Loader | isolated package cannot resolve legacy peers ordinarily; aliased loader succeeds; exact Jiti version; alias targets are running Pi/TUI; default missing/noncallable/import throw sanitized |
| Factory transaction | sync/async factory; throw before/after recorded calls; no real registration before full validation; factory called exactly once |
| Surface snapshot | exact 9-call trace; each count/order/name; unknown shortcut/flag/provider/renderer/event rejected; each schema/metadata/guideline mutation rejected independently |
| Feature state | all five enabled succeeds; read disabled, grep disabled, both disabled each produce `PIFFF_SURFACE_FEATURE_STATE`; custom tools remain forwarded only on full success |
| Replay | mock Pi records composites and forwards in exact original order; all forwarded argument objects/handler identities unchanged; induced failure produces `PIFFF_FORWARD_PARTIAL` and no later calls |
| Composite schema | tidy `default`/`reasoning` add required reasoning without losing any FFF property/metadata; `result` is schema-identical; render ownership is tidy only |
| Executor transparency | strips only reasoning; preserves receiver and five arguments by identity; update callback passes through; resolved value/details/`terminate` identity preserved; thrown/aborted errors propagate |
| Result families | exact/fuzzy/missing `read`; indexed/native-fallback/error/paginated `grep`; custom tool disabled/unavailable/success/error details; truncation fields preserved |
| Registry | exactly one `read`/`grep`; `find_files`, `fff_multi_grep`, and three commands present; no duplicate-conflict report |
| Lifecycle | repeated start disposes old runtime; shutdown destroys native finder and clears cursors; start after reload creates fresh state; active custom tools follow feature state |
| Diagnostics | every code snapshot-tests summary/detail/action, safe path contraction, cause sanitization, and single-notification behavior |

The user/project installed-package probe from `90f6e27` should become a non-interactive integration fixture, updated to use the explicit alias boundary rather than incidental ambient resolution.

## Release-time/manual smoke matrix

Run against the packed tidy artifact, the exact npm pi-fff tarball, and real Pi 0.80.6. These checks are release-blocking but should not be faked in unit tests.

| Environment / flow | Manual evidence required |
|---|---|
| Linux user npm root | clean startup; no extension issues; one `read`/`grep`; fuzzy `read`; FFF `grep`; both custom tools; all commands |
| Linux project npm root | same checks; project trust/install; verify project-over-user selection when both exist |
| Real TUI autocomplete | `@partial`, quoted path with spaces, selection insertion, Escape, fallback to Pi path completion, no crash on abort |
| `/fff-features` | dialog width/focus/keys; cancel leaves state; save changes active tools; built-in enhancement changes after reload; autocomplete-off message tells user to reload |
| Editor ownership | no competing editor baseline; then editor loaded before and after adapter to confirm/document warning and last-writer behavior |
| Lifecycle | `/reload`, `/new`, `/resume`, `/fork`, and exit; no stale editor, duplicate handler, orphan watcher/native process, locked database, or old-runtime callback |
| Modes | TUI fully works; RPC commands/notifications work and `custom()` limitation is understood; JSON/print do not hang due to background resources |
| Native/platform | supported Linux architectures at minimum; macOS and Windows only when claimed, including native addon load and file watching |
| Filesystem edges | non-ASCII filename regression from [pi-fff PR #8](https://github.com/ShpetimA/pi-fff/pull/8); spaces; large repo; cwd outside git; requested grep scope outside initial workspace |
| Setup/teardown | setup writes filtered entry once; disabling/removing tidy restores the exact prior standalone pi-fff entry; reload has no duplicate registrations |

The 2026-07-11 real-TUI probe passed the baseline feature dialog and autocomplete rows. Competing-editor composition, all session replacement flows, macOS/Windows, and setup/teardown were **not** directly verified by this research.

## Residual risks

1. **No public factory ABI.** Importing another extension's entry and replaying registrations remains intentional private coupling. Exact allowlisting limits, but cannot remove, this risk.
2. **Evaluation is not sandboxed.** The recorder prevents Pi registration side effects, not arbitrary module/factory side effects. `0.1.12` was inspected completely; future artifacts require the same review.
3. **Legacy import bridge.** `pi-fff` declares wildcard `@mariozechner/*` peers while Pi is `@earendil-works/*`. The aliases are required for loadability and TUI identity. Pi alias or export changes require a new tuple. Pi's own history confirms cross-root module-resolution regressions are real ([Pi PR #1821](https://github.com/earendil-works/pi/pull/1821)); separate TUI copies can also split singleton state ([Pi issue #4748](https://github.com/earendil-works/pi/issues/4748)).
4. **Non-transactional commit.** Pi 0.80.6 has no unregister-tool/command/handler transaction. A replay failure after the first registration requires a full reload.
5. **Editor is last-writer-wins.** `pi-fff` does not compose with or restore a preexisting editor, and live disabling leaves its editor until reload. This is a declared unsupported coexistence case, not something tidy should conceal.
6. **Global config ownership.** Even a project npm install reads/writes feature state through running Pi's `getAgentDir()`. A project package does not imply project-local feature flags.
7. **Native runtime behavior.** `@ff-labs/fff-node` is a native dependency with platform, watcher, and indexing side effects. Open upstream issues include scanning a home directory/OneDrive ([#6](https://github.com/ShpetimA/pi-fff/issues/6)) and grep scope outside the initial workspace ([#4](https://github.com/ShpetimA/pi-fff/issues/4)). They are pi-fff behavior, not adapter compatibility, but belong in release smoke coverage.
8. **Error semantics are mixed.** Several pi-fff semantic failures return ordinary text results rather than throwing, so Pi does not mark them `isError`. Tidy must render the actual state without reclassifying execution.
9. **Unversioned upstream source.** npm `0.1.12` matches upstream source commit `694837d` except the manifest version, but there is no `v0.1.12` tag and the repository manifest remains `0.1.11`. The npm tarball, not `main`, is the release authority.
10. **Floating transitive dependencies.** The `0.1.12` manifest uses caret ranges. The research install resolved `@ff-labs/fff-node` 0.9.6, `better-result` 2.9.2, and `@sinclair/typebox` 0.34.51, but a later conforming install may resolve newer versions. Production should report resolved versions in debug status; release integration fixtures should lock them. Startup load/result guards reduce but do not eliminate semantic drift within those ranges.
11. **Documentation drift.** The shipped README lists tools no longer registered. Runtime trace and exact source must remain the contract authority.

## Source index

- Wayfinder map: [pi-tidy-tools #9](https://github.com/mikeyobrien/pi-tidy-tools/issues/9)
- Research ticket: [Define the pi-fff adapter compatibility contract](https://github.com/mikeyobrien/pi-tidy-tools/issues/12)
- Resolved prototype: [issue #10](https://github.com/mikeyobrien/pi-tidy-tools/issues/10), [commit `90f6e27`](https://github.com/mikeyobrien/pi-tidy-tools/commit/90f6e27b1d62fb3317e939b7e87af2bb738b43fd)
- Pi 0.80.6 release: [tag commit `2b3fda9`](https://github.com/earendil-works/pi/commit/2b3fda9921b5590f285165287bd442a25817f17b)
- Pi docs read in full: [extensions.md](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/extensions.md), [packages.md](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/packages.md), [tui.md](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/docs/tui.md)
- Pi loader/API/TUI: [`loader.ts`](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/loader.ts), [`types.ts`](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/core/extensions/types.ts), [`interactive-mode.ts`](https://github.com/earendil-works/pi/blob/2b3fda9921b5590f285165287bd442a25817f17b/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- Exact pi-fff artifact: [`pi-fff-0.1.12.tgz`](https://registry.npmjs.org/pi-fff/-/pi-fff-0.1.12.tgz)
- Matching upstream source tree: [`694837d`](https://github.com/ShpetimA/pi-fff/tree/694837d0644abc8527ebfa3ea50135e0f5d1ece4)
- Version-policy history: tool removals in [v0.1.7 release](https://github.com/ShpetimA/pi-fff/releases/tag/v0.1.7), load-time feature registration change [`2411eaf`](https://github.com/ShpetimA/pi-fff/commit/2411eaf0b21bc4652a81b28b127e8eeeb11d91c6), split read/grep flags [`5689be7`](https://github.com/ShpetimA/pi-fff/commit/5689be7a60462190aedb92b97605aff451784c7f), native dependency change [PR #8](https://github.com/ShpetimA/pi-fff/pull/8)
