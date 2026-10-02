import assert from "node:assert/strict";
import test from "node:test";
import {
  createSystemProbe,
  DEFAULT_SAMPLE_MS,
  parseDf,
  parseVmStat,
  ResourceMonitor,
  runCommand,
  sampleResources,
  statfsUsage,
  type ResourceProbe,
} from "../resources.js";

const GNU_DF_BLOCKS = `Filesystem     1024-blocks       Used  Available Capacity Mounted on
/dev/nvme0n1p1  4194226156 1964538132 2229688024      47% /
`;
const GNU_DF_INODES = `Filesystem      Inodes   IUsed IFree IUse% Mounted on
tmpfs          1048576 1048576     0  100% /tmp
`;
const BSD_DF_INODES = `Filesystem     512-blocks      Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1  965595304  20638584 393570344     5%  403755 1967851720    0%   /
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          150000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         90000.
Pages purgeable:                           1000.
`;

test("statfs readings match df block and inode percentages", () => {
  // 100 blocks, 10 free to root, 5 available to users: df reports 90/95.
  const usage = statfsUsage({
    blocks: 100n,
    bfree: 10n,
    bavail: 5n,
    files: 200,
    ffree: 50,
  });
  assert.equal(usage.blockPercent, (90 / 95) * 100);
  assert.equal(usage.inodePercent, 75);
  assert.deepEqual(
    statfsUsage({ blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 }),
    {}
  );
});

test("statfs inode-full mount reports 100% inodes while space is free", () => {
  const usage = statfsUsage({
    blocks: 1000,
    bfree: 840,
    bavail: 840,
    files: 4096,
    ffree: 0,
  });
  assert.equal(usage.blockPercent, 16);
  assert.equal(usage.inodePercent, 100);
});

test("df parser reads GNU and BSD block and inode columns", () => {
  assert.deepEqual(parseDf(GNU_DF_BLOCKS), { blockPercent: 47 });
  assert.deepEqual(parseDf(GNU_DF_INODES), { inodePercent: 100 });
  assert.deepEqual(parseDf(BSD_DF_INODES), {
    blockPercent: 5,
    inodePercent: 0,
  });
  assert.deepEqual(
    parseDf(
      "Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 0 0 0 - /data\n"
    ),
    {}
  );
  assert.deepEqual(
    parseDf(
      "Filesystem Size Used Avail Use% Mounted on\nmap auto_home 0 0 0 91% /home\n"
    ),
    { blockPercent: 91 }
  );
  assert.deepEqual(parseDf(""), {});
  assert.deepEqual(parseDf("Filesystem Capacity Mounted on\n"), {});
});

test("vm_stat parser counts reclaimable pages as available", () => {
  assert.equal(parseVmStat(VM_STAT), (10000 + 150000 + 5000 + 1000) * 16384);
  assert.equal(
    parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\n"),
    0
  );
  assert.equal(parseVmStat("Pages free: 10.\n"), undefined);
});

test("system probe uses statfs and falls back to df on failure", async () => {
  const calls: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args].join(" "));
    return args[0] === "-i" ? GNU_DF_INODES : GNU_DF_BLOCKS;
  };
  const probe = createSystemProbe({
    platform: "linux",
    run,
    statfs: async (path) => {
      if (path === "/broken")
        throw Object.assign(new Error("nosys"), { code: "ENOSYS" });
      if (path === "/missing")
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { blocks: 10, bfree: 5, bavail: 5, files: 10, ffree: 9 };
    },
    freemem: () => 123,
  });
  assert.deepEqual(await probe.disk("/"), {
    blockPercent: 50,
    inodePercent: 10,
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(await probe.disk("/broken"), {
    blockPercent: 47,
    inodePercent: 100,
  });
  assert.deepEqual(calls, ["df -P -k /broken", "df -i /broken"]);
  await assert.rejects(probe.disk("/missing"), /missing/);
  assert.equal(await probe.availableMemory(), 123);
  assert.equal(calls.length, 2, "Linux memory never shells out");
  assert.ok(probe.cpuCount() >= 1);
  assert.equal(probe.loadavg().length, 3);
  assert.ok(probe.totalMemory() > 0);
});

test("system probe without statfs uses df and reports unreadable mounts", async () => {
  const probe = createSystemProbe({
    platform: "linux",
    statfs: undefined,
    run: async (_file, args) => {
      if (args.at(-1) === "/gone") throw new Error("df: /gone: No such file");
      return args[0] === "-i" ? "garbage" : GNU_DF_BLOCKS;
    },
  });
  assert.deepEqual(await probe.disk("/"), { blockPercent: 47 });
  await assert.rejects(probe.disk("/gone"), /df could not read \/gone/);
});

test("macOS memory comes from vm_stat with a freemem fallback", async () => {
  let output = VM_STAT;
  const probe = createSystemProbe({
    platform: "darwin",
    statfs: undefined,
    run: async (file) => {
      assert.equal(file, "vm_stat");
      if (output === "throw") throw new Error("no vm_stat");
      return output;
    },
    freemem: () => 42,
  });
  assert.equal(await probe.availableMemory(), 166000 * 16384);
  output = "unparseable";
  assert.equal(await probe.availableMemory(), 42);
  output = "throw";
  assert.equal(await probe.availableMemory(), 42);
});

