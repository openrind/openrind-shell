import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPTURE_POLICY_VERSION,
  DEFAULT_EXCLUDED_PROCESSES,
  DemonstrationRecorder,
  EVIDENCE_EVENT_KINDS,
  isExcludedProcess,
  parseExcludedProcesses,
  parseMaskRegions,
  slugifyProject,
} from "../../electron/openshell/demonstration-recorder.mjs";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function createRecorder({ activeWindow, bundles } = {}) {
  return new DemonstrationRecorder({
    getMainWindow: () => null,
    getActiveWindow: () => activeWindow ?? { title: "Test Window", process: "TEST", trusted: true },
    postCollectorEvents: async (bundle) => {
      bundles?.push(bundle);
    },
  });
}

test("task.started and policy.recorded carry valid evidence payloads at start", async () => {
  const recorder = createRecorder();
  await recorder.start({ taskTitle: "Invoice entry in Excel", trainingConsent: false });

  const records = recorder.activeSession.producer.getRecords();
  const taskStarted = records.find((r) => r.kind === "task.started");
  assert.ok(taskStarted, "task.started record exists");
  assert.deepEqual(
    Object.keys(taskStarted.payload).sort(),
    ["attempt_id", "domain", "harness", "instruction", "task_id", "type"],
  );
  assert.equal(taskStarted.payload.type, "task.started");
  assert.equal(taskStarted.payload.task_id, "invoice-entry-in-excel");
  assert.equal(taskStarted.payload.attempt_id, recorder.activeSession.runId);
  assert.equal(taskStarted.payload.domain, "other");
  assert.equal(taskStarted.payload.harness.name, "openrind-workflow-recorder");
  assert.ok(taskStarted.payload.harness.version);

  const policy = records.find((r) => r.kind === "policy.recorded");
  assert.ok(policy, "policy.recorded record exists");
  assert.deepEqual(policy.payload, {
    type: "policy.recorded",
    policy_version: CAPTURE_POLICY_VERSION,
    training_opt_out: true,
  });

  await recorder.stop();
});

test("policy.recorded reports training_opt_out false only with explicit consent", async () => {
  const recorder = createRecorder();
  await recorder.start({ taskTitle: "Consent given", trainingConsent: true });
  const policy = recorder.activeSession.producer.getRecords().find((r) => r.kind === "policy.recorded");
  assert.equal(policy.payload.training_opt_out, false);
  await recorder.stop();
});

test("session.closed carries the required expected_request_ids and a host event inventory", async () => {
  const bundles = [];
  const recorder = createRecorder({ bundles });
  await recorder.start({ taskTitle: "Closure check" });
  const result = await recorder.stop();

  assert.equal(result.success, true);
  assert.equal(bundles.length, 1, "one bundle posted on stop");
  const records = bundles[0].records;

  const closure = records.find((r) => r.kind === "session.closed");
  assert.ok(closure, "session.closed record exists");
  assert.deepEqual(
    Object.keys(closure.payload).sort(),
    ["capture_gaps", "expected_event_ids", "expected_request_ids", "reason", "type"],
  );
  assert.equal(closure.payload.type, "session.closed");
  assert.equal(closure.payload.reason, "completed");
  // Human demonstrations make no model requests; the inventory is empty but present.
  assert.deepEqual(closure.payload.expected_request_ids, []);

  const hostIds = records
    .filter((r) => EVIDENCE_EVENT_KINDS.has(r.kind) && r.kind !== "session.closed")
    .map((r) => r.record_id);
  assert.deepEqual(closure.payload.expected_event_ids, hostIds);
  assert.ok(hostIds.length >= 2, "task.started and policy.recorded are inventoried");
  assert.ok(!closure.payload.expected_event_ids.includes(closure.record_id));

  for (const record of records.filter((r) => EVIDENCE_EVENT_KINDS.has(r.kind))) {
    assert.match(record.record_id, IDENTIFIER_PATTERN);
    assert.ok(record.record_id.length <= 128);
    assert.equal(record.payload.type, record.kind, "payload type matches record kind");
  }
  assert.match(bundles[0].project, PROJECT_PATTERN);
});

test("human_action and screen_observation are span-only, not evidence event kinds", () => {
  assert.equal(EVIDENCE_EVENT_KINDS.has("human_action"), false);
  assert.equal(EVIDENCE_EVENT_KINDS.has("screen_observation"), false);
  for (const kind of [
    "task.started",
    "episode.started",
    "response.selected",
    "tool.finished",
    "artifact.recorded",
    "outcome.observed",
    "session.closed",
    "policy.recorded",
  ]) {
    assert.ok(EVIDENCE_EVENT_KINDS.has(kind), `${kind} is a valid evidence event`);
  }
});

test("excluded processes produce no input events and no frames", async () => {
  assert.deepEqual(parseExcludedProcesses("KeePass.EXE, myapp ,"), ["keepass", "myapp"]);
  assert.ok(isExcludedProcess("Bitwarden.exe", DEFAULT_EXCLUDED_PROCESSES));
  assert.ok(isExcludedProcess("keepassxc", DEFAULT_EXCLUDED_PROCESSES));
  assert.equal(isExcludedProcess("notepad", DEFAULT_EXCLUDED_PROCESSES), false);

  const bundles = [];
  const recorder = createRecorder({
    bundles,
    activeWindow: { title: "Vault", process: "KeePass", trusted: true },
  });
  await recorder.start({ taskTitle: "Excluded window" });

  const inputResult = await recorder.recordInputEvent({ type: "type_text", text: "vault-secret" });
  assert.equal(inputResult, null, "input into an excluded window is dropped");
  assert.equal(recorder.activeSession.inputEventsCount, 0);
  assert.equal(recorder.activeSession.producer.getRecords().filter((r) => r.kind === "human_action").length, 0);

  const frame = await recorder.captureSnapshot({ trigger: "manual" });
  assert.equal(frame, null, "excluded window is never captured");
  assert.ok(recorder.activeSession.excludedSkips >= 1);

  await recorder.stop();
  const closure = bundles[0].records.find((r) => r.kind === "session.closed");
  assert.ok(closure.payload.capture_gaps.includes("excluded_window:keepass"));
});

