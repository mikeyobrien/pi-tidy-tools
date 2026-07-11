/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  // Monorepo pretest reaches ../../scripts; mutate in place so that path resolves.
  inPlace: true,
  coverageAnalysis: "off",
  incremental: false,
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: [
    "index.ts",
    "envelope.ts",
    "render.ts",
    "runner.ts",
    "scheduler.ts",
    "store.ts",
  ],
  ignorePatterns: ["coverage", "reports", ".stryker-tmp", "vendor", "docs"],
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  timeoutMS: 120_000,
  concurrency: 2,
};
