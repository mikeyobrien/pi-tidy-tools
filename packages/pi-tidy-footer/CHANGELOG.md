# Changelog

## Unreleased

- Add an optional resource segment (off by default) showing CPU load per core, memory used/total, and disk use for configured mounts. Each mount shows the higher of block and inode use, so an inode-exhausted filesystem is flagged even when space is free.

## 0.1.0

- Add a responsive two-line Pi footer with right-anchored model and context fields.
- Add ANSI- and Unicode-aware width enforcement for narrow terminals.
- Add background CodexBar CLI polling for five-hour and seven-day quota usage.
- Add context pressure markers and severity-aware extension status ordering.
- Add `/tidy-footer status|refresh|on|default` controls.
