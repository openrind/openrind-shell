// Cursor Workspace History Importer (Section 8 - WP3)
import { existsSync } from "node:fs";
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
  }
  return turns;
}

export function importCursorState(filePath) {
  if (!existsSync(filePath)) return null;
  const identity = createRunIdentity({
    taskId: "cursor",
    sessionId: "cursor-session",
    nativeSessionId: "cursor-session",
  });

  return {
    source: "cursor",
    identity,
    turns: [],
    totalTurns: 0,
  };
}
