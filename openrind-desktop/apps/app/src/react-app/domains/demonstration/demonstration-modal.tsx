/** @jsxImportSource react */
import { useState } from "react";
import { Monitor, Play, ShieldAlert, Sparkles, X } from "lucide-react";
import { Button } from "../../../design-system/button";

export type DemonstrationModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onStart: (opts: { taskTitle: string; scrubPii: boolean; captureIntervalMs: number }) => Promise<void>;
};

export function DemonstrationModal({ isOpen, onClose, onStart }: DemonstrationModalProps) {
  const [taskTitle, setTaskTitle] = useState("");
  const [scrubPii, setScrubPii] = useState(true);
  const [intervalSec, setIntervalSec] = useState("1.5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) {
      setError("Please specify a task demonstration title.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await onStart({
        taskTitle: taskTitle.trim(),
        scrubPii,
        captureIntervalMs: Math.round(parseFloat(intervalSec) * 1000) || 1500,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-2xl border border-dls-border bg-dls-surface p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
            <Monitor className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-dls-text">Record Task Demonstration</h2>
            <p className="text-xs text-dls-secondary">
              Capture human desktop workflows & actions for VLA / computer-use training
            </p>
          </div>
        </div>

        <form onSubmit={handleStart} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-dls-text">
              Task Title / Human Instruction <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="e.g., Invoice entry in Excel & email dispatch"
              className="mt-1 w-full rounded-xl border border-dls-border bg-dls-background px-3.5 py-2.5 text-sm text-dls-text placeholder:text-dls-secondary focus:border-red-500 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-dls-secondary">
              This instruction will name the project in Haloop and guide the demonstration trajectory.
            </p>
          </div>

          <div className="rounded-xl border border-dls-border bg-dls-hover/30 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-dls-text">Auto-Scrub PII & API Secrets</div>
                <div className="text-[11px] text-dls-secondary">
                  Redacts API tokens, emails, and passwords from captured text
                </div>
              </div>
              <input
                type="checkbox"
                checked={scrubPii}
                onChange={(e) => setScrubPii(e.target.checked)}
                className="h-4 w-4 rounded border-dls-border accent-red-500"
              />
            </div>

            <div className="flex items-center justify-between border-t border-dls-border/40 pt-2.5">
              <div>
                <div className="text-xs font-medium text-dls-text">Snapshot Sampling Rate</div>
                <div className="text-[11px] text-dls-secondary">
                  Adaptive frame rate (skips unchanged static frames)
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="5"
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(e.target.value)}
                  className="w-16 rounded-lg border border-dls-border bg-dls-background px-2 py-1 text-center text-xs text-dls-text"
                />
                <span className="text-xs text-dls-secondary">sec</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 flex gap-2.5">
            <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-[11px] text-amber-600 dark:text-amber-400">
              When started, Openrind Desktop will automatically minimize to your taskbar and display a floating recorder widget. The widget itself is protected from being recorded in your screen frames.
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/10 p-2.5 text-xs text-red-500">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
              className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-1.5"
            >
              <Play className="h-4 w-4 fill-current" />
              {loading ? "Starting..." : "Start Demonstration"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
