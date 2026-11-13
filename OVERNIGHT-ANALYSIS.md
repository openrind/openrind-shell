# PART 2 — Maturity Re-Assessment (2026-11-12)

**Status:** COMPLETE (second overnight-style run — 5 parallel subagents: 2 repo maturity audits, 1 competitive refresh, 1 eval/Harbor-task deep-dive, 1 UI/replay audit, plus live verification against the collector at `http://136.112.93.84:8788` and fresh CTF traces in `work1/tasks/ctf-traces`).
**Scope:** openeral @ `193b0102` (audit/kimi, incl. fix commit `3f541cd7`) and w8-haloop @ `359c7d0` (audit/fix, incl. `fb9e82f` + `359c7d0`). Results judged on evidence (code at HEAD, tests run, live traces fetched), not on claims.
**Verdict up front:** The capture core of both projects is genuinely near-maturity — several subsystems rate 4/5 with real evidence. The system as a whole is **not** "almost perfect": two confirmed PII leaks, one committed auth backdoor, one dead eval check, one unauthenticated delete-everything endpoint, no replay UI, and one fabricated provenance label. Sections 11–15 give the evidence; section 16 is the merged, ranked backlog.

## 11. openeral — maturity verdict

### Genuinely mature (verified at HEAD)

| Area | Score | Evidence |
|---|---|---|
| CTF trace fidelity | 4/5 | `ctf-service.mjs:1426` (`startedAt` from real run start), `:1413` (`submittedAt` from actual submit step), `:1462` unclipped `rawObservation`. Format gained `runId`/`status`/`completedAt`. **Live-verified 2026-11-12**: fresh runs show distinct duration-consistent timestamps (16.7s/54.1s/106.4s), raw observations to 11,418 chars, screenshots hash-verified against trajectory refs, all 3 challenges judge-accepted |
| Sandbox-agent capture path | 4/5 | `haloop-agent-proxy.mjs:486,776,1232` injects trace identity on all 3 egress paths; guarded by `haloop-proxy-fidelity.test.mjs` (10 tests: image blocks, param passthrough, finish_reason mapping, refusal-to-fabricate, byte-exact passthrough). Strongest-tested surface in the repo. **Live-verified**: sandbox spans carry full envelopes, `original_hash` on 100% of LLM spans, cost math reproduces to the cent |
| Screen recorder mechanics | 3.5/5 | `frame_before`/`frame_after` pairing correct (`demonstration-recorder.mjs:534-558`), sha256 dedup works, self-exclusion via `setContentProtection` (:751), `isTestEnv()` guards make Electron paths mockable. **Live-verified**: all 10 human_actions in `test-capture-10` carry both frame refs; 1920×1080 JPEG artifacts served over HTTP with correct MIME |
| Doc/test hygiene fixes | verified | `session-read-model.e2e.test.ts` identifier fixed (225/226 live); `resolve.ts:29` cross-platform; doctor/wsl tests now carry `skipIf(win32)` guards; O_TRUNC conformance test added (`conformance.mjs:117-131`) |

### Not mature — confirmed gaps at HEAD

