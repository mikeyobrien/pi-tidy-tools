import { register } from "tsx/esm/api";

register();
const protocol = await import("../gateway/protocol.ts");
export const {
  CORE_METHODS,
  DEFAULT_LIMITS,
  encodeFrame,
  FrameDecoder,
  nonempty,
  object,
  parseRpc,
  ProtocolError,
  validateCapabilities,
  validateEvent,
  validateLimits,
} = protocol;
