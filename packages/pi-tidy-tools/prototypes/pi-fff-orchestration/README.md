# PROTOTYPE — installed pi-fff orchestration

> Throwaway primary source for [Prove installed pi-fff orchestration across Pi npm scopes](https://github.com/mikeyobrien/pi-tidy-tools/issues/10). Do not ship this directory.

## Question

Can pi-tidy-tools load a separately installed `pi-fff@0.1.12` whose package entry has `extensions: []`, capture pi-fff's `read` and `grep` definitions for composition, forward its remaining ExtensionAPI registrations unchanged, and start Pi with exactly one `read`/`grep` pair in both documented npm scopes?

The prototype creates scratch user and project Pi roots, installs the real npm package into each documented layout, starts the real Pi runtime through RPC, and performs an approximate-path `read` through the captured pi-fff executor. Nothing is written to the real Pi settings or package roots.

## Run

```bash
npm run prototype:pi-fff
```

Press `a` to run both scopes. The frame exposes the complete relevant state after every action.

For an unattended JSON verdict:

```bash
npm run prototype:pi-fff -- --all
```

Scratch roots are removed on reset, quit, or completion of the unattended run.
