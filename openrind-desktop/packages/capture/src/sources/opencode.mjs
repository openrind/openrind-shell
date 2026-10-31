// OpenCode History Importer (Section 8 - WP3)
import { normalizeConversationTurn } from "../conversation.mjs";
import { createRunIdentity } from "../identity.mjs";

export function parseOpenCodeMessages(messages = []) {
  const turns = [];
  let seq = 1;

  for (const msg of messages) {
    if (!msg) continue;
    turns.push(
      normalizeConversationTurn({
        role: msg.role || (msg.user ? "user" : "assistant"),
        content: msg.content || msg.text || "",
        timestamp: msg.createdAt || msg.timestamp || new Date().toISOString(),
        sequence: seq++,
        derived: false,
        provenance: "opencode_native",
        metadata: {
          session_id: msg.sessionId || msg.session_id,
        },
      }),
    );
  }
  return turns;
}

export function importOpenCodeSession({ sessionId = "opencode-session", messages = [] } = {}) {
  const turns = parseOpenCodeMessages(messages);
  const identity = createRunIdentity({
    taskId: "opencode",
    sessionId,
    nativeSessionId: sessionId,
  });

  return {
    source: "opencode",
    identity,
    turns,
    totalTurns: turns.length,
  };
}
