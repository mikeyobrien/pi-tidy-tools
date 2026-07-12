/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "tap",
  plugins: [
    "@stryker-mutator/tap-runner",
    "@stryker-mutator/typescript-checker",
  ],
  tap: {
    testFiles: ["test/*.test.ts"],
    nodeArgs: [
      "--import",
      "tsx",
      "--test-reporter=tap",
      "-r",
      "{{hookFile}}",
      "{{testFile}}",
    ],
  },
  coverageAnalysis: "perTest",
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
  timeoutMS: 15_000,
  concurrency: 8,
};
