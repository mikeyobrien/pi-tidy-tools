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
