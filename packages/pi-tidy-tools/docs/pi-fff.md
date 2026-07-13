# pi-fff integration contract

Deep reference for the optional pi-fff integration in pi-tidy-tools: capability
profiles, settings and sidecar mechanics, ownership states, the verification
policy, drift recovery, manual restoration, and editor caveats. For day-to-day
usage — install, setup, status, teardown — see the
[README](../README.md#optional-pi-fff-execution).

## Capability profiles

pi-fff is optional and remains a separately installed Pi package. It is not
bundled by, or a peer dependency of, pi-tidy-tools. Two capability profiles are
supported, both on Pi **0.80.6+** and with no upper version bound:

- **Legacy:** [`pi-fff`](https://www.npmjs.com/package/pi-fff) **0.1.12+**;
  captures its enhanced `read`/`grep` and composes tidy presentation.
- **Scoped:** [`@ff-labs/pi-fff`](https://www.npmjs.com/package/@ff-labs/pi-fff)
  **0.6.0+**; captures exactly `ffgrep` and `fffind`, exposes them only as
  tidy-presented `grep` and `find`, and preserves their FFF execution, schemas,
  metadata, and prompt guidance. Native tidy `read` remains unchanged. Optional
  `fff-multi-grep`, the three floor flags (plus current 0.9.5+ root-scan flag),
  three commands, lifecycle, autocomplete, and compatible additions replay once
  in source order. Scoped override mode is rejected because its raw
  `grep`/`find` surface conflicts with this contract.

## Setup and teardown mechanics

Setup previews every discovered user/project settings change and requires
confirmation. It first validates every installed participant, then atomically
changes each pi-fff package entry to object form with `extensions: []`. This
prevents standalone pi-fff and tidy's adapter from registering the same tools.
Linked `pi-tidy-tools.pi-fff.json` sidecars preserve each exact prior entry.
After every settings file reaches its target, setup and teardown durably mark all
linked sidecars `reload-pending`, then await Pi's reload. Replacement startup at
the target atomically commits setup sidecars or retires teardown sidecars before
routing tools; successful post-reload cleanup is idempotent. The old controller
frame never initializes routing after a requested or rejected reload. A failed
or aborted reload reports `recovery-pending`, leaves every linked journal pending,
and only the next actual startup finalizes it at that same safe boundary.

## Ownership and scope

`/tidy pi-fff status` reports one of these truthful states:

- `absent` — tidy presents native Pi `read`/`grep`.
- `standalone` — legacy pi-fff owns `read`/`grep`; standalone scoped pi-fff loads its own raw tools outside tidy's ownership. Run setup to hide those raw names and establish managed routing.
- `filtered-unmanaged` — neither extension claims them until explicit setup.
- `managed-compatible` — for legacy, pi-fff executes `read`/`grep` and tidy
  owns their schema/rendering; for scoped, status reports `tidy/native read +
FFF-executed tidy grep/find`: native tidy owns `read`, FFF owns `grep`/`find`
  execution, tidy owns their public names/schema/rendering, and raw names are hidden.
- `managed-invalid` — validation failures before commit leave native Pi/tidy
  ownership intact. A fatal `PIFFF_FORWARD_PARTIAL` instead reports
  `unsafe partial registration; reload required`: ownership is unknown after a
  replay failure, later registrations stop, and no native/tidy/FFF claim is safe
  until `/reload`.
- `recovery-pending` — native Pi owns them while journal recovery awaits reload.
- `disabled` — native Pi owns them. Turning tidy off never edits Pi package
  settings; the committed sidecars remain available for later teardown.

Pi package precedence still applies when every participating scope selects the
same identity: a project pi-fff entry shadows the user entry, with no fallback
from a broken project install. All project and user participants must select one
global package identity (`pi-fff` or `@ff-labs/pi-fff`); mixed identities across
scopes, both identities within one scope, and duplicates are ambiguous and
rejected. Setup preflights and journals every participant it discovers;
teardown restores the exact source string and entry in each scope.

## Verification policy

The exact Pi `0.80.6` × `pi-fff@0.1.12` and Pi `0.80.6` ×
`@ff-labs/pi-fff@0.9.6` tuples are `verified`. Newer tuples at or above their
profile floors are eligible after structural capability validation and
are shown as `forward-compatible/unverified` until that exact tuple passes the
release smoke matrix. This status is not a claim that a newer release is
broken. Release maintainers must run:

```bash
npm run test:pi-fff-release-matrix --workspace @mobrienv/pi-tidy-tools -- --latest
npm run test:pi-fff-tui --workspace @mobrienv/pi-tidy-tools
```

The first command requires npm registry access and tests baseline/newest mixed
tuples; an unavailable registry is a **blocked release gate**, never a silently
skipped pass. The ordinary installed fixture is hermetic with respect to tuple
selection and runs the pinned baseline.

## Drift, recovery, and removal

Interrupted setup/teardown is recovered at startup before ordinary ownership is
claimed. A complete linked `reload-pending` transition already at its target is
finalized immediately; an earlier interruption may ask for one `/reload`. Drift
or malformed/missing linked state fails closed and `/tidy pi-fff status` reports
the concrete settings paths requiring manual attention. Do not edit managed
package entries or sidecars independently.

Always run `/tidy pi-fff teardown` **before** removing pi-tidy-tools or pi-fff.
Teardown restores the exact prior package entries, including sibling fields and
standalone extension filters. If automatic recovery says manual restoration is
required, inspect every linked `pi-tidy-tools.pi-fff.json`, restore each
`priorEntry` at its recorded `entryIndex` in the recorded `settingsPath`, remove
the sidecars only after all scopes agree, and then run `/reload`. Keep backups
and do not copy a project entry into the user scope (or vice versa).

## Editor caveats

Legacy pi-fff `0.1.12` installs a custom autocomplete editor and does not compose with
another custom editor; it is last-writer-wins. Tidy warns when one is already
installed. Disable one editor feature and `/reload`. Turning autocomplete off
in `/fff-features` persists the setting but the current editor remains active
until `/reload`. These are pi-fff editor/lifecycle constraints; tidy does not
take over or mask them.

## Related research

- [pi-fff adapter compatibility contract](../../../docs/research/pi-fff-adapter-compatibility-contract.md)
  — local evidence for how tidy captures FFF registrations and preserves
  execution semantics.
