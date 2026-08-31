/**
 * Marker hygiene for [[action: ...]] lines. The action-pill feature is removed
 * (operator decision: redundant with bot behavior), but bot personas still emit
 * the markers — stripActionMarkers keeps them invisible in transcripts, deltas,
 * and stored entries.
 */

const ACTION_LINE = /^\s*\[\[\s*action\s*:\s*(.+?)\s*\]\]\s*$/;

export function stripActionMarkers(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!ACTION_LINE.test(line)) kept.push(line);
  }
  return kept.join("\n").trimEnd();
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
