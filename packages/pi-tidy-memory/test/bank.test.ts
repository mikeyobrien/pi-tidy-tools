import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { HindsightBankResolver } from "../bank.js";
import type { HindsightBackendConfig } from "../config.js";

function config(
  overrides: Partial<HindsightBackendConfig> = {}
): HindsightBackendConfig {
  return {
    type: "hindsight",
    baseUrl: "https://memory.example.test",
    bankId: "pi-coding",
    ...overrides,
  };
}

const noGit = () => undefined;

function runGit(args: string[]): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  execFileSync("git", args, { env });
}

test("static banks remain unchanged and accept an optional prefix", () => {
  assert.deepEqual(
    new HindsightBankResolver(config(), {
      cwd: "/work/project",
      git: noGit,
    }).resolve(),
    { bankId: "pi-coding", source: "static" }
  );
  assert.deepEqual(
    new HindsightBankResolver(config({ bankIdPrefix: "prod" }), {
      cwd: "/work/project",
      git: noGit,
    }).resolve(),
    { bankId: "prod::pi-coding", source: "static" }
  );
});

test("dynamic banks compose documented context fields in configured order", () => {
  const resolver = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: [
        "agent",
        "project",
        "session",
        "channel",
        "user",
      ],
      bankIdPrefix: "prod",
      agentName: "pi",
      resolveWorktrees: false,
    }),
    {
      cwd: "/work/pi-tidy-tools",
      env: {
        HINDSIGHT_CHANNEL_ID: "terminal",
        HINDSIGHT_USER_ID: "rook",
      },
      git: (args) =>
        args.includes("--show-toplevel") ? "/work/pi-tidy-tools" : undefined,
    }
  );
  assert.deepEqual(resolver.resolve({ sessionId: "session-1" }), {
    bankId: "prod::pi::pi-tidy-tools::session-1::terminal::rook",
    source: "dynamic",
  });
  assert.equal(
    resolver.resolve({ sessionId: "session-2" }).bankId,
    "prod::pi::pi-tidy-tools::session-2::terminal::rook"
  );
});

test("dynamic defaults use agent and project while environment overrides the agent", () => {
  const defaulted = new HindsightBankResolver(config({ dynamicBankId: true }), {
    cwd: "/work/tidy",
    env: {},
    git: noGit,
  });
  assert.deepEqual(defaulted.resolve(), {
    bankId: "pi::tidy",
    source: "dynamic",
  });

  const overridden = new HindsightBankResolver(
    config({ dynamicBankId: true }),
    {
      cwd: "/work/tidy",
      env: { HINDSIGHT_AGENT_NAME: "reviewer" },
      git: noGit,
    }
  );
  assert.deepEqual(overridden.resolve(), {
    bankId: "reviewer::tidy",
    source: "dynamic",
  });
});

test("worktrees resolve to the main repository basename by default", () => {
  const calls: string[][] = [];
  const resolver = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: ["project"],
    }),
    {
      cwd: "/worktrees/tidy-feature",
      git: (args) => {
        calls.push([...args]);
        return args.includes("--git-common-dir")
          ? "/repos/pi-tidy-tools/.git"
          : undefined;
      },
    }
  );
  assert.deepEqual(resolver.resolve(), {
    bankId: "pi-tidy-tools",
    source: "dynamic",
  });
  assert.equal(calls.length, 1);
});

test("disabling worktree resolution uses only the active checkout root", () => {
  const calls: string[][] = [];
  const resolver = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: ["project"],
      resolveWorktrees: false,
    }),
    {
      cwd: "/worktrees/tidy-feature/src",
      git: (args) => {
        calls.push([...args]);
        if (args.includes("--git-common-dir"))
          return "/repos/wrong-project/.git";
        return args.includes("--show-toplevel")
          ? "/worktrees/tidy-feature"
          : undefined;
      },
    }
  );
  assert.equal(resolver.resolve().bankId, "tidy-feature");
  assert.deepEqual(calls, [
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
  ]);
});

test("directory mappings override static and dynamic resolution exactly", () => {
  const resolver = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      bankIdPrefix: "pi",
      directoryBankMap: {
        "/work/other": "other",
        "/work/sensitive": "isolated",
      },
    }),
    { cwd: "/work/sensitive", git: noGit }
  );
  assert.deepEqual(resolver.resolve(), {
    bankId: "pi::isolated",
    source: "directory-map",
  });
});

