import assert from "node:assert/strict";
import test from "node:test";
import { buildEnvelope } from "../index.js";
import type { ChildState, ChildStatus } from "../types.js";

function child(overrides: Partial<ChildState> = {}): ChildState {
  return {
    index: 0,
    id: "child-0",
    label: "agent",
    reason: "test envelope",
    prompt: "prompt",
    status: "completed",
    model: "provider/model",
    thinking: "off",
    toolCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    providerTraffic: 0,
    tokens: 0,
    activities: [],
    activeTools: [],
    eventCount: 0,
    response: "",
    artifactPath: "/runs/example/child-001.md",
    ...overrides,
  };
}

const contentOf = (envelope: string): string => {
  const match = envelope.match(
    /<content format="markdown"><!\[CDATA\[([\s\S]*)\]\]><\/content>/
  );
  assert.ok(match, "expected one markdown CDATA element");
  return match[1];
};

test("buildEnvelope emits children in input order with every public status and exact separators", () => {
  const statuses: ChildStatus[] = [
    "queued",
    "starting",
    "running",
    "completed",
    "warning",
    "failed",
    "cancelled",
    "not-started",
  ];
  const actual = buildEnvelope(
    statuses.map((status, index) =>
      child({
        index,
        label: `agent-${index}`,
        status,
        response: status,
        artifactPath: `/artifacts/${index}.md`,
      })
    )
  );

  assert.equal(
    actual,
    `<subagent_result index="0" label="agent-0" status="queued" artifact="/artifacts/0.md"><content format="markdown"><![CDATA[queued]]></content></subagent_result>
<subagent_result index="1" label="agent-1" status="starting" artifact="/artifacts/1.md"><content format="markdown"><![CDATA[starting]]></content></subagent_result>
<subagent_result index="2" label="agent-2" status="running" artifact="/artifacts/2.md"><content format="markdown"><![CDATA[running]]></content></subagent_result>
<subagent_result index="3" label="agent-3" status="completed" artifact="/artifacts/3.md"><content format="markdown"><![CDATA[completed]]></content></subagent_result>
<subagent_result index="4" label="agent-4" status="warning" artifact="/artifacts/4.md"><content format="markdown"><![CDATA[warning]]></content></subagent_result>
<subagent_result index="5" label="agent-5" status="failed" artifact="/artifacts/5.md"><content format="markdown"><![CDATA[failed]]></content></subagent_result>
<subagent_result index="6" label="agent-6" status="cancelled" artifact="/artifacts/6.md"><content format="markdown"><![CDATA[cancelled]]></content></subagent_result>
<subagent_result index="7" label="agent-7" status="not-started" artifact="/artifacts/7.md"><content format="markdown"><![CDATA[not-started]]></content></subagent_result>`
  );
  assert.equal(actual.split("\n").length, 8);
  assert.equal(actual.endsWith("\n"), false);
  assert.equal(buildEnvelope([]), "");
});

test("buildEnvelope escapes XML attributes but preserves CDATA text and splits terminators", () => {
  const actual = buildEnvelope([
    child({
      index: 27,
      label: `A&B<\"C>'`,
      status: "failed",
      response: `literal <tag a="b"> & before ]]> after ]]>`,
      artifactPath: `/tmp/A&B<\"C>'/result.md`,
    }),
  ]);

  assert.equal(
    actual,
    `<subagent_result index="27" label="A&amp;B&lt;&quot;C&gt;'" status="failed" artifact="/tmp/A&amp;B&lt;&quot;C&gt;'/result.md"><content format="markdown"><![CDATA[literal <tag a="b"> & before ]]]]><![CDATA[> after ]]]]><![CDATA[>]]></content></subagent_result>`
  );
  assert.equal(actual.includes("literal &lt;tag"), false);
  assert.equal((actual.match(/]]]]><!\[CDATA\[>/g) ?? []).length, 2);
});

test("buildEnvelope uses a nonempty response before an error and otherwise exposes the error", () => {
  const actual = buildEnvelope([
    child({
      index: 0,
      response: "response wins",
      error: "hidden error",
      artifactPath: "/a.md",
    }),
    child({
      index: 1,
      response: "",
      error: "visible <error> & details",
      artifactPath: "/b.md",
    }),
    child({ index: 2, response: "", artifactPath: "/c.md" }),
  ]);

  assert.equal(
    actual,
    `<subagent_result index="0" label="agent" status="completed" artifact="/a.md"><content format="markdown"><![CDATA[response wins]]></content></subagent_result>
<subagent_result index="1" label="agent" status="completed" artifact="/b.md"><content format="markdown"><![CDATA[visible <error> & details]]></content></subagent_result>
<subagent_result index="2" label="agent" status="completed" artifact="/c.md"><content format="markdown"><![CDATA[]]></content></subagent_result>`
  );
  assert.equal(actual.includes("hidden error"), false);
});

