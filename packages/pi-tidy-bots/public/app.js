/* pi-tidy-bots fleet console — no-build vanilla JS (rho stack pattern). */
"use strict";

const state = {
  token: new URLSearchParams(location.search).get("token") ?? "",
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
const setText = (id, text) => {
  const node = $id(id);
  if (node) node.textContent = text;
};
const uid = () =>
  globalThis.crypto && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  return blob;
}

function renderRoster() {
  const list = document.getElementById("bot-list");
  list.textContent = "";
  const strip = document.getElementById("presence-strip");
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
}

function transcriptEl(entry) {
  if (entry.ui) return uiRequestEl(entry);
  if (entry.role === "user" && entry.source && entry.source.startsWith("🤖")) {
    const wrap = el("div", "entry routing");
    const pill = el("div", "routing-pill");
    pill.appendChild(el("span", null, "→"));
    pill.appendChild(el("span", "names", entry.source));
    pill.appendChild(el("span", null, entry.text));
    wrap.appendChild(pill);
    return wrap;
  }
  const wrap = el("div", `entry ${entry.role}`);
  const bubble = el("div", "bubble");
  if (entry.role === "user" && entry.source && entry.source !== "You") {
    bubble.appendChild(el("div", "source", entry.source));
  }
  if (
    entry.role === "assistant" &&
    entry.text.trim().length === 0 &&
    entry.actions?.length
  ) {
    bubble.appendChild(el("div", "source ghost-line", "Proposed actions:"));
  }
  bubble.appendChild(el("span", null, entry.text));
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
  // Pills live inside the bubble (below the text): .entry is a flex row, so a
  // bar appended to wrap would sit beside the bubble instead of under it.
  if (entry.role === "assistant" && entry.actions?.length) {
    const bar = el("div", "action-bar");
    entry.actions.forEach((action, index) => {
      const button = el("button", index === 0 ? "primary" : "", action.label);
      button.addEventListener("click", () =>
        runAction(entry.bot ?? state.selected, action, bar)
      );
      bar.appendChild(button);
    });
    bubble.appendChild(bar);
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
  card.appendChild(el("div", "source", `❓ ${ui.title}`));
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

async function runAction(bot, action, bar) {
  [...bar.querySelectorAll("button")].forEach(
    (button) => (button.disabled = true)
  );
  const result = await api(`/api/bots/${bot}/action`, {
    method: "POST",
    body: JSON.stringify({ id: action.id, label: action.label }),
  }).catch(() => null);
  if (!result || result.accepted !== true) {
    const reason = (result && result.reason) || "not delivered";
    appendEntry(bot, {
      id: uid(),
      role: "system",
      text: `Action "${action.label}" refused — ${reason}.`,
      ts: new Date().toISOString(),
    });
    setTimeout(
      () =>
        [...bar.querySelectorAll("button")].forEach(
          (button) => (button.disabled = false)
        ),
      1200
    );
  }
}

function renderTranscript(botName) {
  const pane = document.getElementById("transcript");
  pane.textContent = "";
  const entries = state.transcripts.get(botName) ?? [];
  for (const entry of entries) {
    const node = transcriptEl({ ...entry, bot: botName });
    if (node) pane.appendChild(node);
  }
  pane.scrollTop = pane.scrollHeight;
}

function scrollBottom() {
  const pane = document.getElementById("transcript");
  pane.scrollTop = pane.scrollHeight;
}
const pane_scrollBottom = scrollBottom;

function appendEntry(botName, entry) {
  const entries = state.transcripts.get(botName) ?? [];
  if (entry.id && entries.some((candidate) => candidate.id === entry.id))
    return; // render-dedupe
  entries.push(entry);
  state.transcripts.set(botName, entries);
  if (botName === state.selected) {
    const pane = document.getElementById("transcript");
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
    scrollBottom();
  }
  const bot = state.fleet.find((candidate) => candidate.name === botName);
  if (bot) bot.latest = entry.text;
  renderRoster();
}

function renderSteps(steps) {
  if (state.toolOutput === "off") return null;
  const list = el("div", "steps");
  for (const step of steps) {
    const row = el("div", "step");
    const check = el("span", "step-check", "✓");
    row.appendChild(check);
    row.appendChild(
      el(
        "span",
        "step-name",
        step.reason ? `${step.name} — ${step.reason}` : step.name
      )
    );
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
  if (botName !== state.selected) return;
  const wrap = el("div", "entry assistant");
  wrap.dataset.turnId = turnId;
  const bubble = el("div", "bubble");
  const working = el("div", "working");
  working.appendChild(el("div", "spinner"));
  working.appendChild(el("span", null, "working…"));
  bubble.appendChild(working);
  bubble.appendChild(el("div", "text-zone"));
  if (steps.length > 0) bubble.appendChild(renderSteps(steps));
  wrap.appendChild(blobAvatar(botName));
  wrap.appendChild(bubble);
  state.bubbles.set(`${botName}:${turnId}`, { wrap, bubble });
  pane.appendChild(wrap);
  pane.scrollTop = pane.scrollHeight;
}

function bubbleSteps(botName, turnId, steps) {
  const record = state.bubbles.get(`${botName}:${turnId}`);
  if (!record || botName !== state.selected) return;
  const existing = record.bubble.querySelector(".steps");
  if (existing) existing.replaceWith(renderSteps(steps));
  else record.bubble.appendChild(renderSteps(steps));
  pane_scrollBottom();
}

function visibleStreamText(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\[\[\s*action\s*:/i.test(line))
    .join("\n")
    .trimEnd();
}

function bubbleDelta(botName, turnId, text) {
  const record = state.bubbles.get(`${botName}:${turnId}`);
  if (!record || botName !== state.selected) return;
  const working = record.bubble.querySelector(".working");
  if (working) working.remove();
  let zone = record.bubble.querySelector(".text-zone");
  if (!zone) {
    zone = el("div", "text-zone");
    record.bubble.appendChild(zone);
  }
  zone.textContent = visibleStreamText(text);
  const pane = document.getElementById("transcript");
  pane.scrollTop = pane.scrollHeight;
}

function bubbleFinal(botName, turnId) {
  const record = state.bubbles.get(`${botName}:${turnId}`);
  if (!record) return;
  state.bubbles.delete(`${botName}:${turnId}`);
  record.wrap.remove();
  if (botName === state.selected) {
    const pane = document.getElementById("transcript");
    pane.scrollTop = pane.scrollHeight;
  }
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
  setText("composer-agent-name", name);
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
        if (message.phase === "steps")
          bubbleSteps(message.bot, message.turnId, message.steps ?? []);
        if (message.phase === "delta")
          bubbleDelta(message.bot, message.turnId, message.text);
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
    for (const mode of ["off", "reasons", "full"]) {
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
  if (!text || !state.selected) return;
  composerInput.value = "";
  autoGrow();
  scrollBottom();
  api(`/api/bots/${state.selected}/message`, {
    method: "POST",
    body: JSON.stringify({ text }),
  }).catch(() => {});
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
