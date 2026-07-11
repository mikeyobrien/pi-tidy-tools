# pi-tidy

A monorepo for focused, independently installable packages that make [pi](https://github.com/earendil-works/pi-mono) easier to follow.

## Packages

| Package | Purpose |
|---|---|
| [`@mobrienv/pi-tidy-tools`](packages/pi-tidy-tools) | Compact, reason-first rendering for Pi's built-in tools |

Future packages follow the `@mobrienv/pi-tidy-*` naming convention, including `pi-tidy-advisor` and focused `pi-tidy-<tool-name>` packages. Each package owns its runtime, documentation, tests, version, changelog, and npm release.

There is no published umbrella runtime package. Install only the Pi packages you want. The private root manifest keeps existing local-checkout installs pointed at `pi-tidy-tools`; published packages remain independent.

## Develop

Install once at the repository root and validate every workspace:

```bash
npm install
npm test
npm run check
```

Target one package during development:

```bash
npm test --workspace @mobrienv/pi-tidy-tools
npm run check --workspace @mobrienv/pi-tidy-tools
npm pack --workspace @mobrienv/pi-tidy-tools --dry-run
```

Publishable packages live at `packages/pi-tidy-<name>` and use the npm name `@mobrienv/pi-tidy-<name>`. Releases use package-qualified tags such as `pi-tidy-tools-v0.1.3` so every package can version and publish independently.
