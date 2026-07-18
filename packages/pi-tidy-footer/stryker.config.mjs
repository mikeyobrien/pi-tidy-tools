/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    // The tracked vendor snapshot already exists; avoid the workspace pretest
    // because Stryker sandboxes contain only this package.
    command: "node --import tsx --test test/*.test.ts",
  },
  coverageAnalysis: "off",
  incremental: false,
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["*.ts", "!test/**/*.ts", "!vendor/**/*.ts"],
  ignorePatterns: ["coverage", "reports", ".stryker-tmp", "docs"],
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  thresholds: { high: 90, low: 80, break: 80 },
  timeoutMS: 60_000,
  concurrency: 8,
};
