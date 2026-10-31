// Native Codex CLI History Importer (Section 8 - WP3)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeConversationTurn } from "../conversation.mjs";
import { createRunIdentity } from "../identity.mjs";

export function parseCodexRolloutJsonl(content) {
  const lines = typeof content === "string" ? content.split("\n") : content.toString("utf8").split("\n");
  const turns = [];
  let seq = 1;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const payload = record.payload;
      if (!payload) continue;

      if (payload.type === "message" || record.type === "response_item") {
        const item = payload.type === "message" ? payload : payload.item;
        if (!item) continue;
        const role = item.role === "developer" ? "system" : (item.role || "user");
        let text = "";
        if (typeof item.content === "string") {
          text = item.content;
        } else if (Array.isArray(item.content)) {
          text = item.content.map((c) => c.text || c.input_text || c.output_text || "").join("\n");
        }

        turns.push(
          normalizeConversationTurn({
            role,
            content: text,
            timestamp: record.timestamp || new Date().toISOString(),
            sequence: seq++,
            derived: false,
            provenance: "native_codex",
            metadata: {
              turn_id: payload.internal_chat_message_metadata_passthrough?.turn_id || payload.turn_id,
            },
          }),
        );
      } else if (payload.type === "item_completed" && payload.item) {
        const item = payload.item;
        const role = item.type === "UserMessage" ? "user" : "assistant";
        const text = Array.isArray(item.content)
          ? item.content.map((c) => c.text || "").join("\n")
          : String(item.content ?? "");

        if (text) {
          turns.push(
            normalizeConversationTurn({
              role,
              content: text,
              timestamp: record.timestamp || new Date().toISOString(),
              sequence: seq++,
              derived: false,
              provenance: "native_codex",
              metadata: {
                turn_id: payload.turn_id,
                thread_id: payload.thread_id,
              },
            }),
          );
        }
      }
    } catch {}
  }
  return turns;
}

export function importCodexSessionFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const turns = parseCodexRolloutJsonl(content);
  const threadId = turns[0]?.metadata?.thread_id || "codex-thread";
  const identity = createRunIdentity({
    taskId: "codex-cli",
    sessionId: threadId,
    nativeSessionId: threadId,
  });

  return {
    source: "codex-cli",
    identity,
    turns,
    totalTurns: turns.length,
  };
}

export function discoverCodexSessions(codexHomeDir) {
  const sessionsDir = join(codexHomeDir, ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const found = [];

  function walk(dir) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".jsonl") && stat.isFile()) {
          found.push(full);
        }
      }
    } catch {}
  }

  walk(sessionsDir);
  return found;
}
