export default {
  mutate: ["*.ts", "backends/**/*.ts", "!test/**/*.ts", "!vendor/**/*.ts"],
  testRunner: "tap",
  tap: { testFiles: ["test/*.test.ts"] },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  reporters: ["clear-text", "progress", "html"],
  thresholds: { high: 90, low: 80, break: 80 },
  coverageAnalysis: "perTest",
};
