---
name: npm-release
description: Releases one @mobrienv/pi-tidy-* workspace through GitHub and npm Trusted Publishing. Use when asked to prepare changelog entries, cut, publish, or monitor a patch, minor, major, or explicit-version release.
compatibility: Requires Node.js 22.19+, npm, git, GitHub CLI authentication, and push access to mikeyobrien/pi-tidy-tools.
---

# npm Release

Release one workspace through `.github/workflows/publish.yml`. Every package owns its manifest, version, changelog, and package-qualified tag. GitHub Releases trigger tokenless npm Trusted Publishing with provenance.

## Inputs

Resolve:

1. Package: `pi-tidy-<name>` or `@mobrienv/pi-tidy-<name>`
2. Version: `patch`, `minor`, `major`, or an explicit SemVer

If the package is omitted, infer it only when the repository has exactly one publishable workspace; otherwise ask. Normalize the package to:

```text
SLUG=pi-tidy-<name>
PACKAGE=@mobrienv/$SLUG
DIR=packages/$SLUG
```

Normalize `v0.2.0` to `0.2.0`. The release tag is `$SLUG-v<TARGET>`.

## Safety

- Run from the repository root with a clean `main` synchronized to `origin/main`.
- Publish functional releases only through a GitHub Release and `.github/workflows/publish.yml`. The sole exception is the explicitly approved `0.0.0` first-package bootstrap below; never publish functional package code locally.
- Use GitHub OIDC. Keep npm tokens absent from prompts, files, output, and workflow configuration.
- Preserve independent package versions. Update only the selected manifest, its changelog, and the root lockfile.
- Stop on ambiguous input, failed validation, an existing npm version/tag/changelog heading, or a package with no user-visible changes.
- Preserve history: annotated tags are immutable; commits are not amended or force-pushed.
- Changelog entries describe observable behavior, with implementation-only work omitted.

## Changelog contract

The selected package owns `$DIR/CHANGELOG.md`, using Keep a Changelog 1.1.0 and SemVer:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

### Added

- User-visible addition.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/SLUG-vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/mikeyobrien/pi-tidy-tools/compare/PREVIOUS_TAG...SLUG-vX.Y.Z
```

Use sections in this order and omit empty sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

Each bullet carries one user-visible change. Put breaking changes first and label them **BREAKING**. Name migration paths for deprecations. Keep internal helpers, tests, refactors, file paths, CI mechanics, and reverted work out of the changelog unless users must act on them. Inspect code changes as the primary source and commits as intent.

## Procedure

### 1. Resolve and preflight

List publishable workspaces and resolve the input before changing files:

```bash
npm pkg get name version private --workspaces
git status --short
git branch --show-current
git fetch origin main --tags
git rev-list --left-right --count origin/main...main
gh auth status
npm view "$PACKAGE" version --json
```

Require `$DIR/package.json`, package name exactly `$PACKAGE`, an empty working tree, branch `main`, no ahead/behind count, and valid GitHub authentication. Treat npm `E404` for the unversioned package lookup as a first-publication signal, not proof that OIDC is ready: npm cannot attach a trusted publisher until the package record exists.

Confirm `.github/workflows/publish.yml` has `id-token: write`, uses environment `npm`, has no alternate functional trigger such as `workflow_dispatch`, pins third-party actions to full commit hashes, disables persisted checkout credentials and `setup-node` package-manager caching, installs the lockfile with `npm ci --ignore-scripts`, resolves release tags to an allowlisted public workspace path, publishes with `--workspace`, and contains no `NODE_AUTH_TOKEN` or `NPM_TOKEN` reference.

### 1a. Bootstrap a new npm package record when required

Run this step only when `npm view "$PACKAGE" version --json` returns a genuine registry `E404`. Do not create the target release commit, tag, or GitHub Release first: the OIDC workflow cannot publish a package that does not yet exist.

This is an irreversible external action and requires the owner's explicit approval. In an isolated temporary directory, prepare a public `0.0.0` placeholder containing only:

- `package.json` with the exact package name, version `0.0.0`, public access, license, description, and repository metadata;
- a README stating that the artifact is a non-functional Trusted Publishing bootstrap and that functional releases begin at the approved `TARGET`;
- no package runtime, scripts, dependencies, credentials, or repository checkout files.

Inspect `npm pack --dry-run` and the actual tarball before the owner publishes that temporary directory once with interactive npm authentication, 2FA, `--access public`, and `--tag oidc-bootstrap`. The dedicated dist-tag prevents the non-functional placeholder from becoming `latest` while trust is configured. Never substitute the real workspace package or a pre-release functional build for the placeholder.

After `npm view "$PACKAGE@0.0.0" version --json` succeeds and `npm view "$PACKAGE" dist-tags --json` reports `oidc-bootstrap: 0.0.0` with no `latest`, configure the package's npm Trusted Publisher exactly as follows:

```text
provider: GitHub Actions
organization/user: mikeyobrien
repository: pi-tidy-tools
workflow: publish.yml
environment: npm
allowed action: npm publish
```

Then require two-factor authentication and disallow ordinary tokens for publishing. Verify the saved publisher fields and package access in npm's settings before continuing. The placeholder gets no repository tag, GitHub Release, or changelog section; it exists only to break npm's first-publish/OIDC dependency cycle. All functional versions still follow the tokenless GitHub process below.

### 2. Determine and guard the target

Read the current version from `$DIR/package.json`. Calculate the requested bump without editing files. An explicit version must be greater than the current version.

Find the latest package-qualified release tag:

```bash
git tag --list "$SLUG-v*" --sort=-version:refname | head -1
```

For `pi-tidy-tools` only, if no package-qualified tag exists, use the latest historical `vX.Y.Z` tag as `PREVIOUS_TAG`. Other packages with no tag are first releases.

Set `TAG="$SLUG-v$TARGET"`, then guard it:

```bash
git rev-parse -q --verify "refs/tags/$TAG"
npm view "$PACKAGE@$TARGET" version --json
```

Both must report absence. npm `E404` is expected absence; any other registry error stops the release.

### 3. Analyze package changes

Use the selected package seam:

```bash
git diff "$PREVIOUS_TAG"..HEAD --stat -- "$DIR"
git diff "$PREVIOUS_TAG"..HEAD -- "$DIR"
git log "$PREVIOUS_TAG"..HEAD --oneline --no-merges -- "$DIR"
```

For a first release, inspect the package tree and relevant repository history instead of diffing a missing tag. Account for every user-visible change in `$DIR`; shared root changes belong in this changelog only when they alter this package's observable behavior.

Complete this step when every observable change is represented once and implementation-only changes are excluded. Stop on an empty release.

### 4. Prepare metadata

Create `$DIR/CHANGELOG.md` with the contract if absent. Otherwise preserve released sections and move current Unreleased entries into `## [TARGET] - YYYY-MM-DD`, using the current UTC date. Add missing entries found during diff review without duplication.

