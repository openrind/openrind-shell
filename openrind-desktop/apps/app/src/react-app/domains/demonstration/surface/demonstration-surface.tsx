/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { CheckCircle2, Pause, Play, Square, Video } from "lucide-react";
import { Button } from "../../../design-system/button";

export type DemonstrationStatusPayload = {
  recording: boolean;
  session?: {
    taskTitle: string;
    projectId: string;
    startedAt: string;
    framesCount: number;
    isPaused: boolean;
  } | null;
  result?: {
    success: boolean;
    projectId: string;
    taskTitle: string;
    framesCount: number;
    actionsCount: number;
    transmitted: boolean;
  } | null;
};

export function DemonstrationSurface() {
  const [status, setStatus] = useState<DemonstrationStatusPayload | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const bridge = (window as any).__OPENRIND_DESKTOP_ELECTRON__;
    if (!bridge?.onDemonstrationStatusChange) return;

    const cleanup = bridge.onDemonstrationStatusChange((data: DemonstrationStatusPayload) => {
      setStatus(data);
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (!status?.recording || status?.session?.isPaused || !status?.session?.startedAt) {
      return;
    }
    const startMs = new Date(status.session.startedAt).getTime();
    const interval = setInterval(() => {
      const nowMs = Date.now();
      setElapsedSec(Math.max(0, Math.floor((nowMs - startMs) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [status?.recording, status?.session?.isPaused, status?.session?.startedAt]);

  if (!status?.recording && !status?.result) {
    return null;
  }

  const formatTimer = (sec: number) => {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  const handlePauseToggle = async () => {
    const bridge = (window as any).__OPENRIND_DESKTOP_ELECTRON__;
    if (!bridge?.invokeDesktop) return;
    if (status?.session?.isPaused) {
      await bridge.invokeDesktop("demonstrationRecordAction", { type: "resume" });
    } else {
      await bridge.invokeDesktop("demonstrationRecordAction", { type: "pause" });
    }
  };

  const handleFinish = async () => {
    const bridge = (window as any).__OPENRIND_DESKTOP_ELECTRON__;
    if (bridge?.invokeDesktop) {
      await bridge.invokeDesktop("demonstrationStop");
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center p-6 bg-dls-background text-dls-text">
      {status?.recording ? (
        <div className="w-full max-w-md rounded-2xl border border-dls-border bg-dls-surface p-7 shadow-xl text-center space-y-6">
          {/* Status Badge & Icon */}
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-500">
              <span className="relative flex h-2 w-2">
                {!status.session?.isPaused && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                )}
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              {status.session?.isPaused ? "RECORDING PAUSED" : "RECORDING TASK"}
            </div>

            <h2 className="text-lg font-bold text-dls-text truncate px-2">
              {status.session?.taskTitle || "Human Task Demonstration"}
            </h2>
            <p className="text-xs text-dls-secondary">
              Project: <span className="font-mono text-dls-text">{status.session?.projectId}</span>
            </p>
          </div>

          {/* Metrics Grid */}
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-dls-border bg-dls-background/50 p-4">
            <div className="text-center">
              <div className="text-2xl font-mono font-bold text-dls-text tracking-tight">
                {formatTimer(elapsedSec)}
              </div>
              <div className="text-[11px] text-dls-secondary font-medium mt-0.5">Duration</div>
            </div>
            <div className="text-center border-l border-dls-border/40">
              <div className="text-2xl font-mono font-bold text-dls-text tracking-tight">
                {status.session?.framesCount || 0}
              </div>
              <div className="text-[11px] text-dls-secondary font-medium mt-0.5">Frames</div>
            </div>
          </div>

          {/* Control Buttons */}
          <div className="flex items-center justify-center gap-2.5 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={handlePauseToggle}
              className="flex items-center gap-1.5 text-xs px-4 py-2"
            >
              {status.session?.isPaused ? (
                <>
                  <Play className="h-3.5 w-3.5 fill-current text-green-500" /> Resume
                </>
              ) : (
                <>
                  <Pause className="h-3.5 w-3.5 text-amber-500" /> Pause
                </>
              )}
            </Button>

            <Button
              type="button"
              onClick={handleFinish}
              className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-1.5 text-xs font-medium px-4 py-2"
            >
              <Square className="h-3.5 w-3.5 fill-current" /> Finish & Save
            </Button>
          </div>
        </div>
      ) : status?.result ? (
        <div className="w-full max-w-md rounded-2xl border border-dls-border bg-dls-surface p-7 shadow-xl text-center space-y-5">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-green-500/10 text-green-500">
            <CheckCircle2 className="h-6 w-6" />
          </div>

          <div>
            <h2 className="text-base font-bold text-dls-text">Demonstration Saved</h2>
            <p className="mt-1 text-xs text-dls-secondary">
              Committed under project <span className="font-mono text-dls-text">{status.result.projectId}</span>
            </p>
          </div>

          <div className="rounded-xl border border-dls-border bg-dls-background/50 p-4 space-y-2.5 text-xs text-left">
            <div className="flex justify-between items-center">
              <span className="text-dls-secondary">Task:</span>
              <span className="font-medium text-dls-text truncate max-w-[200px]">{status.result.taskTitle}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-dls-secondary">Frames:</span>
              <span className="font-mono font-medium text-dls-text">{status.result.framesCount}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-dls-secondary">Action Traces:</span>
              <span className="font-mono text-dls-text">Mouse (X, Y) Coordinates & Visual Observations</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-dls-secondary">Gateway Sync:</span>
              <span className="font-medium text-green-500">Transmitted</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => setStatus(null)}
            className="w-full text-xs"
          >
            Done & Back to Desktop
          </Button>
        </div>
      ) : null}
    </div>
  );
}
