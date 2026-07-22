# Operations

This guide covers the supported single-user profile: native Pi adapter, one chosen static Hindsight bank, `dynamicBankId: false`, and synchronous retention. Replace placeholders such as `<expected-bank-id>` with deployment values kept in an external installation receipt; distributable package documentation must not hard-code an operator's bank or filesystem layout.

## Installation pin

Choose a reviewed full commit from an external release or installation receipt. Never use a moving branch, an abbreviated hash, or a hash hard-coded inside the source commit itself—the repository cannot truthfully contain its own final commit hash.

Build the exact artifact and record its digest:

```bash
npm pack \
  --workspace @mobrienv/pi-tidy-memory \
  --pack-destination <artifact-directory>
sha256sum <artifact-directory>/mobrienv-pi-tidy-memory-*.tgz
```

`npm pack` embeds the checked-out full Git revision in `source-revision.json` and ships that file in the tarball. Runtime revision reporting reads only the validated file. Static-bank startup performs no Git probing; optional dynamic project routing may inspect local Git metadata but does not contact a remote.

Smoke the tarball from an isolated npm host with the target Pi peer versions available:

```bash
mkdir <temporary-host> && cd <temporary-host>
npm init -y
npm install <absolute-path-to-tarball>
npm run smoke --prefix node_modules/@mobrienv/pi-tidy-memory
```

The smoke imports the installed compiled extension, validates package identity and the native `./index.ts` Pi adapter, and requires the reported revision to match the embedded full hash. It is offline and read-only.

## Installation modes

