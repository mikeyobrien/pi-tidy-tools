/* pi-tidy-bots fleet console — no-build vanilla JS (rho stack pattern). */
"use strict";

const hashParams = new URLSearchParams(location.hash.slice(1));
const state = {
  // Pairing URLs carry the token in the hash fragment (never sent to server);
  // browser links keep using ?token=.
  token:
    hashParams.get("token") ??
    new URLSearchParams(location.search).get("token") ??
    "",
  bootId: localStorage.getItem("fleet-boot") ?? "",
  lastSeq: Number(localStorage.getItem("fleet-seq") ?? "0"),
  toolOutput: "reasons",
  fleet: [],
  selected: null,
  transcripts: new Map(),
  bubbles: new Map(), // bot -> {turnId, element}
  socket: null,
};

const $id = (id) => document.getElementById(id);
const uid = () =>
  globalThis.crypto && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const setText = (id, text) => {
  const node = $id(id);
  if (node) node.textContent = text;
};

const blobColors = [
  "#2dd4bf",
  "#fb7185",
  "#f59e0b",
  "#e8ecf3",
  "#a78bfa",
  "#34d399",
  "#60a5fa",
  "#f472b6",
];
const colorFor = (name) => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return blobColors[hash % blobColors.length];
};

const api = (path, options = {}) => {
  const joiner = path.includes("?") ? "&" : "?";
  const auth = state.token
    ? `${joiner}token=${encodeURIComponent(state.token)}`
    : "";
  return fetch(`${path}${auth}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  }).then(async (response) => {
    if (response.status === 401) throw new Error("unauthorized");
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json().catch(() => ({}));
  });
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function blobAvatar(name, large) {
  const blob = el("div", `blob${large ? " large" : ""}`);
  blob.style.setProperty("--blob", colorFor(name));
  // Identity = blob color + initial. A manifest avatar (legacy) renders its
  // text instead; emoji defaults are gone (ADR 0001).
  const bot = state.fleet.find((candidate) => candidate.name === name);
  const text =
    bot?.avatar && bot.avatar.trim().length > 0
      ? bot.avatar
      : name.charAt(0).toUpperCase();
  blob.textContent = text;
  return blob;
}

function renderRoster() {
  const list = document.getElementById("bot-list");
  list.textContent = "";
  const strip = document.getElementById("presence-strip");
  // Child death drops the turn and its queue — clear any live bubble records
  // for offline bots so a respawn never shows a zombie "working…".
  for (const bot of state.fleet) {
    if (bot.online) continue;
    for (const [key, record] of state.bubbles) {
      if (key.startsWith(`${bot.name}:`)) {
        record.wrap.remove();
        state.bubbles.delete(key);
      }
    }
  }
  for (const bot of state.fleet) {
    const row = el("li");
    if (bot.name === state.selected) {
      row.classList.add("selected");
      row.setAttribute("aria-current", "true");
    }
    const open = el("button", "bot-row-btn");
    open.style.cssText =
      "all:unset;cursor:pointer;display:flex;gap:10px;align-items:center;width:100%;";
    row.appendChild(open);
    const line = el("div", "bot-line");
    const nameRow = el("div", "bot-row-name");
    nameRow.appendChild(el("span", null, bot.name));
    nameRow.appendChild(el("span", bot.online ? "online-dot" : "offline-dot"));
    line.appendChild(nameRow);
    line.appendChild(
      el(
        "div",
        "bot-preview",
        bot.latest ? bot.latest.slice(0, 60) : (bot.title ?? "")
      )
    );
    open.appendChild(line);
    open.appendChild(
      el(
        "div",
        "bot-ts",
        bot.active
          ? "now"
          : new Date(bot.lastActive).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })
      )
    );
    if (bot.queued > 0) {
      const badge = el("span", "queue-badge", String(bot.queued));
      badge.setAttribute("aria-label", `${bot.queued} messages queued`);
      open.appendChild(badge);
    }
    open.setAttribute("aria-label", `Open ${bot.name}`);
    open.addEventListener("click", () => selectBot(bot.name));
    row.appendChild(open);
    list.appendChild(row);
  }
  const active = state.fleet.filter((bot) => bot.online && bot.active).length;
  const idle = state.fleet.length - active;
  strip.textContent = "";
  strip.appendChild(el("span", "online-dot", ""));
  strip.appendChild(
    document.createTextNode(` ${active} active · ${idle} idle`)
  );
  document.getElementById("bot-count").textContent = String(state.fleet.length);
  updateHeaderQueue();
  updateComposerTargetDot();
}

function transcriptEl(entry) {
  if (entry.ui) return uiRequestEl(entry);
  // Issue 58: structured handoff kinds — no routing pills, no expand state.
  if (entry.kind === "handoff-receipt") {
    const wrap = el("div", "entry microline");
    wrap.appendChild(el("span", null, entry.text));
    return wrap;
  }
  if (entry.kind === "completion") {
    const wrap = el("div", "entry completion");
    wrap.appendChild(
      el(
        "div",
        "completion-divider",
        `Message from ${entry.originFrom ?? "bot"}`
      )
    );
    const bubble = el("div", "bubble");
    bubble.appendChild(
      el("div", "source", `from ${entry.originFrom ?? "bot"}`)
    );
    const body = el("span", "md-body");
    body.innerHTML = PiMd.render(entry.text);
    bubble.appendChild(body);
    wrap.appendChild(bubble);
    return wrap;
  }
  const wrap = el("div", `entry ${entry.role}`);
  if (entry.id) wrap.dataset.entryId = entry.id;
  const bubble = el("div", "bubble");
  // Bot-origin user messages (handoff briefs, receipts) are attributed.
  if (entry.role === "user" && entry.origin === "bot" && entry.originFrom) {
    bubble.appendChild(el("div", "source", `from ${entry.originFrom}`));
  }
  // Markdown boundary: md.js escapes before rendering, so innerHTML here cannot
  // execute model-supplied HTML. Source lines stay plain text.
  if (entry.parts) {
    // Issue 37: settled turns carry ordered parts — render in order with
    // collapsed tool groups (one-line badges, click to expand).
    for (const group of Parts.groupConsecutiveTools(entry.parts)) {
      if (group.type === "text") {
        const body = el("span", "md-body");
        body.innerHTML = PiMd.render(visibleStreamText(group.text));
        bubble.appendChild(body);
      } else {
        bubble.appendChild(renderPartGroup(group, false));
      }
    }
  } else if (entry.role === "assistant" || entry.role === "user") {
    const body = el("span", "md-body");
    body.innerHTML = PiMd.render(entry.text);
    bubble.appendChild(body);
  } else {
    bubble.appendChild(el("span", null, entry.text));
  }
  wrap.appendChild(bubble);
  const meta = el(
    "div",
    "meta left",
    new Date(entry.ts).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })
  );
  wrap.appendChild(meta);
  // Delivery state (issue 33): pending until the prompt lands; failures are
  // visible with their reason — never a silent drop.
  if (entry.role === "user") {
    if (entry.deliveryError)
      wrap
        .querySelector(".bubble")
        .appendChild(
          el("div", "delivery-note failed", `failed — ${entry.deliveryError}`)
        );
    else if (entry.delivering)
      wrap
        .querySelector(".bubble")
        .appendChild(el("div", "delivery-note", "queued…"));
  }
  return wrap;
}

function resolvedUiFor(entry, botName) {
  const entries = state.transcripts.get(botName) ?? [];
  const hit = entries.find(
    (candidate) =>
      candidate.uiResolved && candidate.uiResolved.id === entry.ui.id
  );
  return hit ? hit.uiResolved : null;
}

function uiRequestEl(entry) {
  const ui = entry.ui;
  const resolved = resolvedUiFor(entry, entry.bot);
  const wrap = el("div", "entry system");
  const card = el("div", resolved ? "ui-card resolved" : "ui-card");
  card.id = `ui-${ui.id}`;
  card.appendChild(el("div", "source", ui.title));
  if (ui.message) card.appendChild(el("div", "ui-message", ui.message));
  if (resolved) {
    card.appendChild(
      el(
        "div",
        "ui-answer",
        `Answered: ${resolved.value}${resolved.auto ? " (auto)" : ""}`
      )
    );
  } else {
    const actions = el("div", "ui-actions");
    if (ui.method === "select" && ui.options?.length) {
      ui.options.forEach((option) => {
        const button = el("button", "primary", option);
        button.addEventListener("click", () =>
          answerUiCard(entry.bot, ui.id, { value: option }, actions)
        );
        actions.appendChild(button);
      });
    } else if (ui.method === "confirm") {
      const yes = el("button", "primary", "Confirm");
      yes.addEventListener("click", () =>
        answerUiCard(entry.bot, ui.id, { confirmed: true }, actions)
      );
      const no = el("button", null, "Decline");
      no.addEventListener("click", () =>
        answerUiCard(entry.bot, ui.id, { confirmed: false }, actions)
      );
      actions.appendChild(yes);
      actions.appendChild(no);
    } else if (ui.method === "input") {
      const input = el("input", "ui-input");
      input.placeholder = ui.placeholder || "Type an answer";
      const send = el("button", "primary", "Send");
      const submit = () => {
        const value = input.value.trim();
        if (value) answerUiCard(entry.bot, ui.id, { value }, actions);
      };
      send.addEventListener("click", submit);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
      actions.appendChild(input);
      actions.appendChild(send);
    } else {
      card.appendChild(
        el(
          "div",
          "ui-message",
          "Editor questions aren't supported in the console yet."
        )
      );
      const cancel = el("button", null, "Cancel");
      cancel.addEventListener("click", () =>
        answerUiCard(entry.bot, ui.id, { cancel: true }, actions)
      );
      actions.appendChild(cancel);
    }
    card.appendChild(actions);
  }
  wrap.appendChild(card);
  wrap.appendChild(
    el(
      "div",
      "meta left",
      new Date(entry.ts).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    )
  );
  return wrap;
}

async function answerUiCard(bot, uiId, body, actions) {
  [...actions.querySelectorAll("button, input")].forEach(
    (node) => (node.disabled = true)
  );
  const result = await api(`/api/bots/${bot}/ui/${uiId}`, {
    method: "POST",
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!result || result.accepted !== true) {
    const reason =
      (result && (result.error || result.reason)) || "not delivered";
    appendEntry(bot, {
      id: uid(),
      role: "system",
      text: `Answer refused — ${reason}.`,
      ts: new Date().toISOString(),
    });
    [...actions.querySelectorAll("button, input")].forEach(
      (node) => (node.disabled = false)
    );
  }
}
function renderTranscript(botName) {
  const pane = document.getElementById("transcript");
  pane.textContent = "";
  const entries = state.transcripts.get(botName) ?? [];
  if (entries.length === 0) {
    pane.appendChild(emptyStateNode(botName));
    return;
  }
  for (const entry of entries) {
    const node = transcriptEl({ ...entry, bot: botName });
    if (node) pane.appendChild(node);
  }
  reattachLiveBubbles(botName);
  pane.scrollTop = pane.scrollHeight;
}

// Intentional empty state for a never-used bot: presence-neutral copy (the dot
// already says online/offline), breathing blob reads "alive, waiting".
function emptyStateNode(botName) {
  const wrap = el("div", "empty-state");
  const avatar = blobAvatar(botName, true);
  avatar.setAttribute("aria-hidden", "true");
  avatar.classList.add("breathe");
  wrap.appendChild(avatar);
  wrap.appendChild(el("div", "empty-title", "Awaiting first task"));
  wrap.appendChild(
    el(
      "div",
      "empty-sub",
      "Send or route a message and the transcript will start here."
    )
  );
  return wrap;
}

// Mid-turn visibility: bubble records are kept per bot regardless of selection
// (bubbleWorking no longer bails), so re-attach any live working bubble when
// the pane is (re)rendered — e.g. switching to a bot mid-turn.
function reattachLiveBubbles(botName) {
  const pane = document.getElementById("transcript");
  for (const [key, record] of state.bubbles) {
    if (key.startsWith(`${botName}:`)) pane.appendChild(record.wrap);
  }
}

function updateHeaderQueue() {
  const pill = $id("header-queue");
  if (!pill) return;
  const bot = state.fleet.find(
    (candidate) => candidate.name === state.selected
  );
  const queued = bot?.queued ?? 0;
  pill.hidden = !queued;
  pill.textContent = "";
  if (queued > 0) {
    pill.appendChild(el("span", null, "queued · "));
    pill.appendChild(el("span", "queue-count", String(queued)));
  }
}

function scrollBottom() {
  const pane = document.getElementById("transcript");
  pane.scrollTop = pane.scrollHeight;
}

// Stick-to-bottom (issue 21): streaming events only autoscroll while the
// operator is pinned to the bottom (within 48px). Scrolling up unpins until
// they return; deliberate context switches (selectBot, renderTranscript,
// visualViewport fit, composer focus) scroll unconditionally and re-pin.
let transcriptPinned = true;
document.getElementById("transcript").addEventListener("scroll", () => {
  const pane = document.getElementById("transcript");
  transcriptPinned =
    pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;
});

function scrollBottomIfPinned() {
  if (transcriptPinned) scrollBottom();
}

function appendEntry(botName, entry) {
  const entries = state.transcripts.get(botName) ?? [];
  const existingIndex = entry.id
    ? entries.findIndex((candidate) => candidate.id === entry.id)
    : -1;
  if (existingIndex !== -1) {
    // Same id: delivery-state update (pending -> delivered/failed), not a dup.
    entries[existingIndex] = { ...entries[existingIndex], ...entry };
    state.transcripts.set(botName, entries);
    if (botName === state.selected) {
      const pane = document.getElementById("transcript");
      const node = transcriptEl({
        ...entries[existingIndex],
        bot: botName,
      });
      const stale = pane.querySelector(
        `[data-entry-id="${CSS.escape(entry.id)}"]`
      );
      if (stale) stale.replaceWith(node);
    }
    const bot = state.fleet.find((candidate) => candidate.name === botName);
    if (bot) bot.latest = entry.text;
    renderRoster();
    return;
  }
  entries.push(entry);
  state.transcripts.set(botName, entries);
  if (botName === state.selected) {
    const pane = document.getElementById("transcript");
    pane.querySelector(".empty-state")?.remove();
    if (entry.uiResolved) {
      // Re-render the originating question card in its resolved state.
      const request = entries.find(
        (candidate) => candidate.ui && candidate.ui.id === entry.uiResolved.id
      );
      const existing = document.getElementById(`ui-${entry.uiResolved.id}`);
      if (request && existing)
        existing.replaceWith(transcriptEl({ ...request, bot: botName }));
    } else {
      const node = transcriptEl({ ...entry, bot: botName });
      if (node) pane.appendChild(node);
    }
    scrollBottomIfPinned();
  }
  const bot = state.fleet.find((candidate) => candidate.name === botName);
  if (bot) bot.latest = entry.text;
  renderRoster();
}

function renderSteps(steps) {
  if (state.toolOutput === "off") return null;
  if (state.toolOutput === "counts") {
    // Disclosure tier between off and reasons: badge only, no args, no output.
    const ok = steps.filter((s) => !s.error).length;
    const err = steps.length - ok;
    const bits = [`${steps.length} ${steps.length === 1 ? "tool" : "tools"}`];
    if (ok > 0) bits.push(`${ok} ok`);
    if (err > 0) bits.push(`${err} err`);
    return el("div", "step-counts", bits.join(" · "));
  }
  const list = el("div", "steps");
  for (const step of steps) {
    const row = el("div", "step");
    const check = el("span", "step-check", "✓");
    row.appendChild(check);
    // Issue 49: reason is primary; the digest label accompanies it as a
    // secondary muted span — never one replacing the other. The raw args
    // payload never reaches the step row.
    row.appendChild(
      el(
        "span",
        "step-name",
        step.reason ? `${step.name} — ${step.reason}` : step.name
      )
    );
    if (step.label)
      row.appendChild(el("span", "step-label", `· ${step.label}`));
    if (step.duration !== undefined)
      row.appendChild(el("span", "step-dur", `${step.duration} ms`));
    if (state.toolOutput === "full" && step.output) {
      const out = el("pre", "step-output", step.output.slice(0, 1200));
      row.appendChild(out);
    }
    if (step.error) row.appendChild(el("div", "step-error", "✕ failed"));
    list.appendChild(row);
  }
  return list;
}

function bubbleWorking(botName, turnId, steps = []) {
  const pane = document.getElementById("transcript");
  const wrap = el("div", "entry assistant");
  wrap.dataset.turnId = turnId;
  const bubble = el("div", "bubble");
  const working = el("div", "working");
  working.appendChild(el("div", "spinner"));
  working.appendChild(el("span", null, "working…"));
  bubble.appendChild(working);
  if (steps.length > 0) bubble.appendChild(renderSteps(steps));
  wrap.appendChild(bubble);
  state.bubbles.set(`${botName}:${turnId}`, { wrap, bubble });
  // Record always; render only when selected. Keeps live turns visible when
  // the operator switches to a bot mid-turn.
  if (botName === state.selected) {
    pane.appendChild(wrap);
    scrollBottomIfPinned();
  }
}

function visibleStreamText(text) {
  // v1 limitation: marker stripping is line-based and can strip inside fenced
  // code blocks — matches daemon-side stripActionMarkers line semantics.
  return text
    .split("\n")
    .filter((line) => !/^\s*\[\[\s*action\s*:/i.test(line))
    .join("\n")
    .trimEnd();
}

function bubbleFinal(botName, turnId) {
  const record = state.bubbles.get(`${botName}:${turnId}`);
  if (!record) return;
  state.bubbles.delete(`${botName}:${turnId}`);
  record.wrap.remove();
  if (botName === state.selected) scrollBottomIfPinned();
}

// ── Ordered turn parts (issue 37, t3code model) ──────
// A bubble's content is an ordered part list; consecutive tools collapse
// under a count-badge block (one line per doctrine), text streams via PiMd.

function partGroupSummary(tools) {
  return Parts.summarizeToolGroup(tools);
}

function renderPartGroup(group, expanded) {
  const block = el("div", "toolgroup");
  const badge = el(
    "button",
    "toolgroup-badge",
    `▸ ${partGroupSummary(group.tools)}`
  );
  badge.setAttribute("aria-expanded", String(expanded));
  block.appendChild(badge);
  const list = el("div", "toolgroup-parts");
  list.hidden = !expanded;
  for (const tool of group.tools) {
    const row = el("div", "step");
    row.appendChild(
      el("span", "step-check", tool.status === "error" ? "✕" : "✓")
    );
    row.appendChild(
      el(
        "span",
        "step-name",
        tool.reason ? `${tool.tool} — ${tool.reason}` : tool.tool
      )
    );
    if (tool.label)
      row.appendChild(el("span", "step-label", `· ${tool.label}`));
    if (tool.duration !== undefined)
      row.appendChild(el("span", "step-dur", `${tool.duration} ms`));
    if (state.toolOutput === "full" && tool.output) {
      row.appendChild(el("pre", "step-output", tool.output.slice(0, 1200)));
    }
    if (tool.status === "error")
      row.appendChild(el("div", "step-error", "✕ failed"));
    list.appendChild(row);
  }
  block.appendChild(list);
  badge.addEventListener("click", () => {
    const on = !list.hidden;
    list.hidden = !on;
    badge.setAttribute("aria-expanded", String(on));
    badge.textContent = `${on ? "▾" : "▸"} ${partGroupSummary(group.tools)}`;
  });
  return block;
}

function bubbleParts(botName, turnId, parts) {
  const record = state.bubbles.get(`${botName}:${turnId}`);
  if (!record) return;
  const working = record.bubble.querySelector(".working");
  if (working) working.remove();
  let zone = record.bubble.querySelector(".parts-zone");
  if (!zone) {
    zone = el("div", "parts-zone");
    record.bubble.appendChild(zone);
  }
  zone.textContent = "";
  for (const group of Parts.groupConsecutiveTools(parts)) {
    if (group.type === "text") {
      const body = el("div", "md-body");
      body.innerHTML = PiMd.render(visibleStreamText(group.text));
      zone.appendChild(body);
    } else {
      const expanded = group.tools.some((t) => t.status === "running");
      zone.appendChild(renderPartGroup(group, expanded));
    }
  }
  if (botName === state.selected) scrollBottomIfPinned();
}

function selectBot(name) {
  state.selected = name;
  document.getElementById("header-name").textContent = name;
  const bot = state.fleet.find((candidate) => candidate.name === name);
  document.getElementById("header-title").textContent = bot?.title ?? "";
  setText("header-name", name);
  setText("header-title", bot?.title ?? "");
  const blobHost = $id("header-avatar-blob");
  if (blobHost) {
    const fresh = blobAvatar(name, false);
    fresh.id = "header-avatar-blob";
    blobHost.replaceWith(fresh);
  }
  setText("composer-target-name", name);
  updateComposerTargetDot();
  const presence = $id("header-presence");
  if (presence) presence.hidden = !(bot?.online && bot?.active);
  document.body.classList.remove("drawer-open");
  const input = $id("composer-input");
  if (input) {
    input.placeholder = `Message ${name}`;
    input.setAttribute("aria-label", `Message ${name}`);
  }
  if (!state.transcripts.has(name)) {
    api(`/api/bots/${name}/transcript`)
      .then((data) => {
        state.transcripts.set(name, data.transcript ?? []);
        renderTranscript(name);
      })
      .catch(() => state.transcripts.set(name, []));
  }
  renderTranscript(name);
  updateHeaderQueue();
  renderRoster();
}

function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(
    `${proto}://${location.host}/api/ws${state.token ? `?token=${encodeURIComponent(state.token)}` : ""}`
  );
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (typeof message.seq === "number") {
      state.lastSeq = Math.max(state.lastSeq, message.seq);
      localStorage.setItem("fleet-seq", String(state.lastSeq));
    }
    switch (message.type) {
      case "config-error":
        console.warn(`[fleet] ${message.error}`);
        break;
      case "config":
        state.toolOutput = message.toolOutput ?? state.toolOutput;
        renderTranscript(state.selected);
        break;
      case "hello":
        if (message.bootId && message.bootId !== state.bootId) {
          state.bootId = message.bootId;
          localStorage.setItem("fleet-boot", message.bootId);
          state.lastSeq = message.seq ?? 0;
          localStorage.setItem("fleet-seq", String(state.lastSeq));
          state.transcripts.clear();
          if (state.selected) {
            api(`/api/bots/${state.selected}/transcript`)
              .then((data) => {
                state.transcripts.set(state.selected, data.transcript ?? []);
                renderTranscript(state.selected);
              })
              .catch(() => {});
          }
        }
        break;
      case "roster": {
        const reconnecting = state.socket && state.socket.retried;
        state.fleet = message.bots;
        if (!state.selected && state.fleet.length > 0)
          selectBot(state.fleet[0].name);
        if (reconnecting && state.selected) {
          state.transcripts.delete(state.selected);
          api(`/api/bots/${state.selected}/transcript`)
            .then((data) => {
              state.transcripts.set(state.selected, data.transcript ?? []);
              renderTranscript(state.selected);
            })
            .catch(() => {});
        }
        renderRoster();
        break;
      }
      case "append":
        appendEntry(message.bot, message.entry);
        break;
      case "bubble":
        if (message.phase === "working")
          bubbleWorking(message.bot, message.turnId, message.steps ?? []);
        if (message.phase === "parts")
          bubbleParts(message.bot, message.turnId, message.parts ?? []);
        // Issue 48: the compat `delta` phase is intentionally ignored —
        // streaming text renders ONLY through the parts model. Issue 49: the
        // legacy flat `steps` checklist is retired for the same reason —
        // tool steps render ONLY as parts-model tool-blocks.
        if (message.phase === "final") bubbleFinal(message.bot, message.turnId);
        break;
      default:
        break;
    }
  });
  socket.addEventListener("open", () => {
    document.getElementById("conn-banner").hidden = true;
    // Reconnect recovery: authoritative transcript for the selected bot.
    if (state.socket && state.socket.retried && state.selected) {
      state.transcripts.delete(state.selected);
      api(`/api/bots/${state.selected}/transcript`)
        .then((data) => {
          state.transcripts.set(state.selected, data.transcript ?? []);
          renderTranscript(state.selected);
        })
        .catch(() => {});
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket) state.socket.retried = true;
    document.getElementById("conn-banner").hidden = false;
    setTimeout(connectSocket, 1500);
  });
  state.socket = socket;
}