test("buildEnvelope truncates each child content at exactly 16 KiB without splitting Unicode", () => {
  const actual = buildEnvelope([
    child({
      index: 0,
      label: "ascii",
      response: "x".repeat(20_000),
      artifactPath: "/ascii.md",
    }),
    child({
      index: 1,
      label: "emoji",
      response: "🧭".repeat(5_000),
      artifactPath: "/emoji.md",
    }),
    child({
      index: 2,
      label: "boundary",
      response: `${"a".repeat(16_381)}🧭tail`,
      artifactPath: "/boundary.md",
    }),
  ]);
  const contents = [
    ...actual.matchAll(
      /<content format="markdown"><!\[CDATA\[([\s\S]*?)\]\]><\/content>/g
    ),
  ].map((match) => match[1]);

  assert.equal(contents.length, 3);
  assert.equal(contents[0], "x".repeat(16_384));
  assert.equal(Buffer.byteLength(contents[0]!, "utf8"), 16_384);
  assert.equal(contents[1], "🧭".repeat(4_096));
  assert.equal(Buffer.byteLength(contents[1]!, "utf8"), 16_384);
  assert.equal(contents[2], "a".repeat(16_381));
  assert.equal(Buffer.byteLength(contents[2]!, "utf8"), 16_381);
  assert.equal(
    contents.some((content) => content.includes("�")),
    false
  );
});

test("buildEnvelope charges CDATA splitting bytes against the per-child limit", () => {
  const actual = buildEnvelope([
    child({ response: "]]>".repeat(2_000), artifactPath: "/split.md" }),
  ]);
  const renderedContent = contentOf(actual);

  assert.equal(renderedContent, "]]]]><![CDATA[>".repeat(1_092));
  assert.equal(Buffer.byteLength(renderedContent, "utf8"), 16_380);
  assert.equal(Buffer.byteLength("]]]]><![CDATA[>", "utf8"), 15);
  assert.equal(actual.endsWith("]]></content></subagent_result>"), true);
});

test("buildEnvelope budgets wrapper and newline bytes within the exact 50 KiB total", () => {
  const actual = buildEnvelope(
    Array.from({ length: 5 }, (_, index) =>
      child({
        index,
        label: "x",
        response: String(index).repeat(20_000),
        artifactPath: "/a",
      })
    )
  );
  const contents = [
    ...actual.matchAll(
      /<content format="markdown"><!\[CDATA\[([\s\S]*?)\]\]><\/content>/g
    ),
  ].map((match) => match[1]);

  assert.deepEqual(
    contents.map((content) => Buffer.byteLength(content, "utf8")),
    [16_384, 16_384, 16_384, 1_359, 0]
  );
  assert.equal(contents[0], "0".repeat(16_384));
  assert.equal(contents[1], "1".repeat(16_384));
  assert.equal(contents[2], "2".repeat(16_384));
  assert.equal(contents[3], "3".repeat(1_359));
  assert.equal(contents[4], "");
  assert.equal(Buffer.byteLength(actual, "utf8"), 51_200);
  assert.equal((actual.match(/\n/g) ?? []).length, 4);
  assert.equal(actual.includes("\n\n"), false);
});

test("buildEnvelope packs empty child wrappers before the total-limit truncation marker", () => {
  const actual = buildEnvelope(
    Array.from({ length: 60 }, (_, index) =>
      child({
        index,
        label: "z".repeat(1_000),
        artifactPath: `/runs/demo/${index}.md`,
      })
    )
  );
  const indexes = [...actual.matchAll(/<subagent_result index="(\d+)"/g)].map(
    (match) => Number(match[1])
  );

  assert.deepEqual(
    indexes,
    Array.from({ length: 44 }, (_, index) => index)
  );
  assert.equal((actual.match(/<!\[CDATA\[\]\]>/g) ?? []).length, 44);
  assert.equal(actual.includes(`<subagent_result index="44"`), false);
  assert.equal(
    actual.endsWith(
      `\n<subagent_results_truncated total="60" artifacts="/runs/demo"/>`
    ),
    true
  );
  assert.equal((actual.match(/\n/g) ?? []).length, 44);
  assert.equal(Buffer.byteLength(actual, "utf8"), 50_731);
  assert.ok(Buffer.byteLength(actual, "utf8") <= 51_200);
});

test("buildEnvelope emits an exact escaped truncation marker when attributes alone exceed 50 KiB", () => {
  const hugeLabel = "z".repeat(52_000);
  const actual = buildEnvelope([
    child({ index: 0, label: hugeLabel, artifactPath: `/runs/a&b<\">/0.md` }),
    child({ index: 1, label: hugeLabel, artifactPath: `/runs/a&b<\">/1.md` }),
  ]);

  assert.equal(
    actual,
    `<subagent_results_truncated total="2" artifacts="/runs/a&amp;b&lt;&quot;&gt;"/>`
  );
  assert.equal(Buffer.byteLength(actual, "utf8"), 79);
  assert.equal(actual.includes("subagent_result index="), false);
});