Update links:

- `[Unreleased]` compares `$TAG...HEAD`.
- `[TARGET]` compares `$PREVIOUS_TAG...$TAG`.
- A first release links `[TARGET]` to the repository tree at `$TAG`.

Update only the selected version:

```bash
npm version "$TARGET" --workspace "$PACKAGE" --no-git-tag-version
```

Confirm `$DIR/package.json` and the workspace entry in `package-lock.json` both report `TARGET`.

Extract the new changelog section, excluding `[Unreleased]` and reference links, to `/tmp/$SLUG-release-v$TARGET.md`. Review it for accuracy and implementation leakage.

### 5. Validate

```bash
npm ci
npm test
npm run check
npm pack --workspace "$PACKAGE" --dry-run
npm pack --workspace "$PACKAGE" --dry-run --json
git diff --check
git status --short
```

Inspect the selected tarball allowlist, package identity, Pi manifest resources, and repository metadata. Confirm one non-empty target changelog section, correct compare links, exact release notes, and no changed package metadata outside the selected workspace except `package-lock.json`.

### 6. Commit and tag

Stage only selected release metadata:

```bash
git add "$DIR/package.json" "$DIR/CHANGELOG.md" package-lock.json
git commit -m "chore($SLUG): release v$TARGET"
git tag -a "$TAG" -m "$PACKAGE v$TARGET"
git push origin main --follow-tags
```

Verify the annotated tag points to the release commit.

### 7. Create and monitor the GitHub Release

```bash
gh release create "$TAG" \
  --verify-tag \
  --notes-file "/tmp/$SLUG-release-v$TARGET.md" \
  --title "$PACKAGE v$TARGET"
rm "/tmp/$SLUG-release-v$TARGET.md"
```

Locate the release-triggered workflow run whose `headBranch` is `$TAG`, then block until completion:

```bash
gh run list --workflow publish.yml --event release --limit 10 \
  --json databaseId,headBranch,status,conclusion,url
gh run watch <RUN_ID> --exit-status
```

On failure, inspect `gh run view <RUN_ID> --log-failed`. Diagnose before proposing any retry or corrective version.

### 8. Verify publication

Allow for registry propagation, then require all checks to agree:

```bash
npm view "$PACKAGE" version dist.integrity --json
gh run view <RUN_ID> --json conclusion,url,headSha
gh release view "$TAG" --json url,tagName
git status --short
```

Success means npm reports exactly `TARGET` with non-empty integrity, the workflow succeeded for `$TAG`, the GitHub Release exists, and the working tree is clean.

## Final report

Report the package/version, changelog sections, release commit/tag, GitHub Release URL, workflow URL/conclusion, validation, npm integrity, and residual risks.
