/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Check, Circle, Monitor, Pause, Play, Square, Video } from "lucide-react";
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
    <div className="flex h-full w-full flex-col items-center justify-center p-6 text-dls-text select-none">
      {status?.recording ? (
        <div className="w-full max-w-sm rounded-xl border border-dls-border/60 bg-dls-surface p-6 shadow-lg text-center space-y-5">
          {/* Status Tag */}
          <div className="flex flex-col items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium tracking-wide uppercase bg-red-500/10 text-red-400 border border-red-500/20">
              <span className={`h-1.5 w-1.5 rounded-full bg-red-500 ${status.session?.isPaused ? "" : "animate-ping"}`} />
              {status.session?.isPaused ? "Paused" : "Recording"}
            </span>

            <h3 className="text-sm font-semibold text-dls-text truncate max-w-full px-2">
              {status.session?.taskTitle || "Human Task Demonstration"}
            </h3>
            <span className="text-[11px] font-mono text-dls-secondary">
              {status.session?.projectId}
            </span>
          </div>

          {/* Clean Counter Metrics */}
          <div className="flex items-center justify-around border-y border-dls-border/40 py-3 text-center">
            <div>
              <div className="text-xl font-mono font-semibold text-dls-text tracking-tight">
                {formatTimer(elapsedSec)}
              </div>
              <div className="text-[10px] text-dls-secondary uppercase tracking-wider mt-0.5">Duration</div>
            </div>
            <div className="h-6 w-px bg-dls-border/40" />
            <div>
              <div className="text-xl font-mono font-semibold text-dls-text tracking-tight">
                {status.session?.framesCount || 0}
              </div>
              <div className="text-[10px] text-dls-secondary uppercase tracking-wider mt-0.5">Frames</div>
            </div>
          </div>

          {/* Compact Control Row */}
          <div className="flex items-center justify-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={handlePauseToggle}
              className="flex items-center gap-1.5 text-xs h-8 px-3.5 border-dls-border/80"
            >
              {status.session?.isPaused ? (
                <>
                  <Play className="h-3 w-3 fill-current text-green-500" /> Resume
                </>
              ) : (
                <>
                  <Pause className="h-3 w-3 text-amber-500" /> Pause
                </>
              )}
            </Button>

            <Button
              type="button"
              onClick={handleFinish}
              className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-1.5 text-xs font-medium h-8 px-3.5"
            >
              <Square className="h-3 w-3 fill-current" /> Finish & Save
            </Button>
          </div>
        </div>
      ) : status?.result ? (
        <div className="w-full max-w-sm rounded-xl border border-dls-border/60 bg-dls-surface p-6 shadow-lg text-center space-y-5 animate-in fade-in duration-150">
          {/* Subtle Success Check */}
          <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <Check className="h-4 w-4 stroke-[2.5]" />
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-dls-text">Demonstration Saved</h3>
            <p className="text-[11px] font-mono text-dls-secondary">
              {status.result.projectId}
            </p>
          </div>

          {/* Minimal Key-Value Details */}
          <div className="rounded-lg bg-dls-background/40 p-3 space-y-2 text-xs border border-dls-border/40 text-left">
            <div className="flex justify-between items-center text-dls-secondary">
              <span>Task</span>
              <span className="font-medium text-dls-text truncate max-w-[170px]">{status.result.taskTitle}</span>
            </div>
            <div className="flex justify-between items-center text-dls-secondary">
              <span>Captured Frames</span>
              <span className="font-mono font-medium text-dls-text">{status.result.framesCount}</span>
            </div>
            <div className="flex justify-between items-center text-dls-secondary">
              <span>Attribution</span>
              <span className="font-medium text-dls-text">Mouse & Screen Trajectory</span>
            </div>
            <div className="flex justify-between items-center text-dls-secondary">
              <span>Sync</span>
              <span className="font-medium text-emerald-400">Committed to Haloop</span>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => setStatus(null)}
            className="w-full text-xs h-8 border-dls-border/80"
          >
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}