1. **Two residual PII leaks, both still present.** (a) `recordInputEvent` passes raw `actionData` into `captureSnapshot` (`demonstration-recorder.mjs:541`), which embeds it verbatim at `:507` — typed text leaks into `screen_observation.action.text`; the `scrubPiiText` pass (`:560-563`) happens after and only for `human_action`. **Live-observed**: typed strings appear verbatim in both event kinds in `test-capture-10`. (b) Window titles are raw end-to-end (`:134-141` → `:505`,`:570`); the task title *is* scrubbed (:227), making this an inconsistency. Notepad titles echo typed document text — demonstrated live.
2. **Recorder has zero test backing.** The 84-line test deleted in `ad889438` was never re-added; no `DemonstrationRecorder` reference anywhere in `__tests__/`. The `isTestEnv` guards now make a headless test feasible in a way it wasn't at removal time.
3. **Session-level TracePack/SellTraces export is an empty stub** — `openrindExportSessionTracePack` (main.mjs:2685-2687) builds from a placeholder with no spans/events, and has zero UI callers. Only the CTF export path produces a real pack. The "unified format" story is true for CTF only.
4. **No replay/review workflow.** Demonstration surface is control-only (counters, no playback); CTF surface renders steps as text and never renders the per-step screenshots the format carries; the only frame visibility is the analytics "View Frame" point lookup. Records have **no local persistence** — `stop()` posts once, fail-open (:675-690); collector down = recording gone.
5. **No OTel ingestion** (nothing listens on 4318/`/v1/traces`; OTLP exists only as a TracePack export format).
6. **Browser-pod recording still a declared no-op** (`contracts.mjs:44`: `enableWebRecording`/`enableVideoWebRecording`/`useStealth`).
7. **CTF traces lie about provenance**: `callLlmInference` fetches Anthropic directly (`ctf-service.mjs:717`) yet every model_call is stamped `relayed_by: "inference-gateway"` (:1452), which TracePack propagates (:159). Fabricated provenance undermines the evidence-first moat.
8. **Privacy posture**: both leaks stream to a hardcoded public IP over plain unauthenticated HTTP — default in five places (`main.mjs:3614,3631,3632,3689`; `demonstration-recorder.mjs:471`).
9. **Doc drift (small)**: browser-pods README "47 unit tests"→actual 68, "261"→279; `HISTORICAL-INVENTORY.md:37` still lists O_TRUNC as required; working-dir `ctf-traces/` still holds Oct-21 pre-fix artifacts (old schema, placeholder timestamps) that contradict the fixes; `gap-plan.md` status table stale.

## 12. w8-haloop — maturity verdict

| Subsystem | Verdict | Evidence |
|---|---|---|
| Eval extraction/normalization | **Mature** | `359c7d0` genuinely fixes the mint-422 defect (`extract.py:116-121` accepts `role:"system"`, drops system from replay projection, seeds default project). Both previously-failing tests now pass (verified live). Unsupported Anthropic blocks make spans ineligible rather than flattened — correct |
| BYOH reward mechanics | **Mature** | Explicit `incomplete` gate outcome (`store.py:704-709`); leg tokens hash-only/HMAC-compared/expiring/revocable under `FOR UPDATE` (`reward_store.py:1407-1426,1747-1749`); uncertain work → `blocked` (:507-516); verifier `no-network` enforced at packaging (`task_bundle.py:1108-1115`); simulation gated behind `W8_REWARD_SIMULATE=1` (live-probed both modes) |
| Replay fidelity | Works, thin | Whitelists both sides; source evidence never executable. No determinism pinning when source request lacked temperature/top_p |
| Grading | **Works, thin — one check is dead** | See §14: truncation check dead at replay (reproduced live at HEAD), no semantic comparison anywhere, golden cases add zero correctness signal |
| Rollout gate | Works, thin | Single aggregate pass_rate; weak checks make it passable by bad candidates |
| Collector core | Works as reference | Ledger/schema solid; logprobs captured both builders; `/internal/capture/*` authenticated + producer-scoped |
| **BYOH auth** | **Defective — committed backdoor** | `services/byoh/api.py:52-55`: `_authorized` accepts hardcoded `w8-catalog-simulation-admin`/`-runner` bearer tokens **even when the env token is set**. Committed in-repo ⇒ operator tokens never fully rotate. Undocumented in HALOOP.md. Same token string is the web proxy fallback (`web/src/app/api/collector/.../route.ts:98`) |
| **Collector security** | **Missing** | `/spans`, `/stats`, `/traces`, `/artifacts`, `/halo/*`, `/evals/*` all unauthenticated. Worst: **`DELETE /projects/{project}` is unauthenticated and destructive** (disk traces + capture DB + reward rollouts, `app.py:493-530`) |
| Hygiene (inherited) | Poor | Broken `plugin_test.traces.jsonl` still fails the repo's own validator; `format:check` still 200 files; `jest src/` 9/13 suites red; `pydantic-settings` in `dev` extra though the only importer is a byoh test (`tests/test_byoh_harbor.py:14`) |

## 13. Competitive refresh (2026-11) — the market moved