const settingsPanel = $id("settings-panel");
const settingsButton = $id("settings-btn");
const routinesPanelNode = $id("routines-panel");
const routinesButton = $id("routines-btn");
if (settingsButton && settingsPanel) {
  settingsButton.addEventListener("click", async () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    if (routinesPanelNode) routinesPanelNode.hidden = true;
    if (settingsPanel.hidden) return;
    settingsPanel.textContent = "";
    settingsPanel.appendChild(el("div", "settings-title", "Tool output"));
    for (const mode of ["off", "counts", "reasons", "full"]) {
      const option = el(
        "button",
        state.toolOutput === mode ? "primary" : "",
        mode
      );
      option.addEventListener("click", async () => {
        const res = await api("/api/settings", {
          method: "POST",
          body: JSON.stringify({ toolOutput: mode }),
        }).catch(() => null);
        if (res?.toolOutput) {
          state.toolOutput = res.toolOutput;
          renderTranscript(state.selected);
          [...settingsPanel.querySelectorAll("button")].forEach(
            (button) =>
              (button.className = button.textContent === mode ? "primary" : "")
          );
        }
      });
      settingsPanel.appendChild(option);
    }
  });
}
if (routinesPanelNode && routinesButton) {
  routinesButton.addEventListener("click", async () => {
    routinesPanelNode.hidden = !routinesPanelNode.hidden;
    if (settingsPanel) settingsPanel.hidden = true;
    if (routinesPanelNode.hidden) return;
    const data = await api("/api/routines").catch(() => ({ routines: [] }));
    routinesPanelNode.textContent = "";
    for (const routine of data.routines ?? []) {
      const row = el("div", "routine-row");
      row.appendChild(blobAvatar(routine.bot));
      row.appendChild(el("span", "routine-schedule", routine.schedule));
      row.appendChild(
        el("span", "routine-name", `${routine.bot} · ${routine.name}`)
      );
      const toggle = el(
        "button",
        routine.enabled ? "primary" : "",
        routine.enabled ? "on" : "off"
      );
      toggle.addEventListener("click", async () => {
        const res = await api(
          `/api/bots/${routine.bot}/routines/${routine.name}/toggle`,
          { method: "POST" }
        ).catch(() => null);
        if (res) {
          routine.enabled = res.enabled;
          toggle.textContent = routine.enabled ? "on" : "off";
          toggle.className = routine.enabled ? "primary" : "";
        }
      });
      row.appendChild(toggle);
      const run = el("button", "primary", "run");
      run.addEventListener("click", async () => {
        await api(`/api/bots/${routine.bot}/routines/${routine.name}/run`, {
          method: "POST",
        }).catch(() => {});
        routinesPanelNode.hidden = true;
        selectBot(routine.bot);
      });
      row.appendChild(run);
      routinesPanelNode.appendChild(row);
    }
  });
}

