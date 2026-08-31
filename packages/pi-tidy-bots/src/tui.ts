import { createInterface } from "node:readline";
import WebSocket from "ws";

export interface ChatOptions {
  url: string;
  bot?: string;
  token?: string;
}

interface ActionRef {
  id: string;
  label: string;
}

/** Minimal TUI client: chat, actions, steer, bot switching — parity with the console core loop. */
export function startChat(options: ChatOptions): void {
  const base = options.url.replace(/\/$/, "");
  const authSuffix = options.token ? `?token=${options.token}` : "";
  const request = (path: string, body?: unknown) =>
    fetch(`${base}${path}${authSuffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (response) => {
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          reason?: string;
          error?: string;
        };
        throw new Error(data.reason ?? data.error ?? String(response.status));
      }
      return response.json().catch(() => ({}));
    });

  let selected: string | null = null;
  let pending: { from: string; number: number; action: ActionRef }[] = [];
  let counter = 0;

  const socket = new WebSocket(
    `${base.replace(/^http/, "ws")}/api/ws${authSuffix}`
  );
  socket.on("message", (raw) => {
    let event: any;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (event.type === "append" && event.entry?.role === "assistant") {
      console.log(`\n[${event.bot}] ${event.entry.text}`);
      const actions: ActionRef[] = event.entry.actions ?? [];
      if (actions.length > 0) {
        pending = actions.map((action) => ({
          from: event.bot,
          number: ++counter,
          action,
        }));
        console.log(
          `actions: ${pending.map((item) => `${item.number}) ${item.action.label}`).join("  ")}   (/a <n>)`
        );
      }
      process.stdout.write("you> ");
    } else if (event.type === "bubble" && event.phase === "working") {
      console.log(`[${event.bot}] …`);
    }
  });
  socket.on("error", () => {
    console.error(
      "could not reach the fleet daemon — is it running? (pi-tidy-bots start)"
    );
    process.exit(1);
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you> ",
  });

  rl.on("line", (line) => {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    if (text === "/quit" || text === "/q") {
      process.exit(0);
    }
    if (text === "/bots") {
      void request("/api/fleet")
        .then((fleet: any) => {
          for (const bot of fleet.bots ?? []) {
            console.log(
              `${bot.online ? "●" : "○"} ${bot.name} — ${bot.title ?? ""} (${bot.latest?.slice(0, 50) ?? ""})`
            );
          }
        })
        .catch((error) => console.log(`fleet unreachable: ${error.message}`))
        .finally(() => rl.prompt());
      return;
    }
    if (text.startsWith("/switch ")) {
      selected = text.slice(8).trim();
      console.log(`switched to ${selected}`);
      rl.prompt();
      return;
    }
    if (text.startsWith("/steer ")) {
      if (!selected) {
        console.log("no bot selected");
      } else {
        void request(`/api/bots/${selected}/steer`, {
          text: text.slice(7).trim(),
        })
          .then(() => console.log("steered."))
          .catch((error) => console.log(`steer failed: ${error.message}`))
          .finally(() => rl.prompt());
      }
      rl.prompt();
      return;
    }
    if (/^\/?a\s+\d+/.test(text) || /^\d+$/.test(text)) {
      const number = text.replace(/^\/?a\s+/, "").trim();
      const match = pending.find(
        (item) => String(item.number) === number && item.from === selected
      );
      if (!match) {
        console.log(`no pending action ${number}`);
        rl.prompt();
        return;
      }
      void request(`/api/bots/${match.from}/action`, {
        id: match.action.id,
        label: match.action.label,
      })
        .then(() => console.log(`→ ${match.action.label} sent`))
        .catch((error) => console.log(`action failed: ${error.message}`))
        .finally(() => rl.prompt());
      return;
    }
    if (!selected) {
      console.log("no bot selected — /switch <name> (or /bots)");
      rl.prompt();
      return;
    }
    void request(`/api/bots/${selected}/message`, { text })
      .then(() => rl.prompt())
      .catch((error) => {
        console.log(`send failed: ${error.message}`);
        rl.prompt();
      });
  });
  rl.prompt();
}
