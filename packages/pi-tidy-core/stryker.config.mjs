/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  coverageAnalysis: "off",
  incremental: false,
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["index.ts"],
  ignorePatterns: ["coverage", "reports", ".stryker-tmp"],
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  timeoutMS: 60_000,
  concurrency: 4,
};
