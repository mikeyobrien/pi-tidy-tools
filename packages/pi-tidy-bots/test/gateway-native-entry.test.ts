import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { digestArtifact } from "../src/gateway/registry.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

test("every production gateway module loads with native Node stripping and no tsx loader", async () => {
  const directory = join(packageRoot, "src/gateway");
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".ts")
  );
  const urls = files.map((name) => pathToFileURL(join(directory, name)).href);
  const script = `for (const url of ${JSON.stringify(urls)}) await import(url); console.log("native-imports:" + ${files.length});`;
  const result = await run(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: packageRoot,
      env: { PATH: process.env.PATH },
      timeout: 10_000,
    }
  );
  assert.equal(result.stdout.trim(), `native-imports:${files.length}`);
});

for (const installed of [false, true])
  for (const daemon of [false, true])
    test(
      `${installed ? "installed node_modules" : "checkout"} bin ${daemon ? "daemon" : "foreground"} start preserves auth, argv and shutdown without an external loader flag`,
      { timeout: 20_000 },
      async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "tidy-native-gateway-entry-")
        );
        let child: ChildProcess | undefined;
        let daemonPid: number | undefined;
        let closed: Promise<void> | undefined;
        let output = "",
          errors = "";
        try {
          let runtimePackage = packageRoot;
          if (installed) {
            const modules = join(directory, "installation/node_modules");
            runtimePackage = join(modules, "@mobrienv/pi-tidy-bots");
            await mkdir(runtimePackage, { recursive: true });
            for (const name of ["src", "vendor", "bin", "package.json"])
              await cp(join(packageRoot, name), join(runtimePackage, name), {
                recursive: true,
              });
            const dependencies = join(packageRoot, "../../node_modules");
            for (const name of await readdir(dependencies)) {
              if (name === "@mobrienv") continue;
              await symlink(join(dependencies, name), join(modules, name));
            }
          }
          const artifact = join(directory, "plugin");
          await mkdir(artifact);
          await mkdir(join(directory, "home"));
          await writeFile(
            join(directory, "AGENTS.md"),
            "Disposable fixture; no native model or service calls.\n"
          );
          await writeFile(
            join(artifact, "backend.mjs"),
            await readFile(
              new URL(
                "./fixtures/gateway-application/backend.mjs",
                import.meta.url
              )
            )
          );
          await chmod(join(artifact, "backend.mjs"), 0o755);
          await writeFile(
            join(artifact, "backend.json"),
            JSON.stringify({
              manifestVersion: 1,
              id: "org.native-entry.fixture",
              version: "1.0.0",
              protocol: { major: 1, minMinor: 0, maxMinor: 0 },
              entrypoint: { path: "backend.mjs", args: [] },
              configSchema: "config.schema.json",
              runtime: {
                name: "isolated-fixture",
                testedVersion: "1.0.0",
                transport: "stdio",
              },
              requestedAccess: {
                workspace: "none",
                nativeProfile: false,
                network: false,
                gatewayTools: [],
              },
            })
          );
          await writeFile(
            join(artifact, "config.schema.json"),
            JSON.stringify({
              type: "object",
              properties: {},
              additionalProperties: false,
            })
          );
          await writeFile(
            join(directory, "registry.json"),
            JSON.stringify({
              registryVersion: 1,
              plugins: [
                {
                  id: "org.native-entry.fixture",
                  version: "1.0.0",
                  artifactPath: artifact,
                  sha256: await digestArtifact(artifact),
                  enabled: true,
                },
              ],
            })
          );
          await writeFile(
            join(directory, "bots.toml"),
            '[gateway]\nregistry = "registry.json"\nenvironment = ["PATH"]\n[[bot]]\nname = "fixture"\ndir = "."\nbackend = "org.native-entry.fixture"\n'
          );
          // No --import, NODE_OPTIONS or inherited loader environment: exactly the shipped bin path.
          child = spawn(
            process.execPath,
            [
              join(runtimePackage, "bin/pi-tidy-bots.mjs"),
              "start",
              directory,
              "--port",
              "0",
              "--host",
              "127.0.0.1",
              "--json",
              ...(daemon ? ["--daemon"] : []),
            ],
            {
              cwd: packageRoot,
              env: {
                PATH: process.env.PATH,
                HOME: join(directory, "home"),
                PI_TIDY_BOTS_REGISTRY: join(directory, "fleets.json"),
              },
              stdio: ["ignore", "pipe", "pipe"],
            }
          );
          child.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.stderr!.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
          });
          closed = new Promise<void>((resolve) =>
            child!.once("close", () => resolve())
          );
          const until = async <T>(
            probe: () => Promise<T> | T,
            complete: (value: T) => boolean
          ): Promise<T> => {
            const deadline = Date.now() + 8_000;
            for (;;) {
              const value = await probe();
              if (complete(value)) return value;
              if (
                !daemonPid &&
                (child!.exitCode !== null || child!.signalCode !== null)
              )
                assert.fail(
                  `Native gateway exited before readiness: ${errors}`
                );
              if (Date.now() >= deadline)
                assert.fail(
                  `Native gateway did not reach the expected state: ${errors}`
                );
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
          };
          const readiness = await until(
            () => {
              for (const line of output.trim().split("\n")) {
                try {
                  const value = JSON.parse(line);
                  if (typeof value.url === "string")
                    return value as { url: string; token: string; pid: number };
                } catch {
                  /* An incomplete output line is not readiness. */
                }
              }
              return undefined;
            },
            (value) => value !== undefined
          );
          assert.ok(readiness);
          assert.ok(Number.isSafeInteger(readiness.pid) && readiness.pid > 0);
          if (daemon) {
            daemonPid = readiness.pid;
            assert.notEqual(daemonPid, child.pid);
          } else assert.equal(readiness.pid, child.pid);
          assert.equal(typeof readiness.token, "string");
          assert.equal(
            (await readFile(join(directory, ".fleet/token"), "utf8")).trim(),
            readiness.token
          );
          const headers = { authorization: `Bearer ${readiness.token}` };
          const bindingResponse = await fetch(
            `${readiness.url}/api/bots/fixture/capabilities`,
            { headers }
          );
          assert.equal(bindingResponse.status, 200);
          const binding = (await bindingResponse.json()) as {
            conversationId: string;
            bindingRevision: string;
          };
          const admission = await fetch(
            `${readiness.url}/api/bots/fixture/message`,
            {
              method: "POST",
              headers: {
                ...headers,
                "content-type": "application/json",
                "x-tidy-client-contract": "2",
                "x-tidy-binding-revision": binding.bindingRevision,
              },
              body: JSON.stringify({
                operationId: "ordinary-bin",
                clientMessageId: "ordinary-bin",
                conversationId: binding.conversationId,
                text: "native stripping entry",
              }),
            }
          );
          assert.equal(admission.status, 202);
          const receipt = await until(
            async () => {
              const response = await fetch(
                `${readiness.url}/api/bots/fixture/operations/ordinary-bin`,
                { headers }
              );
              return (await response.json()) as {
                execution: string;
                observation: string;
              };
            },
            (value) => value.execution === "ended"
          );
          assert.equal(receipt.observation, "complete");
          if (daemonPid) {
            process.kill(daemonPid, "SIGTERM");
            await until(() => {
              try {
                process.kill(daemonPid!, 0);
                return false;
              } catch {
                return true;
              }
            }, Boolean);
          } else child.kill("SIGTERM");
          await closed;
          assert.equal(child.exitCode, 0);
          assert.equal(child.signalCode, null);
          assert.doesNotMatch(errors, /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
        } finally {
          if (daemonPid) {
            try {
              process.kill(daemonPid, "SIGTERM");
            } catch {
              /* already reaped */
            }
            for (let attempt = 0; attempt < 150; attempt++) {
              try {
                process.kill(daemonPid, 0);
              } catch {
                break;
              }
              if (attempt === 100) {
                try {
                  process.kill(daemonPid, "SIGKILL");
                } catch {
                  /* already reaped */
                }
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            const timer = setTimeout(() => child!.kill("SIGKILL"), 3000);
            await closed;
            clearTimeout(timer);
          }
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
