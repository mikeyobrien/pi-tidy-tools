import { register } from "tsx/esm/api";

register();
const { runCommunityPythonExample } = await import("./community-example.ts");

export { runCommunityPythonExample };
