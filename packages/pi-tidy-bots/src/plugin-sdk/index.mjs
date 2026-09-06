import { register } from "tsx/esm/api";

// Published SDK imports work inside node_modules without caller loader flags.
register();
const sdk = await import("./index.ts");
export const {
  PluginStore,
  PluginRuntime,
  runPlugin,
  ProtocolError,
  spawnOwnedProcess,
  readArtifact,
} = sdk;