test("missing or unsafe dynamic identities fail closed", () => {
  for (const [field, expected] of [
    ["channel", "configure HINDSIGHT_CHANNEL_ID"],
    ["user", "configure HINDSIGHT_USER_ID"],
    ["session", "configure the active Pi session or HINDSIGHT_SESSION_ID"],
  ] as const) {
    const missing = new HindsightBankResolver(
      config({
        dynamicBankId: true,
        dynamicBankGranularity: [field],
      }),
      { cwd: "/work/tidy", env: {}, git: noGit }
    );
    assert.throws(() => missing.resolve(), new RegExp(expected));
  }

  const sessionFromEnv = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: ["session"],
    }),
    {
      cwd: "/work/tidy",
      env: { HINDSIGHT_SESSION_ID: "env-session" },
      git: noGit,
    }
  );
  assert.equal(sessionFromEnv.resolve().bankId, "env-session");

  for (const unsafeUser of ["bad user", "forged::segment"]) {
    const unsafe = new HindsightBankResolver(
      config({
        dynamicBankId: true,
        dynamicBankGranularity: ["user"],
      }),
      {
        cwd: "/work/tidy",
        env: { HINDSIGHT_USER_ID: unsafeUser },
        git: noGit,
      }
    );
    assert.throws(
      () => unsafe.resolve(),
      /dynamic bank field user must be 1-128 letters, numbers, dots, underscores, or hyphens/
    );
  }
});

test("project fallback and unusual common directories remain deterministic", () => {
  const unusualCommon = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: ["project"],
    }),
    {
      cwd: "/work/feature",
      git: (args) => {
        if (args.includes("--git-common-dir")) return "/repos/project.gitdata";
        return undefined;
      },
    }
  );
  assert.equal(unusualCommon.resolve().bankId, "project.gitdata");

  const emptyCommonLabel = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: ["project"],
    }),
    {
      cwd: "/work/project",
      git: (args) => {
        if (args.includes("--git-common-dir")) return "/";
        if (args.includes("--show-toplevel")) return "/work/project";
        return undefined;
      },
    }
  );
  assert.equal(emptyCommonLabel.resolve().bankId, "project");

  const filesystemRoot = new HindsightBankResolver(
    config({
      dynamicBankId: true,
      dynamicBankGranularity: ["project"],
    }),
    { cwd: "/", git: noGit }
  );
  assert.equal(filesystemRoot.resolve().bankId, "root");
});

test("default Git probing resolves real linked worktrees and non-repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-memory-bank-"));
  try {
    const repository = join(root, "main-project");
    const worktree = join(root, "feature-worktree");
    const outside = join(root, "outside");
    await mkdir(repository);
    await mkdir(outside);
    runGit(["init", "-q", repository]);
    runGit(["-C", repository, "config", "user.name", "Test"]);
    runGit(["-C", repository, "config", "user.email", "test@example.test"]);
    await writeFile(join(repository, "README.md"), "test\n");
    runGit(["-C", repository, "add", "README.md"]);
    runGit(["-C", repository, "commit", "-qm", "initial"]);
    runGit([
      "-C",
      repository,
      "worktree",
      "add",
      "-q",
      "-b",
      "feature",
      worktree,
    ]);

    const linked = new HindsightBankResolver(
      config({
        dynamicBankId: true,
        dynamicBankGranularity: ["project"],
      }),
      { cwd: worktree }
    );
    assert.equal(linked.resolve().bankId, basename(repository));

    const notGit = new HindsightBankResolver(
      config({
        dynamicBankId: true,
        dynamicBankGranularity: ["project"],
      }),
      { cwd: outside }
    );
    assert.equal(notGit.resolve().bankId, "outside");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe IDs identify the configuration source that produced them", () => {
  assert.throws(
    () =>
      new HindsightBankResolver(config({ bankId: "bad bank" }), {
        cwd: "/work/project",
        git: noGit,
      }).resolve(),
    /backend\.bankId resolved to an unsafe bank ID/
  );
  assert.throws(
    () =>
      new HindsightBankResolver(
        config({ directoryBankMap: { "/work/project": "bad bank" } }),
        { cwd: "/work/project", git: noGit }
      ).resolve(),
    /backend\.directoryBankMap resolved to an unsafe bank ID/
  );
});
