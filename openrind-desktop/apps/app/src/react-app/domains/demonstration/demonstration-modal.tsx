/** @jsxImportSource react */
import { useState } from "react";
import { Monitor, Play, ShieldAlert, X } from "lucide-react";
import { Button } from "../../design-system/button";

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
      setError("Please enter a task title.");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-md rounded-2xl border border-dls-border bg-dls-surface p-6 shadow-2xl space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
              <Monitor className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-dls-text">Record Task Demonstration</h2>
              <p className="text-xs text-dls-secondary mt-0.5">
                Capture desktop workflows for VLA dataset generation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleStart} className="space-y-5">
          {/* Title Input */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-dls-text">
              Task Instruction
            </label>
            <input
              type="text"
              required
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="e.g. Invoice entry in Excel & email dispatch"
              className="w-full rounded-xl border border-dls-border bg-dls-background px-3.5 py-2.5 text-xs text-dls-text placeholder:text-dls-secondary/60 focus:border-dls-secondary/50 focus:outline-none transition-colors"
            />
          </div>

          {/* Preferences Box */}
          <div className="rounded-xl border border-dls-border bg-dls-background/50 p-4 space-y-3.5 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium text-dls-text block">Auto-Scrub PII & Secrets</span>
                <span className="text-[11px] text-dls-secondary block mt-0.5">
                  Redacts API keys, tokens & emails
                </span>
              </div>
              <input
                type="checkbox"
                checked={scrubPii}
                onChange={(e) => setScrubPii(e.target.checked)}
                className="h-4 w-4 rounded border-dls-border accent-red-500 cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between border-t border-dls-border/40 pt-3">
              <div>
                <span className="font-medium text-dls-text block">Snapshot Frequency</span>
                <span className="text-[11px] text-dls-secondary block mt-0.5">
                  Skipping duplicate static frames
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="5"
                  value={intervalSec}
                  onChange={(e) => setIntervalSec(e.target.value)}
                  className="w-14 rounded-lg border border-dls-border bg-dls-background px-2 py-1 text-center font-mono text-xs text-dls-text focus:outline-none"
                />
                <span className="text-dls-secondary text-[11px]">sec</span>
              </div>
            </div>
          </div>

          {/* Info Banner */}
          <div className="rounded-xl bg-amber-500/10 p-3 flex gap-2.5 items-start">
            <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-amber-500/90">
              Openrind Desktop will minimize to your taskbar during capture. Use the protected floating widget to Pause or Finish.
            </p>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/10 p-2.5 text-xs text-red-500 font-medium">
              {error}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={loading}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading}
              className="bg-red-600 hover:bg-red-700 text-white flex items-center gap-2 text-xs font-medium px-4 py-2"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              {loading ? "Starting..." : "Start Demonstration"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
