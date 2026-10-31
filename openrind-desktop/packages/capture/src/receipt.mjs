// Durable execution and capture receipt schema (Section 14.5)

export const RECEIPT_SCHEMA_VERSION = "openrind-receipt/v1";

export function createRunReceipt({
  runId,
  receiptRevision = 1,
  state = "sealed_complete",
  completeAtSeal = true,
  currentlyAvailable = true,
  producerId = "agent",
  producerInstanceId = "default",
  expectedFinalSequence = 0,
  persistedRanges = [],
  missingRanges = [],
  conflicts = [],
  pendingArtifacts = [],
  sealVerified = true,
} = {}) {
  return {
    schema: RECEIPT_SCHEMA_VERSION,
    run_id: runId,
    receipt_revision: Number(receiptRevision),
    state,
    complete_at_seal: Boolean(completeAtSeal),
    currently_available: Boolean(currentlyAvailable),
    components: {
      agent_execution: {
        state: completeAtSeal ? "complete" : "interrupted",
        producer_id: producerId,
        producer_instance_id: producerInstanceId,
        expected_final_sequence: expectedFinalSequence,
        persisted_ranges: persistedRanges.length > 0 ? persistedRanges : [[1, Math.max(1, expectedFinalSequence)]],
        missing_ranges: missingRanges,
        conflicts,
        pending_artifacts: pendingArtifacts,
        seal_verified: Boolean(sealVerified),
      },
    },
  };
}
