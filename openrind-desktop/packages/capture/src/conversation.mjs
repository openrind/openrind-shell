// Typed conversation reconstruction and message normalization (Section 7.2)

export function normalizeConversationTurn({
  role,
  content,
  timestamp = new Date().toISOString(),
  sequence = 1,
  derived = false,
  provenance = "observed",
  metadata = {},
}) {
  return {
    role,
    content: typeof content === "string" ? content : JSON.stringify(content ?? ""),
    timestamp,
    sequence: Number(sequence),
    derived: Boolean(derived),
    provenance,
    ...metadata,
  };
}

export function reconstructConversationFromSource({
  observedMessages = [],
  steps = [],
  fallbackSystemPrompt = "",
  fallbackUserPrompt = "",
  startedAt = new Date().toISOString(),
}) {
  const turns = [];
  let seq = 1;

  if (Array.isArray(observedMessages) && observedMessages.length > 0) {
    for (const msg of observedMessages) {
      turns.push(
        normalizeConversationTurn({
          role: msg.role || "user",
          content: msg.content,
          timestamp: msg.timestamp || startedAt,
          sequence: seq++,
          derived: false,
          provenance: "observed_model_request",
        }),
      );
    }
    return { turns, source: "observed_model_request" };
  }

  // Fallback generation from task if no observed model request messages were found
  if (fallbackSystemPrompt) {
    turns.push(
      normalizeConversationTurn({
        role: "system",
        content: fallbackSystemPrompt,
        timestamp: startedAt,
        sequence: seq++,
        derived: true,
        provenance: "derived_from_task",
      }),
    );
  }

  if (fallbackUserPrompt) {
    turns.push(
      normalizeConversationTurn({
        role: "user",
        content: fallbackUserPrompt,
        timestamp: startedAt,
        sequence: seq++,
        derived: true,
        provenance: "derived_from_task",
      }),
    );
  }

  // Map trajectory steps into alternating assistant / user turns
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepTime = step.at || startedAt;

    // Assistant response
    turns.push(
      normalizeConversationTurn({
        role: "assistant",
        content: step.thought
          ? JSON.stringify({
              thought: step.thought,
              tool: step.tool || "browser",
              action: step.action,
            })
          : (typeof step.action === "string" ? step.action : JSON.stringify(step.action || {})),
        timestamp: stepTime,
        sequence: seq++,
        metadata: {
          step: step.number || i + 1,
          durationMs: step.durationMs,
        },
      }),
    );

    // Environment/User observation
    if (step.observation !== undefined && step.observation !== null) {
      turns.push(
        normalizeConversationTurn({
          role: "user",
          content: String(step.observation),
          timestamp: stepTime,
          sequence: seq++,
          metadata: {
            step: step.number || i + 1,
            ...(step.rawObservation && step.rawObservation !== step.observation ? { raw_observation_differs: true } : {}),
          },
        }),
      );
    }
  }

  return { turns, source: "derived_steps" };
}
