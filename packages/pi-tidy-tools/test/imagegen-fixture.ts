/**
 * Issue 132 test fixture: registers TWO fake image providers — proving the
 * registry is open/closed (a second provider needed zero core edits).
 */
import "../imagegen/providers/index.js";
import { registerImageProvider } from "../imagegen/registry.js";

registerImageProvider({
  id: "fake-a",
  aspects: ["1:1", "16:9"],
  resolutions: ["1k"],
  maxCount: 3,
  async generate(request) {
    const images = Array.from({ length: request.count }, () => ({
      buffer: Buffer.from(`fake-a:${request.prompt}`),
      mediaType: "image/png",
    }));
    return { ok: true, images };
  },
});

registerImageProvider({
  id: "fake-b",
  maxCount: 1,
  async generate() {
    return { ok: false, code: "provider_failure", message: "fake-b is broken" };
  },
});
