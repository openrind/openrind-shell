/** @jsxImportSource react */
import { useCallback, useState } from "react";
import { RefreshCw } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import type {
  HaloopAnalysisStatus,
  HaloopDownloadResult,
  HaloopIncumbentRollbackResult,
  HaloopRuntimeStatus,
  HaloopTokenRotationResult,
} from "../state/openshell-state";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export type HaloopViewProps = {
  status?: HaloopRuntimeStatus | null;
  captureStatus?: HaloopAnalysisStatus | null;
  busy?: boolean;
  onStatusMessage: (message: string) => void;
  onDownloadTraces?: () => Promise<HaloopDownloadResult>;
  onRefresh?: () => Promise<void>;
  onRestart?: () => Promise<void>;
  onRestoreIncumbent?: () => Promise<HaloopIncumbentRollbackResult>;
  onRotateToken?: () => Promise<HaloopTokenRotationResult>;
};

export function HaloopView(props: HaloopViewProps) {
  const [error, setError] = useState<string | null>(null);
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [rotationConfirmOpen, setRotationConfirmOpen] = useState(false);

  const restartHaloop = useCallback(async () => {
    setError(null);
    try {
      await props.onRestart?.();
      props.onStatusMessage("Haloop routing and private trace capture restarted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [props.onRestart, props.onStatusMessage]);

  const restoreHaloopIncumbent = useCallback(async () => {
    setError(null);
    try {
      await props.onRestoreIncumbent?.();
      setRollbackConfirmOpen(false);
      props.onStatusMessage(
        "The approved incumbent-only Haloop route was restored. Existing agent sessions and FUSE data were preserved.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [props.onRestoreIncumbent, props.onStatusMessage]);

  const rotateHaloopToken = useCallback(async () => {
    setError(null);
    try {
      const result = await props.onRotateToken?.();
      setRotationConfirmOpen(false);
      const ended = result?.affectedSessions ?? 0;
      props.onStatusMessage(
        `Haloop token rotated. ${ended} in-app agent session${ended === 1 ? " was" : "s were"} ended; relaunch affected agents.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [props.onRotateToken, props.onStatusMessage]);

  const downloadTraces = useCallback(async () => {
    setError(null);
    try {
      const result = await props.onDownloadTraces?.();
      if (result && !result.canceled) props.onStatusMessage("Traces downloaded. Import them in the w8-haloop web app.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [props.onDownloadTraces, props.onStatusMessage]);

  const stateLabel = props.status
    ? {
        ready: "Ready",
        starting: "Starting",
        stopped: "Stopped",
        degraded: "Needs attention",
        blocked: "Blocked",
        unavailable: "Unavailable",
      }[props.status.state]
    : "Checking";
  const stateClass =
    props.status?.state === "ready"
      ? "border-green-7/60 bg-green-3/30 text-green-12"
      : props.status?.state === "starting"
        ? "border-amber-7/60 bg-amber-3/30 text-amber-12"
        : props.status?.state === "stopped" || !props.status
          ? "border-gray-7/50 bg-gray-2/40 text-gray-10"
          : "border-red-7/60 bg-red-3/30 text-red-12";
  const captureIncomplete = Boolean(
    props.status &&
      (props.status.spanCapture.incomplete > 0 ||
        (props.status.health === "healthy" && props.status.collectorHealth !== "healthy")),
  );
  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-4`}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-gray-12">Haloop inference route</span>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${stateClass}`}
              >
                {stateLabel}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-gray-10">
              {props.status?.detail ?? "Checking the required host-managed Haloop edge…"}
            </p>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 rounded-full px-3 text-xs"
            onClick={() => void props.onRefresh?.()}
            disabled={props.busy || !props.onRefresh}
            title="Refresh status"
          >
            <RefreshCw size={12} className={`mr-1.5 ${props.busy ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {props.status ? (
          <div className="grid grid-cols-1 gap-3 text-xs text-gray-10 sm:grid-cols-2">
            <div className="min-w-0 break-words">
              <span className="text-gray-8">Endpoint:</span>{" "}
              <span className="font-mono text-gray-11 break-all">{props.status.endpoint}</span>
            </div>
            <div className="min-w-0 break-words">
              <span className="text-gray-8">Version:</span>{" "}
              <span className="font-mono text-gray-11 break-all">{props.status.version ?? "Not installed"}</span>
            </div>
            <div className="min-w-0 break-words">
              <span className="text-gray-8">Gateway health:</span>{" "}
              <span className="font-mono text-gray-11">{props.status.health ?? "Stopped"}</span>
            </div>
            <div className="min-w-0 break-words">
              <span className="text-gray-8">Trace collector health:</span>{" "}
              <span className="font-mono text-gray-11">{props.status.collectorHealth ?? "Stopped"}</span>
            </div>
            <div className="min-w-0 break-words">
              <span className="text-gray-8">Route policy:</span>{" "}
              <span className="font-mono text-gray-11">Incumbent only</span>
            </div>
            <div className="min-w-0 break-words">
              <span className="text-gray-8">Upstream:</span>{" "}
              <span className="font-mono text-gray-11">
                {props.status.upstreamMode === "openrouter-test"
                  ? "OpenRouter test (openrouter/free)"
                  : "Anthropic"}
              </span>
            </div>
            <div className="min-w-0 break-words sm:col-span-2">
              <span className="text-gray-8">Active route:</span>{" "}
              <span className="text-gray-11 break-words">
                {props.status.activeRoute
                  ? `${props.status.activeRoute.agentId === "openclaw" ? "OpenClaw" : "Claude"} · ${props.status.activeRoute.sandboxName} · ${props.status.activeRoute.providerName}`
                  : "No active sandbox route in this Desktop session."}
              </span>
            </div>
            <div className="min-w-0 break-words sm:col-span-2">
              <span className="text-gray-8">Trusted Desktop spans:</span>{" "}
              <span className="font-mono text-gray-11">
                {props.status.spanCapture.written} written · {props.status.spanCapture.duplicates} duplicate ·{" "}
                {props.status.spanCapture.incomplete} incomplete
              </span>
            </div>
          </div>
        ) : null}

        {props.status?.lastConnectionError ? (
          <div className="rounded-xl border border-red-7/60 bg-red-3/30 px-3 py-2 text-xs text-red-12 break-words">
            Last connection error: {props.status.lastConnectionError}
          </div>
        ) : null}

        {captureIncomplete && props.status ? (
          <div className="rounded-xl border border-amber-7/60 bg-amber-3/30 px-3 py-2 text-xs text-amber-12 break-words">
            Trace capture is incomplete. Haloop routing does not fall back to a direct provider when the private
            collector is interrupted.
            {props.status.spanCapture.lastError
              ? ` Last capture error: ${props.status.spanCapture.lastError}`
              : " Restart the managed Haloop services, then launch a new agent request."}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11 break-words">
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {props.onRestart ? (
            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              onClick={() => void restartHaloop()}
              disabled={
                props.busy ||
                !props.status?.activeRoute ||
                props.status?.state === "blocked" ||
                props.status?.state === "unavailable"
              }
            >
              <RefreshCw size={12} className="mr-1.5" />
              Restart Haloop
            </Button>
          ) : null}
          {props.onRestoreIncumbent ? (
            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              onClick={() => setRollbackConfirmOpen(true)}
              disabled={
                props.busy ||
                !props.status?.activeRoute ||
                props.status?.collectorHealth !== "healthy" ||
                props.status?.state === "blocked" ||
                props.status?.state === "unavailable"
              }
            >
              Restore incumbent
            </Button>
          ) : null}
          {props.onRotateToken ? (
            <Button
              variant="outline"
              className="h-8 rounded-full px-3 text-xs"
              onClick={() => setRotationConfirmOpen(true)}
              disabled={
                props.busy ||
                !props.status?.activeRoute ||
                props.status?.state === "blocked" ||
                props.status?.state === "unavailable"
              }
            >
              Rotate token
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmModal
        open={rollbackConfirmOpen}
        title="Restore the incumbent-only Haloop route?"
        message="This replaces the managed edge with the approved single Anthropic target and removes any candidate routing from the active registry. Existing tokens, agent sessions, traces, and the FUSE workspace are preserved. An in-flight model request may need to be retried during the brief edge restart."
        confirmLabel={props.busy ? "Restoring…" : "Restore incumbent"}
        cancelLabel={t("settings.environment.cancel")}
        variant="warning"
        confirmButtonVariant="primary"
        onConfirm={() => void restoreHaloopIncumbent()}
        onCancel={() => {
          if (!props.busy) setRollbackConfirmOpen(false);
        }}
      />

      <ConfirmModal
        open={rotationConfirmOpen}
        title="Rotate the scoped Haloop token?"
        message="This immediately invalidates the active sandbox route token and ends its in-app Claude/OpenClaw sessions. The FUSE workspace is preserved. Relaunch affected agents after rotation; any external agent terminal must also be closed and relaunched."
        confirmLabel={props.busy ? "Rotating…" : "Rotate token"}
        cancelLabel={t("settings.environment.cancel")}
        variant="warning"
        confirmButtonVariant="danger"
        onConfirm={() => void rotateHaloopToken()}
        onCancel={() => {
          if (!props.busy) setRotationConfirmOpen(false);
        }}
      />
    </div>
  );
}
