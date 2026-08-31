import assert from "node:assert/strict";
import test from "node:test";

test("mini markdown renders bold, lists, code — and never raw HTML", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/md.js");
  const { render } = (globalThis as any).PiMd;
  const out = render("**Not stable.**\n\n- GPU0 99% / 20GB\n- down 5h");
  assert.match(out, /<strong>Not stable\.<\/strong>/);
  assert.match(out, /<ul><li>GPU0 99% \/ 20GB<\/li><li>down 5h<\/li><\/ul>/);
  assert.ok(!out.includes("<script>"), "raw html must not pass through");
});

test("markdown escapes injected html and scripts", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/md.js");
  const { render } = (globalThis as any).PiMd;
  const out = render(
    '<img src=x onerror=alert(1)> "<script>alert(2)</script>"'
  );
  assert.ok(!out.includes("<img"), "injected tags must be escaped");
  assert.ok(!out.includes("<script>"), "injected scripts must be escaped");
  assert.match(out, /&lt;img/);
});

test("markdown renders https images as lazy imgs sized to the bubble", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/md.js");
  const { render } = (globalThis as any).PiMd;
  const out = render("![GPU rack](https://example.com/rack.png)");
  assert.match(
    out,
    /<img src="https:\/\/example\.com\/rack\.png" alt="GPU rack" loading="lazy" \/>/
  );
});

test("non-https image markdown does not become an img tag", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/md.js");
  const { render } = (globalThis as any).PiMd;
  const out = render("![cat](http://example.com/cat.png)");
  assert.ok(!out.includes("<img"), "http URLs must not render as images");
});

test("raw img tags still cannot pass through as html", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/md.js");
  const { render } = (globalThis as any).PiMd;
  const out = render('<img src="https://evil.example/x.png">');
  assert.ok(!out.includes("<img src="), "raw img must stay escaped");
  assert.match(out, /&lt;img/);
});

test("renderInline keeps pills inline: links yes, images no", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/md.js");
  const { renderInline } = (globalThis as any).PiMd;
  const out = renderInline(
    "Fix **auth** now — see `docs/x.md` and [spec](https://example.com/s). ![pic](https://example.com/p.png)"
  );
  assert.match(out, /<strong>auth<\/strong>/);
  assert.match(out, /<code>docs\/x\.md<\/code>/);
  assert.match(
    out,
    /<a href="https:\/\/example\.com\/s" target="_blank" rel="noopener noreferrer">spec<\/a>/
  );
  assert.ok(!out.includes("<img"), "pills must not render images");
  assert.ok(!out.includes("<ul>"), "no block elements in inline output");
  // Raw html still escapes.
  assert.ok(!renderInline("<b>x</b>").includes("<b>"));
});

test("parts helpers: grouping, badges — browser script contract", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/parts.js");
  const { groupConsecutiveTools, summarizeToolGroup } = (globalThis as any)
    .Parts;
  const parts = [
    { type: "text", text: "checking" },
    { type: "tool", toolCallId: "1", tool: "bash", label: "ls", status: "ok" },
    {
      type: "tool",
      toolCallId: "2",
      tool: "edit",
      label: "x.md",
      status: "error",
    },
    { type: "text", text: "done" },
    {
      type: "tool",
      toolCallId: "3",
      tool: "bash",
      label: "tail",
      status: "running",
    },
  ];
  const groups = groupConsecutiveTools(parts);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].type, "text");
  assert.equal(groups[1].type, "toolgroup");
  if (groups[1].type === "toolgroup") {
    assert.deepEqual(
      groups[1].tools.map((t: { toolCallId: string }) => t.toolCallId),
      ["1", "2"]
    );
    assert.equal(
      summarizeToolGroup(groups[1].tools as { status: string }[]),
      "2 tools · 1 ok · 1 err"
    );
  }
  assert.equal(groups[3].type, "toolgroup");
});

test("relativeTime rounds now/Nm/Nh/Nd and goes absolute past 7d", async () => {
  // @ts-expect-error browser-global script, intentionally untyped
  await import("../public/parts.js");
  const { relativeTime, absoluteTime } = (globalThis as any).Parts;
  const now = Date.UTC(2026, 7, 31, 12, 0, 0);
  const at = (minutes: number, seconds = 0) =>
    new Date(now - (minutes * 60 + seconds) * 1000).toISOString();
  assert.equal(relativeTime(at(0, 10), now), "now");
  assert.equal(relativeTime(at(12), now), "12m");
  assert.equal(relativeTime(at(90), now), "1h");
  assert.equal(relativeTime(at(60 * 5), now), "5h");
  assert.equal(relativeTime(at(60 * 30), now), "1d");
  assert.equal(relativeTime(at(60 * 24 * 3), now), "3d");
  // Past 7d: absolute locale date — assert against the same call the
  // helper makes, keeping the test locale-independent.
  const nineDaysAgo = at(60 * 24 * 9);
  assert.equal(
    relativeTime(nineDaysAgo, now),
    new Date(nineDaysAgo).toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })
  );
  assert.equal(absoluteTime("not-a-date"), "");
  assert.match(absoluteTime(at(5)), /\d/);
});
