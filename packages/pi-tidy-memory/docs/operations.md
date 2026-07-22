# Operations

This guide is for the supported single-user installation: native Pi adapter, one static Hindsight bank named `mobrienv`, `dynamicBankId: false`, and synchronous retention.

## Installed baseline

The current immutable source pin is:

```text
069c46fd63a37343e34f758dab7055a85a3ae452
```

Install it through Pi, then register the package directory from Pi's managed Git checkout:

```bash
pi install git:github.com/mikeyobrien/pi-tidy-tools@069c46fd63a37343e34f758dab7055a85a3ae452
pi install ~/.pi/agent/git/github.com/mikeyobrien/pi-tidy-tools/packages/pi-tidy-memory
```

After Pi starts, run:

```text
/tidy-memory status
/tidy-memory check
```

Require all of the following before use:

- status reports `package=@mobrienv/pi-tidy-memory@0.1.0`;
- status reports `source=069c46fd63a37343e34f758dab7055a85a3ae452` for the managed Git install;
- status reports `bank=mobrienv`, never a derived or prefixed bank;
- status reports the credential variable as present without printing its value;
- check reports authenticated read access.

`/tidy-memory check` performs a zero-item bank read. It does not retain or return memory content.

## Upgrade

Treat every upgrade as a move between full commit hashes, not branches or abbreviated revisions.

1. Record `/tidy-memory status` and the current pin. Back up `~/.pi/agent/pi-tidy-memory/config.json` without copying credentials into the repository.
2. Review the candidate commit and run the repository's normal tests, type checks, and pack gate. Do not require an npm publication or signed release.
3. Reconcile Pi's managed checkout to the candidate:

   ```bash
   pi install git:github.com/mikeyobrien/pi-tidy-tools@<new-full-commit>
   ```

4. In Pi, run `/reload`, then `/tidy-memory status` and `/tidy-memory check`.
5. Confirm the exact new source hash and `bank=mobrienv` before allowing retains. Keep `dynamicBankId: false` and `asyncRetain: false` unchanged.

A packed artifact can be checked independently by running `npm run smoke` from the extracted or installed package root. That smoke verifies package identity, the native `./index.ts` Pi adapter, shipped source/build files, and revision formatting. It is offline and read-only. It is not a substitute for `/tidy-memory check` against Hindsight.

## Credential rotation

The process environment takes precedence over `envFile`, so rotation must account for both sources.

1. Write the new credential to the protected environment source without printing it. Keep an env file outside Git with mode `600`.
2. Fully exit and restart the Pi process. `/reload` reloads extensions but does not replace the parent process environment.
3. Run `/tidy-memory status` and require the configured variable to be reported as present.
4. Run `/tidy-memory check` and require authenticated read access to `mobrienv`.
5. Revoke the old credential only after the restarted process passes the check.

Neither status nor check should print a credential. If either does, stop using the integration and treat the output as exposed.

## Rollback

Rollback means resetting the managed source checkout to the last known-good full commit. It does not roll back writes already accepted by Hindsight.

1. Stop new retention and preserve the failing status/check output without credentials.
2. Reinstall the known-good baseline:

   ```bash
   pi install git:github.com/mikeyobrien/pi-tidy-tools@069c46fd63a37343e34f758dab7055a85a3ae452
   ```

3. Restore the prior config only if the failed upgrade changed it. Preserve `bankId: "mobrienv"`, `dynamicBankId: false`, and `asyncRetain: false`.
4. Run `/reload`, `/tidy-memory status`, and `/tidy-memory check`.
5. Resume retention only after the exact source pin, static bank, credential presence, and read check are all verified.

Do not delete or recreate `mobrienv` as part of software rollback. External memory and accepted writes have their own lifecycle.

## Write-path integration tests

The standard operational checks are read-only. If a write-path integration test is genuinely required, use a uniquely named ephemeral bank, never `mobrienv`. The test is incomplete until the ephemeral bank is deleted through Hindsight's control plane and a follow-up lookup verifies that cleanup. Do not leave test facts or temporary banks behind.
