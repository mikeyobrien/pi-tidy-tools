#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "../..");
const profile = process.env.PI_FFF_TUI_PROFILE;
if (!profile) {
	const profiles = ["legacy", "scoped-floor", "scoped-current"];
	const results = profiles.map((item) => {
		const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PI_FFF_TUI_PROFILE: item } });
		return JSON.parse(output.slice(output.indexOf("{")));
	});
	console.log(JSON.stringify({ mode: "passed", profiles: results }, null, 2));
	process.exit(0);
}
const scoped = profile.startsWith("scoped-");
if (profile !== "legacy" && !scoped) throw new Error(`Unknown PI_FFF_TUI_PROFILE: ${profile}`);
const root = await mkdtemp(join(tmpdir(), `pi-tidy-fff-tui-${profile}-`));
const harness = join(root, "harness");
const project = join(root, "project");
const agent = join(root, "agent");
const packDir = join(root, "pack");
const settingsPath = join(project, ".pi", "settings.json");
const journalPath = join(project, ".pi", "pi-tidy-tools.pi-fff.json");
const observationPath = join(root, "tool-observations.jsonl");
const cardEvidencePath = join(root, "tidy-card-evidence.jsonl");
const lifecyclePath = join(root, "lifecycle.jsonl");
const piVersion = "0.80.6";
const piFffPackage = scoped ? "@ff-labs/pi-fff" : "pi-fff";
const piFffVersion = profile === "scoped-floor" ? "0.6.0" : scoped ? "0.9.6" : "0.1.12";
let child;
let rootRemoved = false;

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, ...options });
const clean = (value) => value
	.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
	.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
	.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
