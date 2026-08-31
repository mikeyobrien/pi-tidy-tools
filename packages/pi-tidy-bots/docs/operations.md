# Operations

## launchd KeepAlive (macOS)

Save as `~/Library/LaunchAgents/dev.mobrienv.pi-tidy-bots.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.mobrienv.pi-tidy-bots</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string>
    <string>pi-tidy-bots</string>
    <string>start</string>
    <string>/Users/you/fleet</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><string>30</string>
  <key>StandardOutPath</key><string>/Users/you/fleet/.fleet/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/you/fleet/.fleet/logs/daemon.err.log</string>
</dict></plist>
```

Load: `launchctl load ~/Library/LaunchAgents/dev.mobrienv.pi-tidy-bots.plist`.
The fleet lock makes double-start safe: a second daemon exits with a typed error, and
a stale lock (dead owner) is taken over by heartbeat rules.

## Routines journal

Fires, skips, toggles, and manual runs append to `.fleet/routines.jsonl`. Per Flag B,
fire times missed while the daemon was down are skipped and journaled — never
catch-up fired.

## Logs

Daemon stdout/stderr go to your supervisor (launchd paths above). Child rpc traffic is
bounded: streaming deltas are excluded from the sink and lines capped at 500 chars.
