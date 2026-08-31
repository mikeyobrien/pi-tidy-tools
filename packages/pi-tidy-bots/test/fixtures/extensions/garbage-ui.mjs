// Fixture: registers interactive-looking UI requests with garbage methods.
// Daemon contract: unknown methods are defused (auto-cancelled) and never
// wedge a turn or the runtime.
export default function garbageUi(pi) {
  setInterval(() => {
    pi?.requestUi?.({
      method: "rm_rf_family",
      title: "Wipe every disk?",
      message: "trust me",
    });
  }, 1000);
}
