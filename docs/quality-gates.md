# Quality gates

This repository assumes that much of its code and test suite may be produced or
modified by coding agents. The gates therefore optimize for **semantic evidence**,
not test volume: importing a module and exercising happy paths must not be enough
to call a change safe.

## Enforced thresholds

The same floors apply independently to every runtime source file in every
package:

| Signal         |      Hard floor |
| -------------- | --------------: |
| Statements     |             90% |
| Lines          |             90% |
| Functions      |             90% |
| Branches       |             80% |
| Mutation score | 80% per package |

c8 uses `all: true` and `per-file: true`. A well-tested utility therefore cannot
subsidize an untested lifecycle or orchestration file, and a source file cannot
escape the gate merely because no test imported it.

Stryker uses `thresholds.high: 90`, `low: 80`, and `break: 80`. `high` and `low`
only color the report; `break` is the build gate. Mutation score is package-wide
because Stryker does not provide a per-file break threshold.

## Why these values

- **90% statements, lines, and functions** leaves room for defensive platform
  paths while requiring tests to execute nearly all owned behavior.
- **80% branches** requires meaningful alternate-state, error, cancellation,
  boundary, and lifecycle coverage. Line coverage alone is easy to inflate with
  assertion-light tests.
- **80% mutation score** requires assertions that notice changed operators,
  conditions, outputs, and state transitions. This is the primary defense
  against plausible-looking agent-generated tests that execute code without
  proving its contract.
- **90% is green mutation health**, not the minimum. Packages between 80% and
  90% pass but remain improvement candidates.

These are floors, not targets. New or materially changed executable behavior
should cover every practical branch and kill every non-equivalent mutant it
introduces.

## Source scope and exceptions

Coverage and mutation include all owned runtime entry points, configuration,
rendering, scheduling, persistence, lifecycle, and error-handling code.
Exclusions are limited to:

- tests and fixtures;
- generated reports and temporary directories;
- generated vendored copies whose authoritative source is tested elsewhere;
- documentation and assets;
- test-runner scripts; and
- type-only declarations with no runtime behavior.

Difficult code is not an exclusion category. A mutant may be disabled only with
a narrow source directive that names the exact mutator and explains why the
mutant is equivalent. Broad mutator or runtime-file exclusions require an
explicit architecture decision.

## Ratchet and migration

Once a package exceeds a floor, its accepted `main` score is a ratchet: changes
must not lower it even when the result remains above the hard floor. Until an
automated baseline comparison is added, reviewers must compare the package
summary with the previous accepted report.

Existing debt does not redefine the thresholds. A package below a floor stays
red until tests establish the missing behavior. Do not lower a threshold in an
ordinary feature or fix change. A temporary exception must be named,
time-limited, scoped to one package, and require both no regression and full
coverage of changed behavior.

The first accepted ratchet baseline after adopting this policy is:

| Package             | Statements | Branches | Functions |  Lines | Mutation |
| ------------------- | ---------: | -------: | --------: | -----: | -------: |
| `pi-tidy-core`      |     97.84% |   96.57% |      100% | 97.84% |   91.57% |
| `pi-tidy-footer`    |     99.27% |   93.92% |      100% | 99.27% |   80.43% |
| `pi-tidy-memory`    |     99.38% |   94.14% |      100% | 99.38% |   85.35% |
| `pi-tidy-subagents` |     99.66% |   94.55% |      100% | 99.66% |   88.41% |
| `pi-tidy-tools`     |     98.42% |   94.52% |    97.29% | 98.42% |   81.97% |

Future changes must meet both the fixed floors and this no-regression baseline.

## Cadence

Run coverage on every pull request:

```bash
npm run test:coverage
```

Run mutation testing for affected packages before merge and run the full suite
nightly and before release:

```bash
npm run test:mutation --workspace @mobrienv/pi-tidy-tools
npm run test:mutation
```

The command test runner treats each package suite as one test, so mutation runs
execute the full package suite for each mutant. Incremental reuse is disabled:
with no per-test coverage data, reusing survivors after a test change could
produce a false result.

Mutation reports also require review for `NoCoverage`, timeout, compile-error,
and runtime-error counts. A passing aggregate score does not excuse a new
uncovered mutant or a rising error count.
