/** Parse trailing [[action: ...]] markers out of assistant text (grokbot-simple action bar). */
/**
 * Two label forms keep display text free while capability ids stay stable:
 *   [[action: Fix it]]              → id "fix it"
 *   [[action: fix | Fix it]]        → id "fix", label "Fix it"
 * Scope allowlists in bots.toml match on id, never on display wording.
 */
export interface ActionRef {
  id: string;
  label: string;
}

export interface ParsedActions {
  text: string;
  actions: ActionRef[];
}

const ACTION_LINE = /^\s*\[\[\s*action\s*:\s*(.+?)\s*\]\]\s*$/;

export function parseAction(raw: string): ActionRef {
  const pipe = raw.indexOf("|");
  if (pipe === -1) return { id: raw.toLowerCase(), label: raw };
  return {
    id: raw.slice(0, pipe).trim().toLowerCase(),
    label: raw.slice(pipe + 1).trim(),
  };
}

export function parseActions(text: string): ParsedActions {
  const actions: ActionRef[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(ACTION_LINE);
    if (match) {
      actions.push(parseAction(match[1]));
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join("\n").trimEnd(), actions };
}

/** Build the follow-up prompt sent when the operator clicks an action button. */
export function actionPrompt(action: ActionRef): string {
  return `Operator triggered action "${action.label}" (action: ${action.id}).`;
}

export function attributionPrefix(fromName: string): string {
  return `Message from 🤖 ${fromName} (@${fromName}):`;
}

export function completionNotification(
  fromName: string,
  text: string,
  reason?: string
): string {
  const truncated = text.length > 1_600 ? `${text.slice(0, 1_600)}…` : text;
  const tag = reason && reason !== "none" ? `\n[reason: ${reason}]` : "";
  return `[completion from 🤖 ${fromName} (@${fromName})]\n${truncated}${tag}`;
}
