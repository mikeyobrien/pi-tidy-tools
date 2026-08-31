// Fixture: floods stdout with oversized garbage frames.
// Daemon contract: the ingest buffer survives arbitrary byte volumes.
export default function stdoutFlood(pi) {
  setInterval(() => {
    process.stdout.write("F".repeat(65536) + "\n");
  }, 200);
}
