import { dirname } from "node:path";
import type { ChildState } from "./types.js";

const CHILD_LIMIT = 16 * 1024;
const TOTAL_LIMIT = 50 * 1024;
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const attr = (value: string): string => value
 .replace(/&/g, "&amp;")
 .replace(/"/g, "&quot;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;");
function truncateCdata(value: string, maxBytes: number): string {
 if (maxBytes <= 0) return "";
 let output = "";
 let used = 0;
 for (let index = 0; index < value.length;) {
  const source = value.startsWith("]]>", index) ? "]]>" : String.fromCodePoint(value.codePointAt(index)!);
  const rendered = source === "]]>" ? "]]]]><![CDATA[>" : source;
  const size = bytes(rendered);
  if (used + size > maxBytes) break;
  output += rendered;
  used += size;
  index += source.length;
 }
 return output;
}

export function buildEnvelope(children: ChildState[], totalLimit = TOTAL_LIMIT): string {
 const wrappers = children.map((child) => ({
  open: `<subagent_result index="${child.index}" label="${attr(child.label)}" status="${child.status}" artifact="${attr(child.artifactPath)}"><content format="markdown"><![CDATA[`,
  close: "]]></content></subagent_result>",
 }));
 const baseBytes = Math.max(0, children.length - 1) + wrappers.reduce((sum, wrapper) => sum + bytes(wrapper.open) + bytes(wrapper.close), 0);
 if (baseBytes > totalLimit) {
  const runDir = children[0]?.artifactPath ? dirname(children[0].artifactPath) : "";
  const marker = `<subagent_results_truncated total="${children.length}" artifacts="${attr(runDir)}"/>`;
  if (bytes(marker) > totalLimit) return "";
  const output: string[] = [];
  let used = bytes(marker) + (children.length > 0 ? 1 : 0);
  for (let index = 0; index < children.length; index++) {
   const empty = `${wrappers[index]!.open}${wrappers[index]!.close}`;
   const added = bytes(empty) + (output.length > 0 ? 1 : 0);
   if (used + added > totalLimit) break;
   output.push(empty);
   used += added;
  }
  output.push(marker);
  return output.join("\n");
 }

 let remaining = totalLimit - baseBytes;
 return children.map((child, index) => {
  const original = child.response || child.error || "";
  const allowed = Math.max(0, Math.min(CHILD_LIMIT, remaining));
  const content = truncateCdata(original, allowed);
  remaining -= bytes(content);
  return `${wrappers[index]!.open}${content}${wrappers[index]!.close}`;
 }).join("\n");
}
