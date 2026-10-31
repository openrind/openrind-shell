// Gemini CLI History Importer (Section 8 - WP3)
import { existsSync, readFileSync } from "node:fs";
import { normalizeConversationTurn } from "../conversation.mjs";
import { createRunIdentity } from "../identity.mjs";

export function parseGeminiCliTranscript(content) {
  const turns = [];
  let seq = 1;
  try {
    const data = typeof content === "string" ? JSON.parse(content) : content;
    const history = Array.isArray(data) ? data : (data.history || data.messages || []);
    for (const item of history) {
      turns.push(
        normalizeConversationTurn({
          role: item.role === "model" ? "assistant" : (item.role || "user"),
          content: Array.isArray(item.parts) ? item.parts.map((p) => p.text || "").join("\n") : String(item.text || item.content || ""),
          timestamp: item.timestamp || new Date().toISOString(),
          sequence: seq++,
          derived: false,
          provenance: "gemini_cli",
        }),
      );
    }
  } catch {}
  return turns;
}

export function importGeminiCliSessionFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const turns = parseGeminiCliTranscript(content);
  const identity = createRunIdentity({
    taskId: "gemini-cli",
    sessionId: "gemini-session",
    nativeSessionId: "gemini-session",
  });

  return {
    source: "gemini-cli",
    identity,
    turns,
    totalTurns: turns.length,
  };
}
