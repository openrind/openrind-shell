// Cursor Workspace History Importer (Section 8 - WP3)
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { normalizeConversationTurn } from "../conversation.mjs";
import { createRunIdentity } from "../identity.mjs";

export function parseCursorChatJson(jsonData) {
  const turns = [];
  let seq = 1;

  if (Array.isArray(jsonData)) {
    for (const item of jsonData) {
      if (!item) continue;
      const role = item.speaker === "human" || item.role === "user" ? "user" : "assistant";
      const text = item.text || item.content || "";
      turns.push(
        normalizeConversationTurn({
          role,
          content: typeof text === "string" ? text : JSON.stringify(text),
          timestamp: item.timestamp || new Date().toISOString(),
          sequence: seq++,
          derived: false,
          provenance: "cursor_vscdb",
        }),
      );
    }
  } else if (jsonData && typeof jsonData === "object") {
    const tabs = jsonData.tabs || jsonData.allComposers || [];
    for (const tab of tabs) {
      const bubbles = tab.bubbles || tab.messages || [];
      for (const b of bubbles) {
        const role = b.type === "user" || b.speaker === "human" ? "user" : "assistant";
        const text = b.rawText || b.text || b.content || "";
        if (text) {
          turns.push(
            normalizeConversationTurn({
              role,
              content: typeof text === "string" ? text : JSON.stringify(text),
              timestamp: b.createdAt || b.timestamp || new Date().toISOString(),
              sequence: seq++,
              derived: false,
              provenance: "cursor_vscdb",
            }),
          );
        }
      }
    }
  }
  return turns;
}

export function importCursorState(filePath) {
  if (!existsSync(filePath)) return null;
  const turns = [];
  try {
    const db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%chatdata%' OR key LIKE '%composer%'").all();
    for (const row of rows) {
      if (typeof row.value === "string") {
        try {
          const parsed = JSON.parse(row.value);
          const parsedTurns = parseCursorChatJson(parsed);
          turns.push(...parsedTurns);
        } catch {}
      }
    }
  } catch {}

  const identity = createRunIdentity({
    taskId: "cursor",
    sessionId: "cursor-session",
    nativeSessionId: "cursor-session",
  });

  return {
    source: "cursor",
    identity,
    turns,
    totalTurns: turns.length,
  };
}
