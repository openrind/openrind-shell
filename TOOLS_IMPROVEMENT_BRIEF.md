Secondary PII Leak in Screen Capture (screen_observation):
The Bug: In demonstration-recorder.mjs, when recordInputEvent captures the snapshot before emitting human_action, it passes the unscrubbed raw text to captureSnapshot.
Impact: While human_action.text has [REDACTED_SECRET], the paired screen_observation.action.text still contains the raw cleartext password/token!
The Fix: Run scrubPiiText before calling captureSnapshot so both events are clean.

Window Title Keystroke Leak (Notepad / Editors):
The Bug: On Windows, when a user types in Notepad, Windows updates the window title to:
*<whatever text the user is typing> - Notepad
Impact: The text is scrubbed from the input field, but leaks in cleartext through activeWindow.title.
The Fix: Apply scrubPiiText to activeWindow.title whenever scrubPii is enabled.

The Bug: DELETE /projects/{project} in app.py deletes all trace files, SQLite/PostgreSQL spans, and reward rollouts with zero authentication.
Impact: Anyone who knows the server IP can send a simple curl request and wipe out a client’s entire captured dataset.
The Fix: Require an admin token (w8-catalog-simulation-admin or Authorization header) before allowing project deletion.
**use the same admin token that we use using curls to create harbor or run eval**

Hardcoded Public IP Fallback:
The Bug: In 5 places across openeral (main.mjs and demonstration-recorder.mjs), the fallback URL is hardcoded to http://136.112.93.84:8788.
Impact: If a user or client starts the app without setting an environment variable, their local desktop screens and actions stream over plain unencrypted HTTP to that public IP.
**in settings->environment add var like admin gateway url, so that if the client has deployed the architecture on different ip he can set his gateway url himself**

Hardcoded Token Fallback in BYOH (w8-haloop):
The Bug: In services/byoh/api.py, the authentication check accepts a hardcoded string ("w8-catalog-simulation-admin") even if the operator configured their own token in .env.
The Fix: Require the configured environment token only, so tokens can be rotated properly.
**add logic so that it takes from the env, also add scripts in deploy/k8s folder so that we can add it in cloud secrets, where many vars r saved currently** (so that when we share teh architecture to our client he can chnage his suth token any ttime.)

Replay Truncation Check Bug (w8-haloop):
The Bug: In run_evals.py, the replay loop strips finish_reason before calling run_checks. Because finish_reason is missing, check_not_truncated returns None and passes.
Impact: A candidate model that runs out of tokens and cuts off mid-sentence still passes the benchmark as “successful”.
The Fix: Pass finish_reason through to run_checks so truncated responses fail the gate.

Structural Comparison Against Known-Good Incumbent (w8-haloop):
The Bug: Right now, the gate only checks if the model called any valid tool name. If the task required open_file but the model called calculator, it still passes because calculator is a valid tool in the schema.
The Fix: Check the candidate’s tool call against the recorded incumbent_output (verifying tool name match and argument key overlap).

Explicit API Refusal Field Check (w8-haloop):
The Bug: Checks only look for 4 hardcoded English regex phrases (“I’m sorry, but I cannot…”).
The Fix: Check the native message.refusal and stop_reason: "refusal" fields directly from modern OpenAI/Anthropic responses.

CTF Provenance Attribution (openeral):
The Bug: In ctf-service.mjs, direct API calls to models are stamped relayed_by: "inference-gateway".
The Fix: Correctly stamp them as relayed_by: "direct-client" so the trace provenance is truthful.

Hygiene & Cleanup (w8-haloop):
Fix or delete halo-loop/data/traces/plugin_test.traces.jsonl (an outdated sample that fails the repo’s own validator).
Move pydantic-settings into the byoh extra in pyproject.toml.

Multi-Monitor Coordinate Mismatch (Out-of-Bounds Clicks):
The Flaw: When you clicked in Notepad, the mouse hook recorded coordinates like (4269, -120) (from a secondary monitor), but desktopCapturer hardcoded sources[0] (Monitor 1 at 1920x1080).
Why It Matters: Any AI model training on this dataset will see a click at coordinates outside the image frame, making the visual data unusable for VLA training.
The Fix: Detect which screen the cursor is on and capture that active monitor’s display, or normalize (x, y) to the active display bounds.

Stale Frame Buffers (Zero Delay on after frame):
The Flaw: In test-capture-10, only 4 unique JPEGs existed across 13 frames. When you clicked, captureSnapshot grabbed the GPU frame buffer instantaneously—before Windows finished repainting the Notepad window.
The Fix: Add a small 80–120ms settling delay before capturing the after frame so the visual result of the action (e.g. text appearing, button depressed) is actually in the screenshot.

Missing TOOL Spans for OpenHands and OpenClaw:
The Flaw: In opnhnds2 (112 spans) and opnclw2 (8 spans), the collector recorded 0 TOOL spans. Only raw LLM calls were captured.
Why It Matters: Downstream evaluators see the model talking, but zero recorded tool executions (bash commands, file writes, browser actions).
The Fix: In tool_spans.py, add support for OpenHands’s tool convention (terminal, file_editor) and OpenClaw’s tool calls so their tool executions are normalized into standard TOOL spans.

OpenHands Singleton Trace Fragmentation:
The Flaw: OpenHands split a single task into 112 disconnected trace IDs with session_id: null across 11 random free models.
The Fix: Propagate the parent session_id into OpenHands’s internal subagent requests so all 112 calls group into one cohesive session tree.

Tool Failures Masked as STATUS_CODE_OK:
The Flaw: In cdx2, when an agent-browser command failed with exit 1 or curl failed with exit 56, the span status in the trace was still recorded as STATUS_CODE_OK.
The Fix: Check the process exit code (code !== 0) and mark the span status as STATUS_CODE_ERROR so failures aren’t falsely recorded as successes.

Zero-Duration Spans (0 ms):
In cdx2 and opnhnds2, spans where halo.mark was missed had start_time == end_time (0ms latency). Stamping gateway arrival time prevents unrealistic 0ms measurements.

Tagging Auxiliary LLM Calls:
cdx2 recorded 9 extra spans where Codex generated session titles and recaps. Tagging them with model_call_purpose: "title" prevents internal agent housekeeping calls from polluting task traces.