# Scroll Doctrine — pi-tidy-bots console

- **Version:** 1.0
- **Attribution:** Operator decision, 2026-08-31
- **Status:** In force. Principles govern every current and future scrollable
  surface (transcript pane, roster, logs). Amendments only via the Drift &
  additions section at the bottom.

## Why this exists

The transcript pane is a live-append log competing with an operator who is
trying to read history. Without doctrine, every new feature re-litigates "who
owns the scroll position" and ships whatever the author coded that day. This
document settles it: the operator owns the scroll position; the machine may
hold it only while the operator is already at the bottom, and only explicit
intent moves it otherwise.

## The fifteen principles

1. **P1 — Explicit intent only.** The pane never scrolls without either (a)
   the operator being pinned to the bottom, or (b) an explicit operator action
   (selecting a bot, sending, expanding, focusing). Ambient events are never
   intent.
2. **P2 — Bottom is the default home.** A fresh pane, a fresh boot, and a bot
   switch land at the bottom. Newcomers see the present, not the top.
3. **P3 — Stick-to-bottom.** While pinned to the bottom (within a small
   threshold), streaming output keeps the view pinned: deltas, steps, and
   appends scroll for free.
4. **P4 — Scroll-up is sovereignty.** Moving up unpins. No event — delta,
   step, append, roster, or routine — may scroll, clamp, or yank the pane
   while unpinned.
5. **P5 — Return to bottom re-pins.** Scrolling back into the bottom
   threshold restores the pin; nothing needs to be toggled manually.
6. **P6 — Thresholds, not pixels of truth.** Pin detection uses a small
   bottom threshold (48px) so font rounding and fractional heights never
   flip-flop the pin.
7. **P7 — Context switches are exempt.** Selecting a bot, re-rendering a
   transcript, a visual-viewport resize (iOS keyboard), and composer focus
   scroll unconditionally: they are deliberate context changes, not streaming
   competition.
8. **P8 — No programmatic scroll may fight the operator mid-gesture.** Any
   auto-scroll implementation must be idempotent per frame and must never
   queue a "correction" that fires after the operator's next gesture.
9. **P9 — Terminal anchors beat timers.** Scroll behavior is driven by real
   events (scroll, append, phase change) — never by polling intervals.
10. **P10 — Safe-area and viewport fitting come first.** iOS visual-viewport
    fitting runs before any scroll decision; scroll math never assumes a
    static viewport height.
11. **P11 — History is readable at all times.** If a feature makes history
    unreadable while output streams, the feature is wrong, not the operator.
12. **P12 — Expand and mutate in place.** Revealing more content (expanded
    pills, resolved question cards) happens in place; the surrounding layout
    shifts naturally and nothing re-anchors the pane.
13. **P13 — Nothing steals position.** Content above or beside the viewport
    changing size must not move the viewport. Collapses, removes, and roster
    updates are position-preserving for the transcript pane.
14. **P14 — Failure to scroll is never an error.** Scroll helpers are
    best-effort UI; they must not throw, log noise, or affect delivery state.
15. **P15 — New surfaces inherit the doctrine.** Any new pane, overlay, or
    client (including non-web clients) implements the same contract: pinned
    streaming follow, explicit-intent navigation, position-preserving
    mutation.

## Drift & additions

| Date       | Change                                                                                                                                                                                                                                                                         | Source                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| 2026-08-31 | v1.0 ratified: 15 principles, operator attribution. Extracted from implemented behavior (issue 21 stick-to-bottom, issue 23 pill clamp, issue 35 pill expand) after the verifier flagged doctrine drift twice (docs/scroll-doctrine.md missing while client work gated on it). | atlas (dispatch), forge (transcription) |

Amendments: add a row above with date, principle numbers touched, and the
issuing dispatch. Principle renumbering is forbidden — new principles append
as P16+, retirements are marked struck-through and never reused.