test("untrusted window title applies conservative masking and logs once per session", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const recorder = createRecorder({
      activeWindow: { title: "Stale Title", process: "APP", trusted: false },
    });
    await recorder.start({ taskTitle: "Untrusted title" });

    const first = await recorder.recordInputEvent({ type: "type_text", text: "hello world" });
    assert.equal(first.payload.text, "••••••••", "untrusted title masks typed text");
    assert.equal(first.payload.activeWindow.titleTrusted, false);
    const second = await recorder.recordInputEvent({ type: "type_text", text: "again" });
    assert.equal(second.payload.text, "••••••••");

    const maskingLogs = warnings.filter((line) => line.includes("masking activated"));
    assert.equal(maskingLogs.length, 1, "masking activation is logged once per session");
    await recorder.stop();
  } finally {
    console.warn = originalWarn;
  }
});

test("trusted titles mask only sensitive contexts", async () => {
  const recorder = createRecorder({
    activeWindow: { title: "Documents - Editor", process: "EDITOR", trusted: true },
  });
  await recorder.start({ taskTitle: "Trusted title" });

  const plain = await recorder.recordInputEvent({ type: "type_text", text: "hello world" });
  assert.equal(plain.payload.text, "hello world");
  assert.equal(plain.payload.activeWindow.titleTrusted, true);
  assert.equal(recorder.activeSession.maskingLogged, false);

  recorder.getActiveWindowFn = () => ({ title: "Sign in to your account", process: "BROWSER", trusted: true });
  const masked = await recorder.recordInputEvent({ type: "type_text", text: "hunter2" });
  assert.equal(masked.payload.text, "••••••••");
  assert.equal(recorder.activeSession.maskingLogged, true);
  await recorder.stop();
});

test("user attestation emits artifact.recorded then outcome.observed, once", async () => {
  const bundles = [];
  const recorder = createRecorder({ bundles });
  await recorder.start({ taskTitle: "Attestation flow" });
  const stopResult = await recorder.stop();
  assert.equal(bundles.length, 1);

  const attestation = await recorder.attestOutcome({ completed: true });
  assert.deepEqual(attestation, { emitted: true, verdict: "pass" });
  assert.equal(bundles.length, 2, "attestation posts a second bundle");

  const records = bundles[1].records;
  assert.equal(records.length, 2);
  const [artifactEvent, outcomeEvent] = records;
  assert.equal(artifactEvent.kind, "artifact.recorded");
  assert.equal(artifactEvent.payload.type, "artifact.recorded");
  const content = JSON.parse(artifactEvent.payload.content);
  assert.equal(content.answer, "yes");
  assert.equal(content.session_id, stopResult.sessionId);

  assert.equal(outcomeEvent.kind, "outcome.observed");
  assert.equal(outcomeEvent.payload.type, "outcome.observed");
  assert.equal(outcomeEvent.payload.origin, "self_report");
  assert.equal(outcomeEvent.payload.verdict, "pass");
  assert.match(outcomeEvent.payload.subject_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(outcomeEvent.payload.evidence_artifact_ids, [artifactEvent.payload.artifact_id]);

  const taskStarted = bundles[0].records.find((r) => r.kind === "task.started");
  assert.equal(outcomeEvent.payload.task_id, taskStarted.payload.task_id);
  assert.equal(outcomeEvent.payload.attempt_id, taskStarted.payload.attempt_id);

  const again = await recorder.attestOutcome({ completed: false });
  assert.equal(again.emitted, false, "attestation is one-shot per session");
  assert.equal(bundles.length, 2);
});

test("attestation with no completed session emits nothing", async () => {
  const bundles = [];
  const recorder = createRecorder({ bundles });
  const result = await recorder.attestOutcome({ completed: true });
  assert.equal(result.emitted, false);
  assert.equal(bundles.length, 0);
});

test("slugifyProject always yields a valid capture project id", () => {
  assert.equal(slugifyProject("Invoice entry in Excel"), "invoice-entry-in-excel");
  assert.equal(slugifyProject("__Leading Underscores"), "leading-underscores");
  assert.equal(slugifyProject("..dots and spaces.."), "dots-and-spaces");
  assert.equal(slugifyProject(""), "workflow-demo");
  assert.equal(slugifyProject(null), "workflow-demo");
  for (const title of ["__x", "..y", "--z", "!!!", " normal "]) {
    assert.match(slugifyProject(title), PROJECT_PATTERN, `project for ${JSON.stringify(title)}`);
  }
});

test("parseMaskRegions accepts JSON config and drops invalid entries", () => {
  assert.deepEqual(parseMaskRegions('[{"x":0,"y":0,"w":200,"h":40,"display":"123"}]'), [
    { x: 0, y: 0, w: 200, h: 40, display: "123" },
  ]);
  assert.deepEqual(parseMaskRegions([{ x: 5, y: 5, w: 10, h: 10 }]), [{ x: 5, y: 5, w: 10, h: 10 }]);
  assert.deepEqual(parseMaskRegions("not json"), []);
  assert.deepEqual(parseMaskRegions(""), []);
  assert.deepEqual(parseMaskRegions(undefined), []);
  assert.deepEqual(parseMaskRegions('[{"x":0,"y":0,"w":0,"h":40},{"x":"a","y":0,"w":1,"h":1}]'), []);
});
