import assert from "node:assert/strict";
import test from "node:test";
import { slugifyProject, DemonstrationRecorder } from "../../electron/openshell/demonstration-recorder.mjs";

test("slugifyProject correctly normalizes user task titles into safe Haloop project IDs", () => {
  assert.equal(
    slugifyProject("Invoice entry in Excel & email dispatch"),
    "invoice-entry-in-excel-email-dispatch"
  );
  assert.equal(
    slugifyProject("Write offerletter and attach signature (VLA task #1)"),
    "write-offerletter-and-attach-signature-vla-task-1"
  );
  assert.equal(
    slugifyProject("   Task with spaces and Symbols @#$%   "),
    "task-with-spaces-and-symbols"
  );
  assert.equal(slugifyProject(""), "workflow-demo");
});

test("DemonstrationRecorder initializes, seals, and records actions", async () => {
  let mockCollectorPayload = null;
  const mockWindow = {
    minimize() {},
    restore() {},
    show() {},
    focus() {},
    isDestroyed() { return false; },
    webContents: {
      send() {},
    },
  };

  const recorder = new DemonstrationRecorder({
    getMainWindow: () => mockWindow,
    postCollectorEvents: async (bundle) => {
      mockCollectorPayload = bundle;
    },
  });

  // Mock internal window creation, mouse tracker, and snapshot capture for headless Node test
  recorder._createFloatingWindow = async () => {};
  recorder._updateFloatingState = () => {};
  recorder._startMouseTracker = () => {};
  recorder.captureSnapshot = async () => null;

  const startRes = await recorder.start({
    taskTitle: "Invoice entry in Excel & email dispatch",
    scrubPii: true,
  });

  assert.equal(startRes.started, true);
  assert.equal(startRes.projectId, "invoice-entry-in-excel-email-dispatch");

  // Record an input action
  await recorder.recordInputEvent({
    type: "mouse_click",
    button: "left",
    x: 450,
    y: 320,
    target: "Excel Cell B4",
  });

  await recorder.recordInputEvent({
    type: "type_text",
    text: "Q3 Vendor Invoice",
  });

  assert.equal(recorder.activeSession.inputEventsCount, 2);

  // Stop recording
  const stopRes = await recorder.stop();

  assert.equal(stopRes.success, true);
  assert.equal(stopRes.projectId, "invoice-entry-in-excel-email-dispatch");
  assert.equal(stopRes.actionsCount, 2);
  assert.ok(mockCollectorPayload);
  assert.equal(mockCollectorPayload.project, "invoice-entry-in-excel-email-dispatch");

  const actionRecords = mockCollectorPayload.records.filter((r) => r.kind === "human_action");
  assert.equal(actionRecords.length, 2);
  assert.ok("frame_before" in actionRecords[0].payload);
  assert.ok("frame_after" in actionRecords[0].payload);
});