async function boot() {
  try {
    const settings = await api("/api/settings").catch(() => ({}));
    state.toolOutput = settings.toolOutput ?? state.toolOutput;
    const fleet = await api("/api/fleet");
    state.fleet = fleet.bots ?? [];
    if (state.fleet.length > 0) {
      const first = state.fleet[0].name;
      selectBot(first);
      const data = await api(`/api/bots/${first}/transcript`).catch(() => ({
        transcript: [],
      }));
      state.transcripts.set(first, data.transcript ?? []);
      renderTranscript(first);
    }
  } finally {
    renderRoster();
    connectSocket();
  }
}

const composerInput = document.getElementById("composer-input");

function autoGrow() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 160)}px`;
}
composerInput.addEventListener("input", autoGrow);

// Chat idiom: Enter sends, Shift+Enter inserts a newline (paste logs / compose multi-line).
composerInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.getElementById("composer").requestSubmit();
  }
});

document.getElementById("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = composerInput.value.trim();
  if (!state.selected) return;
  if (text === "/new") {
    // Magic string rerouted to the typed compaction endpoint.
    composerInput.value = "";
    autoGrow();
    api(`/api/bots/${state.selected}/compact`, {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => {});
    return;
  }
  if (!text) return;
  composerInput.value = "";
  autoGrow();
  scrollBottom();
  const images = pendingImage ? [pendingImage] : undefined;
  clearPendingImage();
  api(`/api/bots/${state.selected}/message`, {
    method: "POST",
    body: JSON.stringify({ text, ...(images ? { images } : {}) }),
  }).catch(() => {});
});

// ── Composer target pill + image attach ──────────────
function updateComposerTargetDot() {
  const dot = document.getElementById("composer-target-dot");
  const bot = state.fleet.find(
    (candidate) => candidate.name === state.selected
  );
  if (!dot) return;
  dot.className = bot?.online ? "online-dot" : "offline-dot";
}

document.getElementById("composer-target").addEventListener("click", () => {
  // Opens the existing roster drawer, which doubles as the bot picker.
  document.body.classList.toggle("drawer-open");
});

let pendingImage = null; // { mediaType, data } — base64, no dataURL prefix
let pendingImageUrl = null; // object URL for the confirmation chip thumb

function clearPendingImage() {
  if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
  pendingImageUrl = null;
  pendingImage = null;
  resetAttachmentInput();
  document.getElementById("composer-attach")?.classList.remove("has-image");
  document.getElementById("composer-attachment")?.remove();
}

// Safari bfcache restores form state on back/forward navigation — reset the
// attachment input + chip when the page is re-shown from the cache.
addEventListener("pageshow", (event) => {
  resetAttachmentInput();
  if (event.persisted) clearPendingImage();
});
resetAttachmentInput();

// Issue 45: visible confirmation — 40px thumb, name, size, ✕ to remove.
// The thumb <img> only ever gets a src with a pending file (an empty-src img
// renders as a broken box on iOS).
function updateAttachmentChip(file) {
  if (!file) {
    clearPendingImage();
    return;
  }
  const composer = document.getElementById("composer");
  let chip = document.getElementById("composer-attachment");
  if (!chip) {
    // Removed on the previous clear: rebuild the chip node in place.
    chip = el("div", "composer-attachment");
    chip.id = "composer-attachment";
    chip.hidden = true;
    const thumb = el("img", "composer-attach-thumb");
    chip.appendChild(thumb);
    const meta = el("div", "composer-attach-meta");
    meta.appendChild(el("span", "composer-attach-name"));
    meta.appendChild(el("span", "composer-attach-size"));
    chip.appendChild(meta);
    const remove = el("button", "composer-attach-remove", "✕");
    remove.type = "button";
    chip.appendChild(remove);
    bindAttachmentChip(chip);
    const bottom = composer.querySelector(".composer-bottom");
    composer.insertBefore(chip, bottom);
  }
  if (pendingImageUrl) URL.revokeObjectURL(pendingImageUrl);
  pendingImageUrl = URL.createObjectURL(file);
  chip.querySelector(".composer-attach-thumb").src = pendingImageUrl;
  const name = chip.querySelector(".composer-attach-name");
  name.textContent = file.name;
  name.title = file.name;
  chip.querySelector(".composer-attach-size").textContent = `${Math.max(
    1,
    Math.round(file.size / 1024)
  )} KB`;
  chip.hidden = false;
  document.getElementById("composer-attach").classList.add("has-image");
}

function bindAttachmentChip(chip) {
  chip
    .querySelector(".composer-attach-remove")
    .addEventListener("click", () => clearPendingImage());
}

document.getElementById("composer-attach").addEventListener("click", () => {
  document.getElementById("composer-image").click();
});

document
  .getElementById("composer-image")
  .addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (!base64) {
        clearPendingImage();
        return;
      }
      pendingImage = { mediaType: file.type || "image/png", data: base64 };
      document.getElementById("composer-attach").classList.add("has-image");
      // Second pick replaces: revoke the old object URL, update the chip.
      updateAttachmentChip(file);
    };
    reader.readAsDataURL(file);
  });

// iOS keyboard: the layout viewport does not resize — the visual viewport does.
// Fit the app to the visual viewport and keep the transcript pinned to its newest entry.
if (window.visualViewport) {
  const vv = window.visualViewport;
  let lastFitHeight = 0;
  const fitViewport = () => {
    const height = Math.round(vv.height);
    if (Math.abs(height - lastFitHeight) > 1) {
      lastFitHeight = height;
      document.getElementById("app").style.height = `${height}px`;
      scrollBottom();
    }
  };
  vv.addEventListener("resize", fitViewport);
  fitViewport();
}
composerInput.addEventListener("focus", () => {
  setTimeout(() => {
    window.scrollTo(0, 0);
    scrollBottom();
  }, 300);
});

document.getElementById("header-avatar").addEventListener("click", () => {
  document.body.classList.toggle("drawer-open");
});

// Issue 39: the console answers "what am I working off" — footer shows the
// running package version + daemon commit (unknown/omitted when no .git).
async function loadConsoleFooter() {
  const footer = document.getElementById("console-footer");
  if (!footer) return;
  const data = await api("/api/version").catch(() => null);
  if (!data) return;
  const identity = data.fleetName
    ? `${data.fleetName} · `
    : data.fleetDir
      ? `${data.fleetDir} · `
      : "";
  const commit = data.commit ? ` · ${data.commit}` : "";
  footer.textContent = `fleet · ${identity}${data.version}${commit}`;
  if (data.fleetDir) footer.title = data.fleetDir;
  footer.hidden = false;
}
loadConsoleFooter();

// Mobile Safari freezes sockets/timers in background tabs — resync on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    if (state.socket) {
      try {
        state.socket.close();
      } catch {}
    }
    connectSocket();
  } else if (state.selected) {
    api(`/api/bots/${state.selected}/transcript`)
      .then((data) => {
        state.transcripts.set(state.selected, data.transcript ?? []);
        renderTranscript(state.selected);
      })
      .catch(() => {});
  }
});

boot();
