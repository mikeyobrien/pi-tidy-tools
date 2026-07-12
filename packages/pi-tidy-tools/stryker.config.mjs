/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    // The tracked vendor snapshot already exists; bypass npm's monorepo pretest
    // so isolated Stryker sandboxes never reach outside the package directory.
    command: "node scripts/test.mjs",
  },
  coverageAnalysis: "off",
  incremental: false,
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["index.ts", "config.ts", "render.ts"],
  ignorePatterns: ["coverage", "reports", ".stryker-tmp", "docs"],
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
  concurrency: 8,
};
