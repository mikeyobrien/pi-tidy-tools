# Operations

This guide is for the supported single-user installation: native Pi adapter, one static Hindsight bank named `mobrienv`, `dynamicBankId: false`, and synchronous retention.

## Installation pin

Choose a reviewed full commit from an external release or installation receipt. Never use a moving branch, an abbreviated hash, or a hash hard-coded inside the source commit itself—the repository cannot truthfully contain its own final commit hash.

Install and embed the selected revision:

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@<verified-full-commit>
cd ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools
npm run revision:embed --workspace @mobrienv/pi-tidy-memory
pi install ./packages/pi-tidy-memory
```

The embed command writes an ignored `source-revision.json` from the checked-out full Git hash. `npm pack` runs the same step and ships the file in the tarball. Revision reporting reads only that validated file. The supported static-bank configuration performs no Git probing at startup; optional dynamic bank routing with project scope may inspect local Git metadata but does not contact a remote.

After Pi starts, run:

```text
/tidy-memory status
/tidy-memory check
```

Require all of the following before use:

- status reports `package=@mobrienv/pi-tidy-memory@0.1.0`;
- status reports the exact `<verified-full-commit>` from the installation receipt;
- status reports `bank=mobrienv`, never a derived or prefixed bank;
- status reports the credential variable as present without printing its value;
- check reports authenticated read access.

`/tidy-memory check` performs a zero-item bank read. It does not retain or return memory content.

## Upgrade

Treat every upgrade as a move between reviewed full commit hashes, not branches or abbreviated revisions.

1. Record `/tidy-memory status` and the current external installation receipt. Back up `~/.pi/agent/pi-tidy-memory/config.json` without copying credentials into the repository.
2. Review the candidate commit and run the repository's normal tests, type checks, and pack gate. Do not require an npm publication or signed release.
3. Reconcile Pi's managed checkout and regenerate the embedded revision:

   ```bash
   pi install git:github.com/mikeyobrien/pi-tidy-tools@<new-verified-full-commit>
   cd ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools
   npm run revision:embed --workspace @mobrienv/pi-tidy-memory
   pi install ./packages/pi-tidy-memory
   ```

4. In Pi, run `/reload`, then `/tidy-memory status` and `/tidy-memory check`.
5. Confirm the exact new source hash and `bank=mobrienv` before allowing retains. Keep `dynamicBankId: false` and `asyncRetain: false` unchanged.
6. Store the verified commit outside the source tree as the new installation receipt.

A packed artifact can be checked independently by running `npm run smoke` from the extracted or installed package root. That smoke imports the installed compiled extension entry, validates package identity and the native `./index.ts` Pi adapter, and requires the compiled status revision to match the embedded full hash. It is offline and read-only. It is not a substitute for `/tidy-memory check` against Hindsight.

## Credential rotation

The process environment takes precedence over `envFile`, so rotation must account for both sources.

1. Write the new credential to the protected environment source without printing it. Keep an env file outside Git with mode `600`.
2. Fully exit and restart the Pi process. `/reload` reloads extensions but does not replace the parent process environment.
3. Run `/tidy-memory status` and require the configured variable to be reported as present.
4. Run `/tidy-memory check` and require authenticated read access to `mobrienv`.
5. Revoke the old credential only after the restarted process passes the check.

Neither status nor check should print a credential. If either does, stop using the integration and treat the output as exposed.

## Rollback

Rollback means resetting the managed source checkout to the last known-good full commit from the prior external installation receipt. It does not roll back writes already accepted by Hindsight.

1. Stop new retention and preserve the failing status/check output without credentials.
2. Reinstall and re-embed the prior known-good commit:

   ```bash
   pi install git:github.com/mikeyobrien/pi-tidy-tools@<last-known-good-full-commit>
   cd ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools
   npm run revision:embed --workspace @mobrienv/pi-tidy-memory
   pi install ./packages/pi-tidy-memory
   ```

3. Restore the prior config only if the failed upgrade changed it. Preserve `bankId: "mobrienv"`, `dynamicBankId: false`, and `asyncRetain: false`.
4. Run `/reload`, `/tidy-memory status`, and `/tidy-memory check`.
5. Resume retention only after the exact source pin, static bank, credential presence, and read check are all verified.

Do not delete or recreate `mobrienv` as part of software rollback. External memory and accepted writes have their own lifecycle.

## Write-path integration tests

The standard operational checks are read-only. If a write-path integration test is genuinely required, use a uniquely named ephemeral bank, never `mobrienv`. The test is incomplete until the ephemeral bank is deleted through Hindsight's control plane and a follow-up lookup verifies that cleanup. Do not leave test facts or temporary banks behind.
