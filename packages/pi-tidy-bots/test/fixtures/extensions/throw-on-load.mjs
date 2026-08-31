// Fixture: an extension that explodes before registering anything.
// Daemon contract: a crashed load must never wedge the runtime — the child
// exits and the existing restart budget covers recovery.
throw new Error("throw-on-load: extension exploded during evaluation");
