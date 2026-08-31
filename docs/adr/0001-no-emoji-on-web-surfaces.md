# ADR 0001: No emoji on web surfaces

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** fleet operator, atlas (triage), forge (implementation)

## Context

Bot identity and status chrome previously leaned on emoji: the manifest
`avatar` field defaulted to `"🤖"`, and several daemon/console-issued display
strings embedded pictographs (`🤖 …`, `⏰ Routine: …`, `❓ …`). Emoji render
differently across platforms and fonts (color, monochrome, tofu boxes on thin
Linux installs), which makes the console look inconsistent — and
unprofessional — on exactly the surfaces where the fleet is monitored.

Model- and user-authored text is a different matter: the daemon does not
control what bots say, and sanitizing content would corrupt it.

## Decision

1. **Identity = blob color + initial letter.** Every bot is represented by its
   stable `colorFor(name)` blob with the bot's initial (first character of the
   name, uppercase) centered inside it. A manifest `avatar` field is still
   accepted and, when non-empty, its text renders inside the blob in place of
   the initial (backward compatibility). The default when absent is empty.
2. **UI chrome and daemon-issued display strings are emoji-free.** Any string
   the daemon emits for display and any console chrome element uses plain text
   or typographic glyphs (`→`, `↑`, `●`). Pictograph emoji are not allowed.
3. **Model/user content is exempt.** Message text, prompts, and bot replies
   are never sanitized for emoji.
4. **The Flutter client follows the same rule**: blob color + initial, no
   emoji in roster or chrome.

## Consequences

- The `avatar` manifest field is optional; omitting it yields the cleaner
  initial-in-blob identity.
- Daemon code must not reintroduce emoji into display strings; console chrome
  uses typographic glyphs where a symbol is needed.
- Cross-platform rendering consistency improves and no font stack needs emoji
  coverage.
- The demo fleet scaffold and documentation no longer ship emoji avatars.
