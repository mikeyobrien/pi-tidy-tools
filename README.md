# pi-tidy

Focused, independently installable packages that make [Pi](https://github.com/earendil-works/pi-mono) easier to follow.

Each package solves one transcript or workflow problem. Install only the ones you want—there is no umbrella runtime package.

## Packages

### [`@mobrienv/pi-tidy-tools`](packages/pi-tidy-tools)

[![npm version](https://img.shields.io/npm/v/%40mobrienv%2Fpi-tidy-tools)](https://www.npmjs.com/package/@mobrienv/pi-tidy-tools)

**See what your Pi agent is doing at a glance.** Replaces Pi's built-in tool cards with compact, reason-first output while preserving native execution behavior.

[![Native Pi tool cards compared with compact pi-tidy-tools output](packages/pi-tidy-tools/docs/comparison.png)](packages/pi-tidy-tools)

- Restyles `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`
- Shows the goal, concrete target, and useful result in one or two lines
- Keeps live status, errors, expansion, terminal-width truncation, and native tool behavior
- Adds configurable layouts and a `/diff` recap of the previous turn's changes

```bash
pi install npm:@mobrienv/pi-tidy-tools
```

[Read the full pi-tidy-tools documentation →](packages/pi-tidy-tools)

<details>
<summary>More pi-tidy-tools examples</summary>

#### In action

![pi-tidy-tools transcript showing successful and failed tool calls](packages/pi-tidy-tools/docs/demo.png)

#### Last-turn diff

![pi-tidy-tools diff recap of the last turn's edits and writes](packages/pi-tidy-tools/docs/diff.png)

#### Layout modes

![Default, reasoning, and result layouts in pi-tidy-tools](packages/pi-tidy-tools/docs/modes.png)

</details>

---

### [`@mobrienv/pi-tidy-subagents`](packages/pi-tidy-subagents)

[![npm version](https://img.shields.io/npm/v/%40mobrienv%2Fpi-tidy-subagents)](https://www.npmjs.com/package/@mobrienv/pi-tidy-subagents)

**Fan work out to child Pi agents without losing the thread.** Adds synchronous, resource-aware subagent delegation with compact live state and ordered results.

<a href="packages/pi-tidy-subagents">
  <img src="packages/pi-tidy-subagents/docs/visual.png" width="720" alt="Queued, running, successful, warning, failed, cancelled, parallel-tool, and expanded pi-tidy-subagents states">
</a>

- Runs independent child prompts concurrently through a session-wide queue
- Shows one scan-friendly activity per child, with full recent detail on expansion
- Preserves healthy sibling results when an individual child fails
- Records complete responses, usage, and normalized events in versioned run artifacts

```bash
pi install npm:@mobrienv/pi-tidy-subagents
```

[Read the full pi-tidy-subagents documentation →](packages/pi-tidy-subagents)

## About the collection

Published packages follow the `@mobrienv/pi-tidy-*` naming convention. Each package owns its runtime, documentation, tests, version, changelog, and npm release.

The private root manifest exists for workspace development and keeps existing local-checkout installs pointed at `pi-tidy-tools`; published packages remain independent.

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

npm test --workspace @mobrienv/pi-tidy-subagents
npm run check --workspace @mobrienv/pi-tidy-subagents
npm pack --workspace @mobrienv/pi-tidy-subagents --dry-run
```

Publishable packages live at `packages/pi-tidy-<name>` and use the npm name `@mobrienv/pi-tidy-<name>`. Releases use package-qualified tags such as `pi-tidy-tools-v0.2.0` so every package can version and publish independently.
