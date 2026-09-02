/**
 * Turn = ordered parts (issue 37, t3code model): text and tool segments in
 * chronological order — order is data, not rendering. The accumulator is the
 * daemon-side keystone; grouping helpers are shared shape logic.
 */

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  tool: string;
  label?: string;
  reason?: string;
  status: "running" | "ok" | "error";
  /** Wall-clock ms when the tool started (client-side elapsed tick source). */
  started?: number;
  duration?: number;
  output?: string;
}

export type TurnPart = TextPart | ToolPart;

const OUTPUT_CAP = 1200;

export class TurnPartsAccumulator {
  parts: TurnPart[] = [];
  /** Issue 123/124: pending message boundary — the next text opens a NEW
   * part so narration blocks stay distinct even without a tool between
   * them. */
  private pendingSplit = false;

  /** Streaming text: append to the trailing text part, else open a new one. */
  appendText(delta: string): void {
    if (delta.length === 0) return;
    const last = this.parts[this.parts.length - 1];
    if (!this.pendingSplit && last && last.type === "text") last.text += delta;
    else {
      this.parts.push({ type: "text", text: delta });
      this.pendingSplit = false;
    }
  }

  /**
   * Issue 123/124: mark a message boundary — the next appended text starts
   * a fresh part (narration blocks stay distinct; concatText unchanged).
   */
  splitText(): void {
    this.pendingSplit = true;
  }

  startTool(part: {
    toolCallId: string;
    tool: string;
    label?: string;
    reason?: string;
    started?: number;
  }): void {
    // Idempotent by toolCallId (issue 29-item-4 mirror): replayed/re-delivered
    // starts update the existing part instead of duplicating it.
    const existing = this.findTool(part.toolCallId);
    if (existing) {
      existing.tool = part.tool;
      if (part.label !== undefined) existing.label = part.label;
      if (part.reason !== undefined) existing.reason = part.reason;
      return;
    }
    this.parts.push({ type: "tool", status: "running", ...part });
  }

  /** Issue 49: at settle, no tool may still claim "running". */
  forceSettleRunning(): void {
    for (const part of this.parts) {
      if (part.type === "tool" && part.status === "running")
        part.status = "error";
    }
  }

  private findTool(toolCallId: string): ToolPart | undefined {
    const part = this.parts.find(
      (candidate) =>
        candidate.type === "tool" && candidate.toolCallId === toolCallId
    );
    return part && part.type === "tool" ? part : undefined;
  }

  updateToolOutput(toolCallId: string, output: string): void {
    const part = this.findTool(toolCallId);
    if (part) part.output = output.slice(0, OUTPUT_CAP);
  }

  settleTool(
    toolCallId: string,
    result: { isError: boolean; duration?: number; output?: string }
  ): void {
    const part = this.findTool(toolCallId);
    if (!part) return;
    part.status = result.isError ? "error" : "ok";
    if (result.duration !== undefined) part.duration = result.duration;
    if (result.output !== undefined)
      part.output = result.output.slice(0, OUTPUT_CAP);
  }

  /** Back-compat: the concatenation of text parts (roster latest, entry text). */
  concatText(): string {
    return this.parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  /** Plain-JSON deep copy for the WS snapshot + transcript persistence. */
  snapshot(): TurnPart[] {
    return JSON.parse(JSON.stringify(this.parts)) as TurnPart[];
  }
}

export interface ToolGroup {
  type: "toolgroup";
  tools: ToolPart[];
}

export type RenderPart = TextPart | ToolGroup;

/**
 * Console grouping: consecutive tool parts collapse under one block; a text
 * part splits the group (narrative order is data).
 */
export function groupConsecutiveTools(parts: TurnPart[]): RenderPart[] {
  const out: RenderPart[] = [];
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

/** Natural-language badge for a collapsed tool group: "3 tools · 2 ok · 1 err". */
export function summarizeToolGroup(tools: ToolPart[]): string {
  const ok = tools.filter((t) => t.status === "ok").length;
  const err = tools.filter((t) => t.status === "error").length;
  const running = tools.filter((t) => t.status === "running").length;
  const bits = [`${tools.length} ${tools.length === 1 ? "tool" : "tools"}`];
  if (ok > 0) bits.push(`${ok} ok`);
  if (err > 0) bits.push(`${err} err`);
  if (running > 0) bits.push(`${running} running`);
  return bits.join(" · ");
}
