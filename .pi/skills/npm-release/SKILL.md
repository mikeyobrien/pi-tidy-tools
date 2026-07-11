---
name: npm-release
description: Creates and verifies a new @mobrienv/pi-tidy-tools release through GitHub Releases and npm Trusted Publishing. Use when asked to cut, publish, or monitor a patch, minor, major, or explicit-version release for this repository.
compatibility: Requires Node.js 22.19+, npm, git, GitHub CLI authentication, and push access to mikeyobrien/pi-tidy-tools.
---

# npm Release

Release `@mobrienv/pi-tidy-tools` through `.github/workflows/publish.yml`. GitHub Releases trigger tokenless npm Trusted Publishing with provenance.

## Safety rules

- Run only from the repository root.
- Never request, store, print, or configure an npm token. Publishing uses GitHub OIDC.
- Do not publish directly with `npm publish`.
- Do not overwrite or reuse a version or tag.
- Stop if the working tree is dirty, the current branch is not `main`, validation fails, `main` cannot push, or the target npm version already exists.
- Do not use `--force`, rewrite tags, amend unrelated commits, or bypass tests.
- Ask the user when the requested release level/version is ambiguous. Default to `patch` only when the user explicitly says to create the next release without specifying a level.

## Inputs

Accept one of:

- `patch`, `minor`, or `major`
- An explicit semver such as `0.2.0`

Normalize an explicit `v0.2.0` input to `0.2.0` before passing it to npm.

## Procedure

### 1. Preflight

```bash
git status --short
git branch --show-current
git fetch origin main --tags
git rev-list --left-right --count origin/main...main
npm whoami
npm view @mobrienv/pi-tidy-tools version --json
```

Require:

- Empty `git status --short`
- Branch `main`
- Local `main` neither ahead nor behind `origin/main`
- npm identity is `mobrienv`

Confirm `.github/workflows/publish.yml` still has `id-token: write`, uses the `npm` environment, and contains no `NODE_AUTH_TOKEN` or `NPM_TOKEN` reference.

### 2. Validate the candidate

```bash
npm ci
npm test
npm run check
npm pack --dry-run
```

Inspect the pack output. It should contain only the allowlisted runtime files and documentation images from `package.json`.

### 3. Select and guard the version

For a release level, let `npm version` calculate the next version. For an explicit version, use that exact semver.

Before creating the release, confirm the target does not already exist:

```bash
git rev-parse -q --verify "refs/tags/v<TARGET>"
npm view "@mobrienv/pi-tidy-tools@<TARGET>" version --json
```

Both checks should report no existing target. Treat npm `E404` as expected absence; treat other npm errors as failures.

### 4. Create and push the version commit and tag

```bash
npm version <patch|minor|major|EXPLICIT_VERSION> -m "chore: release v%s"
git push origin main --follow-tags
```

Record the version printed by `npm version` and use that exact `vX.Y.Z` tag below.

### 5. Create the GitHub Release

```bash
gh release create "vX.Y.Z" \
  --verify-tag \
  --generate-notes \
  --title "vX.Y.Z"
```

The published GitHub Release triggers `.github/workflows/publish.yml`.

### 6. Track publishing to completion

Locate the release-triggered run rather than an older manual run:

```bash
gh run list \
  --workflow publish.yml \
  --event release \
  --limit 5 \
  --json databaseId,headBranch,status,conclusion,url
```

Choose the run whose `headBranch` is `vX.Y.Z`, then block until completion:

```bash
gh run watch <RUN_ID> --exit-status
```

If it fails, inspect only the failed logs:

```bash
gh run view <RUN_ID> --log-failed
```

Do not retry blindly. Diagnose and fix the cause, then ask before creating another version.

### 7. Verify npm and repository state

Allow a brief registry propagation delay, then verify:

```bash
npm view @mobrienv/pi-tidy-tools version dist.integrity --json
gh run view <RUN_ID> --json conclusion,url,headSha
git status --short
```

Success requires:

- Workflow conclusion `success`
- npm reports exactly `X.Y.Z`
- npm returns a `dist.integrity`
- Working tree is clean

## Final report

Report concisely:

- Published package and version
- Git tag and release URL
- Workflow URL and conclusion
- Validation performed
- npm integrity value
- Any warnings or follow-up work

Tell the user the work is on `main` and can be viewed with:

```bash
git checkout main
```