const jsonLines = async (path) => {
	try { return (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
	catch (error) { if (error?.code === "ENOENT") return []; throw error; }
};
const contentText = (observation) => observation.content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
const ownKeys = (value) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
const semanticDetailKeys = (value) => ownKeys(value).filter((key) => key !== "piTidyElapsedMs");

try {
	await Promise.all([
		mkdir(harness, { recursive: true }), mkdir(join(project, ".pi", "npm"), { recursive: true }),
		mkdir(agent, { recursive: true }), mkdir(packDir, { recursive: true }),
		mkdir(join(project, "nested", "path with spaces"), { recursive: true }),
	]);
	await writeFile(join(project, "nested", "path with spaces", "space marker.txt"), "PI_FFF_TUI_MARKER\n", "utf8");
	const packed = JSON.parse(run("npm", ["pack", "--workspace", "@mobrienv/pi-tidy-tools", "--json", "--pack-destination", packDir], { cwd: repoRoot }));
	const tarball = join(packDir, packed[0].filename);
	await writeFile(join(harness, "package.json"), JSON.stringify({ private: true, type: "module" }));
	run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", `@earendil-works/pi-coding-agent@${piVersion}`, tarball], { cwd: harness });
	await writeFile(join(project, ".pi", "npm", "package.json"), JSON.stringify({ private: true }));
	run("npm", ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", `${piFffPackage}@${piFffVersion}`], { cwd: join(project, ".pi", "npm") });

	const priorEntry = { source: `npm:${piFffPackage}@${piFffVersion}`, extensions: ["./index.ts"] };
	const entry = { source: `npm:${piFffPackage}@${piFffVersion}`, extensions: [] };
	await writeFile(settingsPath, JSON.stringify({ packages: [entry] }, null, 2) + "\n");
	const participant = { scope: "project", settingsPath, entryIndex: 0, priorEntry, managedEntry: entry };
	await writeFile(journalPath, JSON.stringify({
		version: 1, transactionId: "tui-smoke", operation: "setup", phase: "committed", scope: "project",
		settingsPath, counterpartPaths: [], priorEntry, managedEntry: entry, participants: [participant],
	}, null, 2) + "\n", { mode: 0o600 });
	await writeFile(join(agent, "settings.json"), "{}\n");

	const provider = join(harness, "smoke-provider.js");
	await writeFile(provider, `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const observationPath=${JSON.stringify(observationPath)};
const scoped=${JSON.stringify(scoped)};
function message(model) { return { role:"assistant", content:[], api:model.api, provider:model.provider, model:model.id, usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:"stop", timestamp:Date.now() }; }
function textOf(message) { return Array.isArray(message?.content) ? message.content.filter(x=>x?.type==="text").map(x=>x.text).join(" ") : String(message?.content ?? ""); }
function stepOf(context) { return textOf([...context.messages].reverse().find(m=>m.role==="user")).replace(/[^a-z ]/gi,"").trim(); }
function stream(model, context) {
 const out=message(model), stream=createAssistantMessageEventStream();
 queueMicrotask(() => {
  stream.push({type:"start",partial:out});
  const last=context.messages.at(-1);
  if (last?.role === "toolResult") {
   const step=stepOf(context);
   const availableTools=(context.tools ?? []).map(tool=>tool.name);
   appendFileSync(observationPath,JSON.stringify({step,content:last.content,details:last.details,isError:last.isError,availableTools})+"\\n");
   const text="SMOKE_RESULT_OBSERVED "+step;
   out.content.push({type:"text",text});
   stream.push({type:"text_start",contentIndex:0,partial:out}); stream.push({type:"text_delta",contentIndex:0,delta:text,partial:out}); stream.push({type:"text_end",contentIndex:0,content:text,partial:out});
  } else {
   const prompt=textOf(last); let name="read", args={path:"nested/path with spaces/space marker.txt",reasoning:"verify native exact read"};
   if (!scoped && prompt.includes("fuzzy")) args={path:"space marker",reasoning:"verify fuzzy read"};
   if (prompt.includes("indexed grep") || prompt.includes("public grep")) { name="grep"; args=scoped?{pattern:"PI_FFF_TUI_MARKER",reasoning:"verify public FFF grep"}:{pattern:"PI_FFF_TUI_MARKER",mode:"plain",reasoning:"verify indexed grep"}; }
   if (!scoped && prompt.includes("fallback grep")) { name="grep"; args={pattern:"PI_FFF_TUI_MARKER",ignoreCase:false,reasoning:"verify native grep fallback"}; }
   if (scoped && prompt.includes("public find")) { name="find"; args={pattern:"space marker",reasoning:"verify public FFF find"}; }
   const call={type:"toolCall",id:"smoke-"+Date.now(),name,arguments:args}; out.content.push(call); out.stopReason="toolUse";
   stream.push({type:"toolcall_start",contentIndex:0,partial:out}); stream.push({type:"toolcall_delta",contentIndex:0,delta:JSON.stringify(args),partial:out}); stream.push({type:"toolcall_end",contentIndex:0,toolCall:call,partial:out});
  }
  stream.push({type:"done",reason:out.stopReason,message:out}); stream.end();
 }); return stream;
}
export default function(pi){ pi.registerProvider("tidy-smoke",{baseUrl:"http://127.0.0.1",apiKey:"fixture",api:"tidy-smoke",streamSimple:stream,models:[{id:"deterministic",name:"Deterministic Smoke",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}]}); }
`);
	const editor = join(harness, "competing-editor.js");
	await writeFile(editor, `import { CustomEditor } from "@earendil-works/pi-coding-agent"; export default function(pi){ pi.on("session_start",(_e,ctx)=>ctx.ui.setEditorComponent((tui,theme,keys)=>new CustomEditor(tui,theme,keys))); }`);
	const lifecycle = join(harness, "lifecycle-probe.js");
	await writeFile(lifecycle, `
import { appendFileSync } from "node:fs";
const path=${JSON.stringify(lifecyclePath)};
const record=(value)=>appendFileSync(path,JSON.stringify({...value,pid:process.pid})+"\\n");
export default function(pi){
 record({event:"factory"});
 pi.on("session_start",(event,ctx)=>record({event:"session_start",reason:event.reason,sessionId:ctx.sessionManager.getSessionId()}));
 pi.on("session_shutdown",(event,ctx)=>record({event:"session_shutdown",reason:event.reason,sessionId:ctx.sessionManager.getSessionId()}));
}
`);
	const tidy = join(harness, "node_modules", "@mobrienv", "pi-tidy-tools", "index.ts");
	const pi = join(harness, "node_modules", ".bin", "pi");
	const command = [pi, "--offline", "--approve", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--model", "tidy-smoke/deterministic", "-e", editor, "-e", tidy, "-e", provider, "-e", lifecycle].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
	child = spawn("script", ["-qfec", command, "/dev/null"], {
		cwd: project, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, TERM: "xterm-256color", COLUMNS: "100", LINES: "36" },
		stdio: ["pipe", "pipe", "pipe"], detached: true,
	});
	let raw = "";
	child.stdout.on("data", (chunk) => { raw += chunk.toString(); });
	child.stderr.on("data", (chunk) => { raw += chunk.toString(); });
	const waitForOutput = async (pattern, label, after = 0, timeout = 45_000) => {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (pattern.test(clean(raw.slice(after)))) return;
			if (child.exitCode !== null) throw new Error(`${label}: Pi exited ${child.exitCode}\n${clean(raw).slice(-4000)}`);
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
		throw new Error(`${label}: timed out\n${clean(raw).slice(-4000)}`);
	};
	const waitForRecord = async (path, predicate, label, timeout = 45_000) => {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const records = await jsonLines(path);
			const match = records.find(predicate);
			if (match) return match;
			if (child.exitCode !== null) throw new Error(`${label}: Pi exited ${child.exitCode}`);
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
		throw new Error(`${label}: timed out; records=${JSON.stringify(await jsonLines(path))}`);
	};
	const send = async (text, delay = 500) => { child.stdin.write(text); await new Promise((resolveWait) => setTimeout(resolveWait, delay)); };
	const persistCardEvidence = async (step, tool, after) => {
		const output = clean(raw.slice(after));
		if (!new RegExp(`(?:^|\\n)(?:📖|✏️|⚡) ${tool}\\b`).test(output)) throw new Error(`${step}: tidy-rendered ${tool} card was not observed`);
		await appendFile(cardEvidencePath, JSON.stringify({ profile, step, tool, tidyRendered: true, excerpt: output.split("\n").filter((line) => /^(?:📖|✏️|⚡) /.test(line)).slice(-4) }) + "\n");
	};

	await waitForOutput(/deterministic/i, "startup");
	if (!scoped) await waitForOutput(/pi-fff will replace an existing custom editor/, "editor warning");
	const startup = await waitForRecord(lifecyclePath, (item) => item.event === "session_start" && item.reason === "startup", "startup lifecycle");
	let checkpoint = raw.length;
	if (!scoped) {
		await send("/fff-features\r", 1000);
		await waitForOutput(/features|Autocomplete/i, "fff-features dialog", checkpoint);
		checkpoint = raw.length;
		await send("\x1b", 300);
	}
	await send("@space", 1000);
	await waitForOutput(/space marker\.txt/, "autocomplete preserves editor focus", checkpoint);
	checkpoint = raw.length;
	await send("\x1b", 200); await send("\x15", 200);
	await send("exact read\r", 500);
	await waitForOutput(/SMOKE_RESULT_OBSERVED exact read/, "Escape dismisses autocomplete and permits next submission", checkpoint, 60_000);
	await persistCardEvidence("exact read", "read", checkpoint);

	for (const [prompt, tool] of (scoped ? [["public grep", "grep"], ["public find", "find"]] : [["fuzzy read", "read"], ["indexed grep", "grep"], ["fallback grep", "grep"]])) {
		checkpoint = raw.length;
		await send(prompt + "\r", 500);
		await waitForOutput(new RegExp(`SMOKE_RESULT_OBSERVED ${prompt}`), prompt, checkpoint, 60_000);
		await persistCardEvidence(prompt, tool, checkpoint);
	}
	const observations = await jsonLines(observationPath);
	const result = (step) => {
		const matches = observations.filter((item) => item.step === step);
		if (matches.length !== 1) throw new Error(`${step}: expected one step-local tool result, observed ${matches.length}`);
		if (matches[0].isError) throw new Error(`${step}: tool result was marked as an error`);
		return matches[0];
	};
	const exact = result("exact read");
	if (!contentText(exact).includes("PI_FFF_TUI_MARKER")) throw new Error("exact read: native result omitted file content");
	const availableTools = exact.availableTools;
	if (!Array.isArray(availableTools) || !["read", "grep", "find"].every((name) => availableTools.includes(name))) throw new Error(`model-facing public tools unavailable: ${JSON.stringify(availableTools)}`);
	if (availableTools.includes("ffgrep") || availableTools.includes("fffind")) throw new Error(`raw scoped tools are model-facing: ${JSON.stringify(availableTools)}`);
	if (scoped) {
		const publicGrep = result("public grep");
		if (!contentText(publicGrep).includes("PI_FFF_TUI_MARKER") || semanticDetailKeys(publicGrep.details).length === 0) throw new Error(`public grep: FFF result omitted content or details (${JSON.stringify(publicGrep)})`);
		const publicFind = result("public find");
		if (!contentText(publicFind).includes("space marker.txt") || semanticDetailKeys(publicFind.details).length === 0) throw new Error(`public find: FFF result omitted content or details (${JSON.stringify(publicFind)})`);
	} else {
		const fuzzy = result("fuzzy read");
		if (!contentText(fuzzy).includes("PI_FFF_TUI_MARKER")) throw new Error(`fuzzy read: FFF resolution omitted requested file content (${JSON.stringify(fuzzy)})`);
		const indexed = result("indexed grep");
		if (!contentText(indexed).includes("PI_FFF_TUI_MARKER") || semanticDetailKeys(indexed.details).length === 0) throw new Error(`indexed grep: FFF result omitted match content or semantic details (${JSON.stringify(indexed.details)})`);
		const fallback = result("fallback grep");
		if (!contentText(fallback).includes("PI_FFF_TUI_MARKER")) throw new Error(`fallback grep: native compatibility result omitted matched content (${JSON.stringify(fallback)})`);
	}

	let lifecycleCount = (await jsonLines(lifecyclePath)).length;
	checkpoint = raw.length;
	await send("/reload\r", 1000);
	await waitForRecord(lifecyclePath, (_item, index) => index >= lifecycleCount && _item.event === "session_shutdown" && _item.reason === "reload", "reload shutdown");
	await waitForRecord(lifecyclePath, (_item, index) => index >= lifecycleCount && _item.event === "session_start" && _item.reason === "reload" && _item.sessionId === startup.sessionId, "reload restart");
	if (!scoped) await waitForOutput(/pi-fff will replace an existing custom editor/, "reloaded editor warning", checkpoint);

	lifecycleCount = (await jsonLines(lifecyclePath)).length;
	await send("/new\r", 1000);
	const newShutdown = await waitForRecord(lifecyclePath, (_item, index) => index >= lifecycleCount && _item.event === "session_shutdown" && _item.reason === "new", "new-session shutdown");
	const newStart = await waitForRecord(lifecyclePath, (_item, index) => index >= lifecycleCount && _item.event === "session_start" && _item.reason === "new", "new-session start");
	if (newStart.sessionId === newShutdown.sessionId) throw new Error("/new lifecycle retained the old session identity");

	lifecycleCount = (await jsonLines(lifecyclePath)).length;
	await send("/quit\r", 100);
	await waitForRecord(lifecyclePath, (_item, index) => index >= lifecycleCount && _item.event === "session_shutdown" && _item.reason === "quit", "quit cleanup", 20_000);
	const exitCode = child.exitCode ?? await new Promise((resolveExit, reject) => {
		const timer = setTimeout(() => reject(new Error(`Pi did not exit after /quit\n${clean(raw).slice(-2000)}`)), 20_000);
		child.once("close", (code) => { clearTimeout(timer); resolveExit(code); }); child.once("error", reject);
	});
	if (exitCode !== 0) throw new Error(`Pi TUI exited ${exitCode} after /quit`);
	try { process.kill(-child.pid, 0); throw new Error("Pi process group remains alive after shutdown"); }
	catch (error) { if (error?.code !== "ESRCH") throw error; }
	const cardEvidence = await jsonLines(cardEvidencePath);
	const movedRoot = `${root}-released`;
	await rename(root, movedRoot);
	await rename(movedRoot, root);
	await rm(root, { recursive: true });
	try { await access(root); throw new Error("fixture root still exists after cleanup"); }
	catch (error) { if (error?.code !== "ENOENT") throw error; }
	rootRemoved = true;

	console.log(JSON.stringify({ mode: "passed", profile, packageIdentity: piFffPackage, piVersion, piFffVersion, packedArtifact: true, isolatedRoot: true, evidence: {
		fffFeatures: scoped ? "scoped commands/lifecycle active" : "dialog observed; Escape restored editor focus",
		autocompleteSpacePath: true, autocompleteEscape: "suggestion dismissed; exact-read submission executed",
		modelFacingTools: { required: ["read", "grep", "find"], rawExcluded: ["ffgrep", "fffind"] },
		tidyCards: cardEvidence,
		readFamilies: scoped ? ["native exact content; no fuzzy read"] : ["native exact content", "FFF fuzzy-resolved content from a non-exact path"],
		grepFamilies: scoped ? ["public FFF grep content + semantic details", "public FFF find content + semantic details"] : ["FFF indexed content + semantic details", "native compatibility fallback matched content"],
		reload: "shutdown(reload) then start(reload) with same session identity",
		sessionReplacement: "shutdown(new) then start(new) with distinct session identity",
		editorWarning: !scoped,
		runtimeCleanup: "shutdown(quit) completed; /quit exited 0; process group gone; fixture root renamed and removed",
	} }, null, 2));
} catch (error) {
	console.log(JSON.stringify({ mode: "blocked", gate: "real Pi TUI smoke", reason: error instanceof Error ? error.message : String(error), action: "Run on Linux with util-linux script(1), npm access, and a PTY-capable terminal host." }, null, 2));
	process.exitCode = 2;
} finally {
	if (child?.exitCode === null) {
		try { process.kill(-child.pid, "SIGTERM"); } catch {}
		await new Promise((resolveClose) => {
			const timer = setTimeout(resolveClose, 5_000);
			child.once("close", () => { clearTimeout(timer); resolveClose(); });
		});
	}
	if (!rootRemoved) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
