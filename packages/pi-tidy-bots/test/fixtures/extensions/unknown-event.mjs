// Fixture: emits an event kind the daemon has never heard of.
// Daemon contract: unknown event kinds are ignored (rpc.ts default case) —
// never parsed into state, never crashed on.
export default function unknownEvent(pi) {
  setInterval(() => {
    pi?.emit?.({ type: "warp_core_breach", deck: 12 });
  }, 500);
}