test("default system probe reads this host", async () => {
  const probe = createSystemProbe();
  const disk = await probe.disk("/");
  assert.equal(typeof disk.blockPercent, "number");
  assert.ok((await probe.availableMemory()) > 0);
});

test("runCommand resolves stdout and rejects failures", async () => {
  assert.equal(
    await runCommand("node", ["-e", "process.stdout.write('ok')"]),
    "ok"
  );
  await assert.rejects(runCommand("node", ["-e", "process.exit(3)"]));
});

function stubProbe(overrides: Partial<ResourceProbe> = {}): ResourceProbe {
  return {
    loadavg: () => [2, 1, 1],
    cpuCount: () => 4,
    totalMemory: () => 16 * 2 ** 30,
    availableMemory: async () => 4 * 2 ** 30,
    disk: async (mount) => {
      if (mount === "/gone") throw new Error("ENOENT");
      return mount === "/tmp"
        ? { blockPercent: 16, inodePercent: 100 }
        : { blockPercent: 47, inodePercent: 5 };
    },
    ...overrides,
  };
}

test("sampleResources combines readings and drops unreadable sources", async () => {
  assert.deepEqual(
    await sampleResources(stubProbe(), ["/", "/gone", "/tmp"], 85),
    {
      warnPercent: 85,
      cpu: { load1: 2, cores: 4 },
      memory: { used: 12 * 2 ** 30, total: 16 * 2 ** 30 },
      disks: [
        { mount: "/", blockPercent: 47, inodePercent: 5 },
        { mount: "/tmp", blockPercent: 16, inodePercent: 100 },
      ],
    }
  );
  assert.deepEqual(
    await sampleResources(
      stubProbe({
        cpuCount: () => 0,
        availableMemory: async () => {
          throw new Error("no memory");
        },
      }),
      [],
      70
    ),
    { warnPercent: 70, disks: [] }
  );
  assert.deepEqual(
    await sampleResources(
      stubProbe({
        loadavg: () => [],
        totalMemory: () => 0,
        availableMemory: async () => 1,
      }),
      [],
      85
    ),
    { warnPercent: 85, disks: [] }
  );
  const overfull = await sampleResources(
    stubProbe({ availableMemory: async () => 32 * 2 ** 30 }),
    [],
    85
  );
  assert.equal(overfull.memory?.used, 0);
});

test("monitor samples in the background and caches the last reading", async () => {
  let samples = 0;
  const monitor = new ResourceMonitor(
    stubProbe({
      loadavg: () => {
        samples += 1;
        return [samples, 0, 0];
      },
    }),
    1
  );
  assert.equal(monitor.running, false);
  let updates = 0;
  monitor.start(["/"], 90, () => {
    updates += 1;
  });
  assert.equal(monitor.running, true);
  await monitor.refresh();
  assert.equal(samples, 1, "refresh joins the in-flight sample");
  assert.equal(updates, 1);
  assert.deepEqual(monitor.snapshot?.disks, [
    { mount: "/", blockPercent: 47, inodePercent: 5 },
  ]);
  assert.equal(monitor.snapshot?.warnPercent, 90);

  monitor.start(["/tmp"], 80, () => {});
  assert.equal(samples, 1, "a running monitor only reconfigures");
  await monitor.refresh();
  assert.equal(samples, 2);
  assert.deepEqual(
    monitor.snapshot?.disks.map((disk) => disk.mount),
    ["/tmp"]
  );

  monitor.stop();
  assert.equal(monitor.running, false);
  assert.equal(monitor.snapshot, undefined);
  monitor.stop();
});

test("monitor never samples faster than five seconds", async (t) => {
  assert.equal(DEFAULT_SAMPLE_MS, 5_000);
  t.mock.timers.enable({ apis: ["setInterval"] });
  let samples = 0;
  const monitor = new ResourceMonitor(
    stubProbe({
      loadavg: () => {
        samples += 1;
        return [1, 1, 1];
      },
    }),
    10
  );
  monitor.start(["/"], 85, () => {});
  await monitor.refresh();
  assert.equal(samples, 1);
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(samples, 1, "no timer sample before five seconds");
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(samples, 2);
  monitor.stop();
  t.mock.timers.tick(20_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(samples, 2, "stop clears the timer");
});

test("a sample that finishes after stop is discarded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updates = 0;
  const monitor = new ResourceMonitor(
    stubProbe({
      availableMemory: async () => {
        await gate;
        return 1;
      },
    })
  );
  monitor.start(["/"], 85, () => {
    updates += 1;
  });
  const pending = monitor.refresh();
  monitor.stop();
  release();
  await pending;
  assert.equal(monitor.snapshot, undefined);
  assert.equal(updates, 0);
});

test("a throwing probe keeps the previous snapshot", async () => {
  let fail = false;
  const monitor = new ResourceMonitor(
    stubProbe({
      cpuCount: () => {
        if (fail) throw new Error("boom");
        return 4;
      },
    })
  );
  let updates = 0;
  await monitor.refresh(() => {
    updates += 1;
  });
  const first = monitor.snapshot;
  assert.ok(first);
  fail = true;
  await monitor.refresh(() => {
    updates += 1;
  });
  assert.equal(monitor.snapshot, first);
  assert.equal(updates, 2);
});
