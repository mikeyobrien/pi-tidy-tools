import * as host from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("pi-tidy-tools.read-group");

export interface ReadGroupEntry {
  id: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
  settled: boolean;
}

export interface ReadGroupSnapshot {
  expanded: boolean;
  entries: ReadGroupEntry[];
}

type GroupHost = {
  updateArgs: (args: unknown, toolCallId?: string) => void;
  updateResult: (
    result: unknown,
    isPartial?: boolean,
    toolCallId?: string
  ) => void;
  renameEntry: (oldId: string, newId: string) => void;
  removeEntry: (toolCallId: string) => boolean;
  setExpanded: (expanded: boolean) => void;
  render: (width: number) => readonly string[];
};
export type ReadGroupConstructor = {
  new (): GroupHost;
  prototype: GroupHost;
};

export interface ReadGroupBridgeOptions {
  render: (snapshot: ReadGroupSnapshot, width: number) => string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function groupConstructor(): ReadGroupConstructor | undefined {
  const ctor = (host as { ReadToolGroupComponent?: unknown })
    .ReadToolGroupComponent;
  return typeof ctor === "function" ? (ctor as ReadGroupConstructor) : undefined;
}

/**
 * omp routes ordinary filesystem `read` calls into `ReadToolGroupComponent`
 * before an extension renderer runs. The grouping predicate is not
 * replaceable from a plugin. The group class is the object the transcript
 * constructs, so owning its `render` paints tidy cards without a host patch.
 *
 * No-ops when the host has no group component (upstream Pi).
 */
export function installReadGroupBridge(
  options: ReadGroupBridgeOptions,
  ctor: ReadGroupConstructor | undefined = groupConstructor()
): boolean {
  if (!ctor) return false;
  const proto = ctor.prototype as GroupHost & { [PATCHED]?: boolean };
  if (proto[PATCHED]) return true;

  const entries = new WeakMap<object, Map<string, ReadGroupEntry>>();
  const expanded = new WeakMap<object, boolean>();
  const bucket = (group: object): Map<string, ReadGroupEntry> => {
    let found = entries.get(group);
    if (!found) {
      found = new Map();
      entries.set(group, found);
    }
    return found;
  };

  const original = {
    updateArgs: proto.updateArgs,
    updateResult: proto.updateResult,
    renameEntry: proto.renameEntry,
    removeEntry: proto.removeEntry,
    setExpanded: proto.setExpanded,
    render: proto.render,
  };

  proto.updateArgs = function (args: unknown, toolCallId?: string): void {
    original.updateArgs.call(this, args, toolCallId);
    if (!toolCallId) return;
    const current = bucket(this).get(toolCallId);
    bucket(this).set(toolCallId, {
      id: toolCallId,
      args: asRecord(args),
      result: current?.result,
      isError: current?.isError ?? false,
      settled: current?.settled ?? false,
    });
  };
  proto.updateResult = function (
    result: unknown,
    isPartial = false,
    toolCallId?: string
  ): void {
    original.updateResult.call(this, result, isPartial, toolCallId);
    if (!toolCallId || isPartial) return;
    const record = asRecord(result);
    const current = bucket(this).get(toolCallId) ?? {
      id: toolCallId,
      args: {},
      isError: false,
      settled: false,
    };
    current.result = result;
    current.isError = record.isError === true;
    current.settled = true;
    bucket(this).set(toolCallId, current);
  };
  proto.renameEntry = function (oldId: string, newId: string): void {
    original.renameEntry.call(this, oldId, newId);
    const found = entries.get(this);
    const entry = found?.get(oldId);
    if (!found || !entry || oldId === newId || found.has(newId)) return;
    const ordered = [...found].map(
      ([key, value]): [string, ReadGroupEntry] =>
        key === oldId ? [newId, { ...value, id: newId }] : [key, value]
    );
    found.clear();
    for (const [key, value] of ordered) found.set(key, value);
  };
  proto.removeEntry = function (toolCallId: string): boolean {
    const removed = original.removeEntry.call(this, toolCallId);
    entries.get(this)?.delete(toolCallId);
    return removed;
  };
  proto.setExpanded = function (value: boolean): void {
    original.setExpanded.call(this, value);
    expanded.set(this, value);
  };
  proto.render = function (width: number): readonly string[] {
    const native = original.render.call(this, width);
    if (native.length === 0) return native;
    const snapshot: ReadGroupSnapshot = {
      expanded: expanded.get(this) ?? false,
      entries: [...(entries.get(this)?.values() ?? [])],
    };
    if (snapshot.entries.length === 0) return native;
    return options.render(snapshot, width);
  };
  proto[PATCHED] = true;
  return true;
}
