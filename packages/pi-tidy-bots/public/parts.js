// Browser-global parts helpers (issue 37): console-side grouping + badges for
// the ordered turn-parts model. Mirrors src/turnparts.ts shape logic.
"use strict";
(function (global) {
  /** Collapse consecutive tool parts into groups; text splits the run. */
  function groupConsecutiveTools(parts) {
    const out = [];
    for (const part of parts) {
      if (part.type === "tool") {
        const last = out[out.length - 1];
        if (last && last.type === "toolgroup") last.tools.push(part);
        else out.push({ type: "toolgroup", tools: [part] });
      } else {
        out.push(part);
      }
    }
    return out;
  }

  /** "3 tools · 2 ok · 1 err" — natural-language collapsed badge. */
  function summarizeToolGroup(tools) {
    const ok = tools.filter((t) => t.status === "ok").length;
    const err = tools.filter((t) => t.status === "error").length;
    const running = tools.filter((t) => t.status === "running").length;
    const bits = [`${tools.length} ${tools.length === 1 ? "tool" : "tools"}`];
    if (ok > 0) bits.push(`${ok} ok`);
    if (err > 0) bits.push(`${err} err`);
    if (running > 0) bits.push(`${running} running`);
    return bits.join(" · ");
  }

  const Parts = { groupConsecutiveTools, summarizeToolGroup };
  global.Parts = Parts;
  if (typeof module !== "undefined" && module.exports) module.exports = Parts;
})(typeof window !== "undefined" ? window : globalThis);
