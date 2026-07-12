import assert from "node:assert/strict";
import test from "node:test";
import { renderLines } from "../render.js";

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

test("parallel running label stays in one column across live frames", () => {
 const child: any = {
  index: 0, id: "parallel", label: "verifier", reason: "verify parallel rendering", prompt: "",
  status: "running", model: "m", thinking: "high", toolCount: 3, tokens: 0,
  activities: [], activeTools: [
   { name: "bash", activityIndex: 0 },
   { name: "bash", activityIndex: 0 },
   { name: "bash", activityIndex: 0 },
  ],
  eventCount: 0, startedAt: 1, response: "", artifactPath: "/parallel",
 };
 const details: any = { children: [child] };
 const frames = [0, 120, 240, 360, 480, 600, 720, 840, 960, 1_080]
  .map((now) => renderLines(details, false, now, 120).map(stripAnsi))
  .map((lines) => lines.find((line) => line.includes("parallel 3 tools running"))!);
 const columns = frames.map((line) => line.indexOf("parallel"));

 assert.ok(frames.every(Boolean), "every live frame must render the parallel summary");
 assert.deepEqual([...new Set(columns)], [10], frames.join("\n"));
});
