/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["index.ts"],
  ignorePatterns: ["coverage", "reports", ".stryker-tmp"],
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  // One focused unit file today; raise `break` as mutation score improves.
  thresholds: {
    high: 80,
    low: 40,
    break: 30,
  },
  timeoutMS: 60_000,
  concurrency: 4,
  ignoreStatic: true,
};
