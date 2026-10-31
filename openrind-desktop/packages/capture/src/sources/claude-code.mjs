// Native Claude Code History Importer (Section 8 - WP3)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeConversationTurn } from "../conversation.mjs";
import { createRunIdentity } from "../identity.mjs";

export function parseClaudeCodeJsonl(content) {
  const lines = typeof content === "string" ? content.split("\n") : content.toString("utf8").split("\n");
  const turns = [];
  let seq = 1;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      // Claude Code transcript records: type "user", "assistant", "tool_use", "tool_result"
      const role = item.type === "human" || item.role === "user" ? "user" : (item.role || "assistant");
      const text = item.message?.content || item.content || item.text || "";
      turns.push(
        normalizeConversationTurn({
          role,
          content: typeof text === "string" ? text : JSON.stringify(text),
          timestamp: item.timestamp || item.created_at || new Date().toISOString(),
          sequence: seq++,
          derived: false,
          provenance: "native_claude_code",
          metadata: {
            session_id: item.sessionId || item.session_id,
            model: item.model,
          },
        }),
      );
    } catch {}
  }
  return turns;
}

export function importClaudeCodeSessionFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  const turns = parseClaudeCodeJsonl(content);
  const sessionId = turns[0]?.metadata?.session_id || "claude-session";
  const identity = createRunIdentity({
    taskId: "claude-code",
    sessionId,
    nativeSessionId: sessionId,
  });

  return {
    source: "claude-code",
    identity,
    turns,
    totalTurns: turns.length,
  };
}

export function discoverClaudeCodeSessions(claudeHomeDir) {
  const projectsDir = join(claudeHomeDir, ".claude", "projects");
  if (!existsSync(projectsDir)) return [];
  const found = [];
  try {
    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const fullPath = join(projectsDir, entry);
      if (entry.endsWith(".jsonl") && statSync(fullPath).isFile()) {
        found.push(fullPath);
      }
    }
  } catch {}
  return found;
}
