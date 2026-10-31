// Scoped Producer API and Outbox Tracking (Section 15.1)
import { createEvidenceRecord } from "./schema.mjs";
import { createRunReceipt } from "./receipt.mjs";
import { ArtifactStore } from "./artifacts.mjs";

export class CaptureProducer {
  constructor({
    identity,
    producerId = "agent",
    producerInstanceId = "default",
    artifactStore = null,
  }) {
    if (!identity?.run_id || !identity?.trace_id) {
      throw new Error("CaptureProducer requires an identity object with run_id and trace_id");
    }
    this.identity = identity;
    this.producerId = producerId;
    this.producerInstanceId = producerInstanceId;
    this.artifactStore = artifactStore || new ArtifactStore();
    this.records = [];
    this.sequence = 1;
    this.isSealed = false;
  }

  emit({
    kind = "event",
    observedAtUnixNs = null,
    origin = "observed",
    executor = null,
    attribution = null,
    payload = {},
    capture = {},
  }) {
    if (this.isSealed) {
      throw new Error("Cannot emit events after producer has been sealed");
    }

    const record = createEvidenceRecord({
      runId: this.identity.run_id,
      traceId: this.identity.trace_id,
      spanId: this.identity.root_span_id,
      sessionId: this.identity.session_id,
      producerId: this.producerId,
      producerInstanceId: this.producerInstanceId,
      sequence: this.sequence++,
      kind,
      observedAtUnixNs: observedAtUnixNs || String(BigInt(Date.now()) * 1000000n),
      origin,
      executor,
      attribution,
      payload,
      capture,
    });

    this.records.push(record);
    return record;
  }

  recordArtifact(name, content, mediaType) {
    return this.artifactStore.record(name, content, mediaType);
  }

  seal({ complete = true } = {}) {
    this.isSealed = true;
    const receipt = createRunReceipt({
      runId: this.identity.run_id,
      receiptRevision: 1,
      state: complete ? "sealed_complete" : "sealed_partial",
      completeAtSeal: complete,
      producerId: this.producerId,
      producerInstanceId: this.producerInstanceId,
      expectedFinalSequence: this.sequence - 1,
      sealVerified: true,
    });
    return {
      receipt,
      totalRecords: this.records.length,
      artifacts: this.artifactStore.getManifest(),
    };
  }

  getRecords() {
    return [...this.records];
  }
}
