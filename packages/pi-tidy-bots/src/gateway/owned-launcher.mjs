import { spawn, execFile } from "node:child_process";
import { Socket } from "node:net";
import { constants } from "node:os";

// This trusted process remains the process-group leader. The plugin cannot run
// until its group identity has been durably recorded by the parent. Python's
// pass_fds can supply its existing pipe without a thread-unsafe preexec dup2.
const [token, ...command] = process.argv.slice(2);
let controlFd = 3;
if (command[0]?.startsWith("--control-fd=")) {
  const value = command.shift().slice("--control-fd=".length);
  if (!/^[0-9]+$/.test(value)) process.exit(64);
  controlFd = Number(value);
  if (!Number.isSafeInteger(controlFd) || controlFd < 3 || controlFd > 65535)
    process.exit(64);
}
const [executable, ...args] = command;
if (!/^tidy-launch-[a-f0-9-]{36}$/.test(token ?? "") || !executable)
  process.exit(64);
let child;
let activated = false;
let stopping = false;
let received = "";
let outcome = { code: 0, signal: null };
const decoder = new TextDecoder("utf-8", { fatal: true });
// A filesystem stream can strand a blocking worker-pool read while the plugin
// exits and the parent still holds its pipe. Use a nonblocking pipe handle.
const control = new Socket({ fd: controlFd, readable: true, writable: false });
const startup = setTimeout(() => stop(), 10_000);
let deadline;

function finish() {
  if (outcome.signal) {
    // Node reserves SIGUSR1 for starting the inspector. Report the conventional
    // signal exit status instead of opening a debugger in a native supervisor.
    const signalCode = 128 + (constants.signals[outcome.signal] ?? 0);
    if (outcome.signal === "SIGUSR1") process.exit(signalCode);
    // Re-raise only our own exit signal, after the owned group is empty. This
    // preserves Popen's negative signal returncode without touching saved PIDs.
    if (outcome.signal !== "SIGKILL") process.on(outcome.signal, () => {});
    process.removeAllListeners(outcome.signal);
    process.kill(process.pid, outcome.signal);
    // A platform-reserved/ignored signal must never strand the launcher.
    setTimeout(() => process.exit(signalCode), 100);
  } else process.exit(outcome.code);
}

function groupHasChildren(done) {
  const inspection = execFile(
    "/bin/ps",
    ["-axo", "pid=,pgid=,stat="],
    { timeout: 1_000 },
    (error, stdout) => {
      if (error) return done(true);
      done(
        stdout.split("\n").some((line) => {
          const [pid, group, state] = line.trim().split(/\s+/);
          return (
            Number(group) === process.pid &&
            Number(pid) !== process.pid &&
            Number(pid) !== inspection.pid &&
            !state?.startsWith("Z")
          );
        })
      );
    }
  );
}
function stop(graceMs = 10_000) {
  if (stopping) return;
  stopping = true;
  clearTimeout(startup);
  if (!activated) return finish();
  // Adapters first receive parent EOF on stdin and may persist/cancel. SIGTERM
  // also reaches native descendants; no detached runtime is permitted here.
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {}
  deadline = setTimeout(
    () => {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {}
      process.exit(1);
    },
    Number.isSafeInteger(graceMs)
      ? Math.max(1, Math.min(10_000, graceMs))
      : 10_000
  );
  const poll = () =>
    groupHasChildren((alive) => {
      if (!alive) {
        clearTimeout(deadline);
        finish();
      }
      setTimeout(poll, 25);
    });
  poll();
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (!stopping) outcome = { code: null, signal };
    stop();
  });
control.on("error", stop);
control.on("end", stop);
control.on("data", (chunk) => {
  if (stopping) return;
  try {
    received += decoder.decode(chunk, { stream: true });
  } catch {
    return stop();
  }
  if (activated) {
    if (received.length > 64) return stop(1_000);
    if (!received.endsWith("\n")) return;
    const command = received.match(/^shutdown:(\d+)\n$/);
    return stop(command ? Number(command[1]) : 1_000);
  }
  if (Buffer.byteLength(received) > 1024 * 1024) return stop();
  if (!received.endsWith("\n")) return;
  let activation;
  try {
    activation = JSON.parse(received);
  } catch {
    return stop();
  }
  if (
    activation.activate !== token ||
    !activation.env ||
    typeof activation.env !== "object" ||
    Array.isArray(activation.env) ||
    Object.entries(activation.env).some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof value !== "string" ||
        value.includes("\0")
    )
  )
    return stop();
  activated = true;
  received = "";
  clearTimeout(startup);
  child = spawn(executable, args, {
    env: activation.env,
    cwd: process.cwd(),
    shell: false,
    detached: false,
    stdio: [0, 1, 2],
  });
  child.on("error", (error) => {
    if (!stopping)
      outcome = { code: error.code === "ENOENT" ? 127 : 126, signal: null };
    stop();
  });
  child.on("exit", (code, signal) => {
    if (!stopping) outcome = { code: code ?? 1, signal };
    stop();
  });
});