### Pi-managed Git checkout

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@<verified-full-commit>
cd <pi-managed-checkout>
npm run revision:embed --workspace @mobrienv/pi-tidy-memory
pi install ./packages/pi-tidy-memory
```

Use the checkout path reported by the Pi installer. Managed-package locations are host-specific and must not be inferred from another deployment.

### Explicit local path

Pi can load a package from an explicit local path in its `packages` settings. Treat that directory as a deployed artifact, not a moving development checkout:

1. Build and smoke the exact tarball in a separate staging directory.
2. Install its production dependency there; Pi supplies the declared Pi peer packages.
3. Preserve the active package and config as rollback copies.
4. Replace the active directory atomically while automatic retention is disabled.
5. Start a fresh Pi process and compare `/tidy-memory status` with the receipt before enabling writes.

Do not claim that the active path matches a reviewed commit merely because a source checkout does. Compare the installed files, embedded revision, and artifact digest.

## Installation receipt

Store the receipt outside the source tree and never include credentials. At minimum record:

```json
{
  "sourceRevision": "<reviewed-40-character-commit>",
  "artifactSha256": "<sha256-of-installed-tarball>",
  "artifactName": "<tarball-filename>",
  "activePath": "<installed-package-path>",
  "installedAt": "<ISO-8601-timestamp>",
  "configBeforePath": "<protected-backup-path>",
  "rollbackPackagePath": "<protected-backup-path>",
  "expectedBankId": "<expected-bank-id>",
  "verification": {
    "installedArtifactSmoke": "passed",
    "activeBytesMatchArtifact": true,
    "reportedSourceRevision": "<reviewed-40-character-commit>",
    "authenticatedReadOnlyCheck": "passed",
    "syntheticLiveRetainPerformed": false
  }
}
```

Protect receipts and config backups with mode `600` when they expose local paths or operational metadata. Keep the receipt and rollback directory until a later independently verified upgrade supersedes them.

## Two-phase activation

Package installation and retention policy are separate gates. Do not enable automatic writes merely because source tests passed.

### Phase 1: install while writes remain disabled

1. Require `lifecycle.autoRetain: false` in the active config. Keep `backend.asyncRetain: false` so later success means Hindsight completed the request.
2. Back up the active package and config, then install the exact reviewed artifact.
3. Start a fresh Pi process. An orchestrator with an isolated home should pin Pi's real configuration directory explicitly rather than accepting an empty default profile.
4. Run `/tidy-memory status` and require:
   - the expected package name and version;
   - the exact source revision from the receipt;
   - `bank=<expected-bank-id>` with no unexpected prefix or derived suffix;
   - the credential variable reported as present without its value;
   - `autoRetain=false`.
5. Run `/tidy-memory check`. It performs authenticated `GET /memories/list?limit=0`, returns no memory content, and writes nothing.
6. Verify active bytes against the staged artifact and confirm rollback copies are readable.

### Phase 2: authorize and enable retention

1. Obtain the deployment owner's explicit approval after Phase 1 evidence is green.
2. Change only the reviewed policy fields. For synchronous automatic retention, keep `backend.asyncRetain: false` and set `lifecycle.autoRetain: true` together.
3. Start another fresh Pi process and repeat status plus the authenticated read-only check.
4. Confirm the selected bank, exact source revision, and lifecycle settings. Do not create a synthetic record in the live bank merely to prove activation.
5. Complete a narrow independent read-only review of active bytes, embedded revision, config, permissions, receipt, and rollback readiness.

If any package, revision, routing, credential, or rollback check fails, keep automatic retention disabled and restore the prior package/config before investigating.

## Upgrade

Treat every upgrade as a move between reviewed full commit hashes, not branches or abbreviated revisions.

1. Record current status and the installation receipt.
2. Review the candidate and run its normal tests, type checks, pack gate, and installed-artifact smoke.
3. Execute both phases above using a new staging and rollback directory.
4. Preserve the prior receipt until the new post-deployment review passes.

An npm publication, signed release, durable outbox, or receipt-polling service is not required for this local single-user profile.

## Credential rotation

The process environment takes precedence over `envFile`, so rotation must account for both sources.

1. Write the new credential to the protected environment source without printing it. Keep env files outside Git with mode `600`.
2. Fully exit and restart Pi. `/reload` reloads extensions but does not replace the parent process environment.
3. Run status and require the configured variable to be present.
4. Run the authenticated read-only check against `<expected-bank-id>`.
5. Revoke the old credential only after the restarted process passes.

Neither status nor check should print a credential. If either does, stop using the integration and treat the output as exposed.

## Rollback

Software rollback does not undo writes already accepted by Hindsight.

1. Stop new automatic retention by exiting Pi or restoring `autoRetain: false`.
2. Restore the previous package and config from the protected rollback directory, or reinstall the previous reviewed full commit from its receipt.
3. Start a fresh Pi process and run status plus the authenticated read-only check.
4. Resume retention only after the previous source revision, expected static bank, credential presence, and read access are verified.

Do not delete, recreate, retag, or migrate the selected bank as part of software rollback.

## Troubleshooting

| Symptom                              | Check                                                                     | Corrective action                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/tidy-memory` is missing            | Pi's effective `packages` settings and active configuration directory     | Add the managed package or explicit local path, then start a fresh Pi process          |
| Status reports `source=unknown`      | Installed `source-revision.json` and compiled package output              | Rebuild/reinstall the packed artifact; do not infer provenance from a nearby checkout  |
| Status reports the wrong source hash | Active path versus receipt and staged artifact                            | Keep writes disabled and restore or replace the package atomically                     |
| Status reports the wrong bank        | `bankId`, `dynamicBankId`, prefixes, granularity, and directory maps      | Correct routing before retaining; changing IDs does not migrate memory                 |
| Credential is absent                 | Process environment, then configured `envFile` and mode                   | Correct the protected source and fully restart Pi                                      |
| Check returns authentication failure | Credential rotation state and backend URL                                 | Restore a valid credential; never paste it into config or logs                         |
| Config is rejected                   | JSON boolean types and strict top-level/backend/lifecycle/provenance keys | Remove unknown keys or correct malformed values rather than relying on silent coercion |
| New config appears ignored           | Parent process environment and actual Pi configuration directory          | Start a fresh process with the intended configuration directory                        |
| Retain reports failure               | Hindsight availability and synchronous request result                     | Treat it as not retained; there is no retry, replay, polling, or outbox service        |

## Write-path integration tests

Standard operational checks are read-only. If a write-path integration test is genuinely required, use a uniquely named ephemeral bank, never the live bank. The test is incomplete until the ephemeral bank is deleted through Hindsight's control plane and a follow-up lookup verifies cleanup. Do not leave test facts or temporary banks behind.