**Consolidation wave:** Langfuse → ClickHouse (Jan 2026; v4 GA, v3 deprecated Nov 16), Helicone → Mintlify then orphaned (frozen since Nov 2025), Traceloop → ServiceNow, Promptfoo → OpenAI, Galileo → Cisco/Splunk (Luna-2 distilled judges), **Portkey (this fork's ancestor) → Palo Alto Networks** (now "PRISMA AIRS AI Gateway"), Arize/Phoenix → Dynatrace ($915M, Phoenix supported), Braintrust independent ($80M Series B).

**Biggest threat — Arize Phoenix shipped a Harbor plugin** (Sep 8, 2026): benchmark jobs land as datasets + one experiment per agent/model config, one run per trial, **Harbor reference outputs shown next to agent responses** (Nov 2). Plus ATIF trajectory import (Apr 2026 — offline Harbor runs visualized beside live traces), Docker-sandboxed code evaluators (Oct 13), auth-by-default + OAuth2 (v21), OTel GenAI semconv auto-convert at ingest. **Phoenix is commoditizing your Harbor-benchmark differentiator from the UX side.** Your remaining moats vs Phoenix: verifier-bound evidence ledger, paired/forked harness trials, episode fork graphs — but the gap narrowed.

**Bar-moved table (the 8 lag items from Part 1 §8.3):**

| Lag item | 2026 bar |
|---|---|
| No trace-replay web UI | Moved (AgentOps time-travel replay, Langfuse v4 zoomable timeline) |
| No OTel ingestion | **Now table stakes** (Langfuse OTLP endpoint, Phoenix semconv auto-convert, OpenLIT/Opik/LLMetry all OTel) |
| Unauthenticated ingest | Moved (Phoenix auth-by-default + OAuth2; Langfuse per-project OTLP keys) |
| Fragmented formats | **Convergence underway** — ATIF + OpenInference→OTel donation (Jun 2026); custom formats becoming a liability |
| No video/audio | Moved (Langfuse v4 multimodal evaluators grade video/audio/images in traces) |
| No online judges/prompt hub/datasets UX | **Deeply table stakes** (Langfuse evaluator flow w/ cost preview, Braintrust, LangSmith Fleet, Splunk Luna judges) |
| Basic cost accounting | Moved (Phoenix `cost_details` + daily-updated prices, Langfuse param-matched pricing) |
| Single-process operability | Parity, not advantage (single-container is the OSS norm) |

**Still uniquely yours (verified against competitor docs):** action-paired screen capture bound to a trace tree (no observability/eval competitor ships this; closest are browser-infra vendors' session replay); verifier-bound reward evidence + episode fork graphs + paired harness trials (Phoenix closest, no ledger binding); CTF-style autonomous-agent benchmarking remains whitespace in this category.

## 14. Eval + Harbor-task quality — the "better evals" answer

**The promote gate is a well-formedness check, not a quality check. All 5 adversarial classes pass today** (each reproduced against code at HEAD):
1. Wrong tool among valid tools — passes (no "expected tool" concept; `checks.py:64-73` only validates names against the offered set)
2. Bogus args for `{}`-schema tools — passes (`checks.py:41` maps missing `parameters` to `{}`; `jsonschema.validate(anything, {})` succeeds)
3. Truncated output — passes (`run_evals.py:85` grades `choices[0].message.model_dump()`, which has no `finish_reason`; `not_truncated` returns None and is filtered — reproduced live: truncated response → `passed_all: True`)
4. Indirect refusal — passes (4 English regexes at `checks.py:18-23`; the API `refusal` field the message dict carries is never inspected)
5. Wrong-but-plausible answer — passes (chat cases get exactly `non_empty` + `no_refusal`)

**Harbor-task generation:** solvability is never validated — the reference solution is never run; the negative/positive controls demanded by the synthesis prompt (`reward_runner.py:638-644`) exist only in the prompt and in CI fixtures, never on production-generated tasks. `unvalidated_generated` is **never cleared anywhere** (grep-confirmed; a permanent scar, not a lifecycle state) — yet `evals_api.py:163-191` will serve an unvalidated task as the gating eval for a project. No task dedup or contamination screening exists. Labeling is admirably honest (`benchmark_validity_claimed: False`), but honesty is the only guard.

**What's already good:** episode reconstruction and replay normalization are genuinely solid (tested at `test_evalgen.py:95-184`); replay whitelist is disciplined; trace-id citation check is fail-closed; the runner never executes generated code; truncation is detected at extraction for tagging — only replay verification is missing. Scaffold for every fix below exists in-repo.

## 15. UI/replay audit — 3/5 breadth, 1/5 replay

The Part 1 "frame viewer only" score was stale on breadth: the desktop analytics tab is a real-data observability dashboard (KPI cards, latency/token charts, pricing, warning strip), and w8-haloop's web app is a functional 6-tab Langfuse-lite (span inspector with inline prompt/completion, HALO reports, Harbor rollout manager, evals). **But the replay gap stands where it matters:** no span tree/waterfall despite `parent_span_id` in the data; no session-grouped view anywhere; **zero demonstration playback** (input events captured, rendered nowhere); CTF trajectories never reach the collector (two UIs, two ID schemes); hardcoded collector IP in desktop views + hardcoded admin-token fallback in the web proxy. Every user journey dead-ends at "export a zip and open it yourself."

## 16. Master backlog (merged from all five audits, ranked)

### P0 — security & evidence integrity (production-grade blockers; most are small)
1. **Remove the BYOH hardcoded-token backdoor** — `services/byoh/api.py:52-55` (+ the same token as web proxy fallback `route.ts:98`). Env token only; document rotation. *(S)*
2. **Authenticate collector destructive + ingest surface** — minimum `DELETE /projects/{project}` (`app.py:493`) and `POST /spans` (`app.py:236`); reuse the producer-token pattern from `services/capture/api.py:37-42`. Main paying-customer blocker. *(M)*
3. **Kill the hardcoded public-IP collector default** — 5 places in openeral (`main.mjs:3614,3631,3632,3689`; `demonstration-recorder.mjs:471`). Default localhost, remote opt-in. This is a privacy incident waiting to happen (typed text + screen frames over plain HTTP to a public IP). *(S)*
4. **Scrub typed text in `screen_observation.action`** — move the scrub before `captureSnapshot` (`demonstration-recorder.mjs:541` vs `:560`); ~5 lines + a unit test. Live-confirmed leak. *(S)*
5. **Scrub/drop window titles** at the two emit points (`:505`,`:570`), gated on `scrubPii`. *(S)*
6. **Fix the CTF provenance lie** — `relayed_by: "inference-gateway"` on direct-to-Anthropic calls (`ctf-service.mjs:1452` → `tracepack-builder.mjs:159`). Evidence integrity is the claimed moat. *(S)*
7. **Restore a recorder unit test** — `isTestEnv()` guards now make it feasible; assert seal receipts, record sequence, scrub-on-both-event-kinds (locks in #4-5). *(S)*

### P1 — make the eval gate honest (the stated "better evals" goal)
8. **Fix the dead truncation check** — pass `choices[0].finish_reason` into `run_checks` (`run_evals.py:84-88`) and fail on `message.refusal`. *(S, high impact)*
9. **Structural diff vs recorded incumbent output** — `incumbent_output` is already in every case (`extract.py:330`), unused at replay. Add expected tool-name set, args-key overlap, call-count parity. Kills "wrong tool among valid tools" + many wrong-answer passes; deterministic, free. *(S-M, high impact)*
10. **Solvability guarantee via Harbor scratch sandbox** — run the verifier's negative (pristine must fail) and positive (reference must pass) controls at packaging time through the existing Daytona/Harbor plumbing (recipe in `test_e2e_trace_capture_and_harbor_evals.py:222-242`); record `pristine_reward`/`solved_reward` in preflight; clearing `unvalidated_generated` finally makes it a lifecycle state. Cheapest version = negative control only. *(M, highest-value task-quality addition)*
11. **Quarantine unvalidated tasks** — `evals_api.py:163-191` must not serve `unvalidated_generated` tasks as a project's gating eval. *(S-M)*
12. **Per-check floors in the rollout gate** — gate on `not_truncated == 1.0` and `tool_name_valid == 1.0`, not just aggregate pass_rate (`rollout.py:36-43`). *(S)*
13. **Statistical gate across N replays** — `--repeats k` per case (seed already forwarded), majority/Wilson-bound pass. A 0.9 threshold over a few dozen single shots is mush. *(M)*
14. **Refusal expansion** — API `refusal` field, Anthropic `stop_reason: "refusal"`, wider pattern set (`checks.py:18-23`). *(S)*
15. **Judge-model grading for chat cases** (optional, later) — collector already stores full envelopes; provider plumbing exists. Covers what #9 can't. *(M-L)*

### P2 — capture completeness
16. **Unify CTF trajectories with the collector** — post `ctf-service.mjs` results to `/spans` + `/artifacts` (or add a web CTF tab). Closes the two-format fragmentation the market is converging away from. *(M)*
17. **DOM snapshots for sandbox/browser sessions** — CTF gets a11y snapshots; sandbox Claude sessions and browser pods get none. Cheapest: persist periodic snapshots via `haloop-agent-proxy.mjs` or PTY layer; or wire browser-pod CDP screencast to actually record (replacing the `contracts.mjs:44` no-op). *(M)*
18. **Logprob end-to-end verification** — capture exists in both builders but 0 of 206 live LLM spans carry `llm.response.logprobs`. Request logprobs through the gateway once and confirm, or soften the HALOOP.md claim. *(S)*
19. **Local spool for demonstration records** — `stop()` should write to `userData/demonstrations/<runId>.json` before the collector POST and retransmit on launch; collector downtime currently destroys recordings. *(M)*
20. **Replay determinism defaults** — when the source request lacks temperature/top_p, pin explicit defaults in `run_evals.py:68-76` so cross-target comparisons aren't confounded. *(S)*
21. **Task dedup/contamination + difficulty metadata** for generated Harbor tasks. *(M)*

### P3 — replay/visualization (the 1/5 → 4/5 move; defends against Phoenix)
22. **Span waterfall/tree in the web TraceDrawer** — group `/traces` by `trace_id`, render `parent_span_id` hierarchy + duration bars. Data already there. *(M)*
23. **Session list page** — group by `inference.session_id` with per-session cost/duration/stop-reason drill-down. *(M)*
24. **Demonstration replay viewer** — frame timeline + action list synced to frames + click/key overlay + export; data already in the collector. *(L)*
25. **CTF screenshot rendering** in the desktop CTF surface (data already in `trajectory.steps[].screenshot`). *(S)*
26. Config-driven collector URLs, deep links (`?project=&trace_id=`), web cost/latency time-series, frame before/after diff in the View Frame modal. *(S each)*

### P4 — hygiene
27. Fix or delete `data/traces/plugin_test.traces.jsonl` (fails the repo's own validator). *(S)*
28. Move `pydantic-settings` to the `byoh` extra. *(S)*
29. `format:check`: one Prettier pass repo-wide or scope to owned surfaces; quarantine the inherited `jest src/` surface (xfail + tracking note) so `test:gateway` becomes signal. *(S-M)*
30. Doc drift sweep: browser-pods README 47→68 / 261→279; HISTORICAL-INVENTORY O_TRUNC done; regenerate or delete stale Oct-21 `ctf-traces/`; `gap-plan.md` status table. *(S)*
31. Windows pass for portable-files + server-v2 contract suites (same guard pattern as doctor/wsl). *(M)*

## 17. Answer to "are they perfect?"

No — but the distance is now precisely measurable. **Capture fidelity is research-grade and better than most commercial tools** (CTF 4/5, sandbox path 4/5, recorder mechanics 3.5/5, all live-verified; haloop proxy fidelity suite and TracePack invariants are the proof). **What's missing is everything around capture:** the P0 items are mostly ≤small effort but are the difference between "demo-grade" and "production-grade" (backdoor, unauthenticated delete, two leaks, fabricated provenance); **P1 is the difference between a well-formedness gate and a quality gate** (5/5 adversarial classes currently pass); P3 is where Phoenix is attacking. The moats remain real — action-paired screen capture, verifier-bound ledger, paired trials, CTF whitespace — but 2026's consolidation and Phoenix's Harbor plugin mean the comfortable lead is gone. Items 1–10 alone would take the system from "almost done" to "defensible."
