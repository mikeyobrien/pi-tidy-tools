/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: "npm",
  testRunner: "command",
  commandRunner: {
    command: "npm test",
  },
  // Monorepo pretest reaches ../../scripts; mutate in place so that path resolves.
  inPlace: true,
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  mutate: ["index.ts", "config.ts", "render.ts"],
  ignorePatterns: [
    "coverage",
    "reports",
    ".stryker-tmp",
    ".test-dist",
    "vendor",
    "docs",
    "scripts",
  ],
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: {
    fileName: "reports/mutation/mutation.html",
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 120_000,
  concurrency: 2,
  ignoreStatic: true,
};
