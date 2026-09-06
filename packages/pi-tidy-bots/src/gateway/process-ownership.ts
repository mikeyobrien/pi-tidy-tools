import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProtocolError } from "./protocol.ts";

const execute = promisify(execFile);
export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}
export interface OwnedProcessIdentity extends ProcessIdentity {
  token: string;
}
interface ProcessRow extends ProcessIdentity {
  parent: number;
  group: number;
  state: string;
  command: string;
}

async function processes(): Promise<ProcessRow[]> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new ProtocolError(
      "unsupported_runtime",
      "Owned process recovery requires macOS or Linux"
    );
  const { stdout } = await execute(
    "/bin/ps",
    ["-ww", "-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="],
    {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line
        .trim()
        .match(
          /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/
        );
      if (!match)
        throw new ProtocolError(
          "ownership_unreconciled",
          "Process inventory could not be validated"
        );
      return {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        state: match[4],
        startedAt: match[5].replace(/\s+/g, " "),
        command: match[6],
      };
    });
}

export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  const row = (await processes()).find((entry) => entry.pid === pid);
  if (!row || row.state.startsWith("Z"))
    throw new ProtocolError(
      "ownership_unreconciled",
      "Process identity is unavailable"
    );
  return { pid: row.pid, startedAt: row.startedAt };
}

/** Seconds-resolution birth time is only a conservative liveness test. It never authorizes a signal. */
export async function ownerHasExited(
  identity: ProcessIdentity
): Promise<boolean> {
  const row = (await processes()).find((entry) => entry.pid === identity.pid);
  return (
    !row || row.state.startsWith("Z") || row.startedAt !== identity.startedAt
  );
}

export async function ownedProcessIdentity(
  pid: number,
  token: string
): Promise<OwnedProcessIdentity> {
  const rows = await processes();
  const row = rows.find((entry) => entry.pid === pid);
  if (
    !row ||
    row.group !== pid ||
    row.state.startsWith("Z") ||
    !row.command.split(/\s+/).includes(token)
  )
    throw new ProtocolError(
      "ownership_unreconciled",
      "Gated supervisor identity could not be established"
    );
  return { pid, startedAt: row.startedAt, token };
}

/** A plugin may register only the trusted gated launcher below an owned group.
 * This verifies current provenance; it never authorizes signalling a saved PID.
 */
export async function ownedChildIdentity(
  pid: number,
  token: string,
  launcher: string,
  parents: readonly OwnedProcessIdentity[]
): Promise<OwnedProcessIdentity> {
  const rows = await processes();
  const child = rows.find((row) => row.pid === pid);
  const parent = child && rows.find((row) => row.pid === child.parent);
  const owner =
    parent && parents.find((identity) => identity.pid === parent.group);
  const leader = owner && rows.find((row) => row.pid === owner.pid);
  if (
    !child ||
    child.group !== pid ||
    child.state.startsWith("Z") ||
    !parent ||
    parent.state.startsWith("Z") ||
    !owner ||
    !leader ||
    leader.state.startsWith("Z") ||
    leader.group !== owner.pid ||
    leader.startedAt !== owner.startedAt ||
    !leader.command.startsWith(
      `${process.execPath} ${launcher} ${owner.token} `
    ) ||
    !child.command.startsWith(`${process.execPath} ${launcher} ${token} `)
  )
    throw new ProtocolError(
      "ownership_unreconciled",
      "Child is not a trusted launcher below this binding"
    );
  return { pid, token, startedAt: child.startedAt };
}

/** Historical numeric PIDs are never signalled: the trusted leader reaps on parent EOF. */
export async function reconcileOwnedProcess(
  identity: OwnedProcessIdentity,
  graceMs = 10_000
): Promise<void> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const rows = await processes();
    const members = rows.filter(
      (row) => row.group === identity.pid && !row.state.startsWith("Z")
    );
    if (!members.length) return;
    const leader = members.find((row) => row.pid === identity.pid);
    if (Date.now() >= deadline)
      throw new ProtocolError(
        "ownership_unreconciled",
        leader &&
          leader.startedAt === identity.startedAt &&
          leader.command.split(/\s+/).includes(identity.token)
          ? "Owned process group did not terminate"
          : "Surviving process group has no verified owned supervisor"
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function ownedGroupHasExited(pid: number): Promise<boolean> {
  return !(await processes()).some(
    (row) => row.group === pid && !row.state.startsWith("Z")
  );
}
