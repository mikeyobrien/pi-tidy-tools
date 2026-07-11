---
name: npm-release
description: Creates and verifies a new @mobrienv/pi-tidy-tools release, maintains CHANGELOG.md, and publishes through GitHub Releases and npm Trusted Publishing. Use when asked to prepare changelog entries, cut, publish, or monitor a patch, minor, major, or explicit-version release for this repository.
compatibility: Requires Node.js 22.19+, npm, git, GitHub CLI authentication, and push access to mikeyobrien/pi-tidy-tools.
---

# npm Release

Release `@mobrienv/pi-tidy-tools` through `.github/workflows/publish.yml`. Maintain `CHANGELOG.md` using Keep a Changelog 1.1.0 and SemVer. GitHub Releases trigger tokenless npm Trusted Publishing with provenance.

## Safety rules

- Run only from the repository root.
- Never request, store, print, or configure an npm token. Publishing uses GitHub OIDC.
- Do not publish directly with `npm publish`.
- Do not overwrite or reuse a version, tag, or changelog heading.
- Stop if the working tree is dirty, the current branch is not `main`, validation fails, `main` cannot push, or the target npm version already exists.
- Do not use `--force`, rewrite tags, amend unrelated commits, or bypass tests.
- Ask when the release level/version is ambiguous. Default to `patch` only when the user explicitly requests the next release without specifying a level.
- Changelog content is user-facing: describe observable behavior, not implementation mechanics.

## Inputs

Accept one of:

- `patch`, `minor`, or `major`
- An explicit semver such as `0.2.0`

Normalize `v0.2.0` to `0.2.0` before use.

## Changelog contract

`CHANGELOG.md` follows this shape:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [X.Y.Z] - YYYY-MM-DD

### Added
- User-visible addition.

### Changed
- User-visible behavior change.

### Fixed
- User-visible correction.

[Unreleased]: https://github.com/mikeyobrien/pi-tidy-tools/compare/vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/mikeyobrien/pi-tidy-tools/compare/vPREVIOUS...vX.Y.Z
```

Use standard sections in this order and omit empty sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

Entry rules:

- Write one concise user-facing change per bullet.
- Do not copy Conventional Commit prefixes into entries.
- Do not mention internal helper names, tests, refactors, file paths, dependency mechanics, or CI unless users must act on them.
- Include commands, config keys, and public API names only when users need them.
- Deprecations must name the replacement or migration path.
- Put breaking changes first and label them **BREAKING**.
- Sort by user impact, not commit chronology.
- Omit internal-only changes and changes added then reverted before release.
- Do not rely only on commit subjects. Inspect the code diff as the primary source and use commits for intent.

## Procedure

### 1. Preflight

```bash
git status --short
git branch --show-current
git fetch origin main --tags
git rev-list --left-right --count origin/main...main
gh auth status
npm view @mobrienv/pi-tidy-tools version --json
```

Require an empty working tree, branch `main`, no ahead/behind count, and valid GitHub authentication. Local npm authentication is not required because publishing uses OIDC.

Confirm `.github/workflows/publish.yml` has `id-token: write`, uses environment `npm`, and contains no `NODE_AUTH_TOKEN` or `NPM_TOKEN` reference.

### 2. Determine and guard the target

Read the version from `package.json`. Calculate the requested SemVer bump without modifying files. For an explicit version, use it exactly and require it to be greater than the current version.

Identify the previous release tag:

```bash
git tag --sort=-version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
```

Guard the target:

```bash
git rev-parse -q --verify "refs/tags/v<TARGET>"
npm view "@mobrienv/pi-tidy-tools@<TARGET>" version --json
```

Both must report absence. npm `E404` means expected absence; any other npm error is a failure.

### 3. Analyze release changes

Use both signals:

```bash
git diff "v<PREVIOUS>"..HEAD --stat
git diff "v<PREVIOUS>"..HEAD -- index.ts config.ts render.ts README.md package.json
git log "v<PREVIOUS>"..HEAD --oneline --no-merges
```

Read relevant full diffs. Classify observable changes into Keep a Changelog sections. Code behavior is primary; commit subjects only explain intent.

If no user-visible changes exist, stop rather than publishing an empty release.

### 4. Prepare release metadata

Create `CHANGELOG.md` with the contract above if absent. Otherwise preserve existing prose and released sections.

- Keep an empty `## [Unreleased]` heading at the top.
- Move existing Unreleased entries into `## [TARGET] - YYYY-MM-DD`.
- Add missing user-visible entries found during diff review without duplicating existing entries.
- Use the current UTC date.
- Update compare links:
  - `[Unreleased]` compares `vTARGET...HEAD`.
  - `[TARGET]` compares `vPREVIOUS...vTARGET`.
  - For the first tag, link the version to the repository tree at `vTARGET`.

Update package versions without creating a commit or tag yet:

```bash
npm version <TARGET> --no-git-tag-version
```

This must update both `package.json` and `package-lock.json`.

Extract only the new version section, excluding `[Unreleased]` and bottom reference links, into `/tmp/pi-tidy-tools-release-vTARGET.md`. Use this as GitHub Release notes. Do not commit the temporary file.

Review the resulting changelog section for implementation leakage and accuracy before continuing.

### 5. Validate the candidate

```bash
npm ci
npm test
npm run check
npm pack --dry-run
git diff --check
```

Inspect pack output. It should contain only allowlisted runtime files and documentation images. Confirm:

- `package.json` and `package-lock.json` both report `TARGET`.
- `CHANGELOG.md` has one non-empty `## [TARGET] - YYYY-MM-DD` section.
- `[Unreleased]` and version compare links are correct.
- Release notes exactly represent the target changelog section.

### 6. Commit, tag, and push

Stage only intended release metadata:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release vTARGET"
git tag -a "vTARGET" -m "vTARGET"
git push origin main --follow-tags
```

Verify the annotated tag points to the release commit. Do not include unrelated files.

### 7. Create the GitHub Release

```bash
gh release create "vTARGET" \
  --verify-tag \
  --notes-file "/tmp/pi-tidy-tools-release-vTARGET.md" \
  --title "vTARGET"
```

Delete the temporary notes file after GitHub accepts the release. The release event triggers `.github/workflows/publish.yml`.

### 8. Track publishing to completion

Locate the release run whose `headBranch` is `vTARGET`:

```bash
gh run list \
  --workflow publish.yml \
  --event release \
  --limit 5 \
  --json databaseId,headBranch,status,conclusion,url
```

Then block:

```bash
gh run watch <RUN_ID> --exit-status
```

On failure:

```bash
gh run view <RUN_ID> --log-failed
```

Do not retry blindly or create another version. Diagnose first and ask before taking corrective release action.

### 9. Verify npm and repository state

Allow for brief registry propagation, then run:

```bash
npm view @mobrienv/pi-tidy-tools version dist.integrity --json
gh run view <RUN_ID> --json conclusion,url,headSha
gh release view "vTARGET" --json url,tagName
git status --short
```

Success requires workflow conclusion `success`, npm version exactly `TARGET`, a non-empty integrity value, the expected GitHub Release, and a clean working tree.

## Final report

Report concisely:

- Published package and version
- Changelog sections included
- Release commit and tag
- GitHub Release URL
- Workflow URL and conclusion
- Validation performed
- npm integrity value
- Warnings or follow-up work

Tell the user the work is on `main` and can be viewed with:

```bash
git checkout main
```
