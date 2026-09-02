/**
 * Issue 132: default provider registrations. Importing this module is the
 * whole setup — provider B lands here (or self-registers in tests) with
 * zero core edits.
 */
import { registerImageProvider } from "../registry.js";
import { grokBuildProvider } from "./grok-build.js";

registerImageProvider(grokBuildProvider());
