/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RotateCcw,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";

// REQUIRED, not cosmetic. Every bit of xterm's layout lives in this stylesheet:
// `.xterm` gets `position: relative`, `.xterm-helpers` gets `position:
// absolute`, and `.xterm-screen canvas` / the row spans get absolute
// positioning. Without it the helper <textarea> renders inline as a visible
// resize handle in the corner and the row/canvas layers collapse out of place,
// so the pane paints NOTHING — a silent, total failure that looks exactly like a
// broken terminal emulator rather than a missing import. Do not remove this, and
// do not assume a bundler will pick it up on its own.
import "@xterm/xterm/css/xterm.css";

import type { SandboxProfile } from "../../../../app/lib/desktop";
import { Button } from "../../../design-system/button";
import { useVoiceInput } from "./composer/voice/use-voice-input";
import { formatBytes } from "../../../../app/utils";
import { useStatusToasts } from "../../shell-feedback/status-toasts";
import { BrowserPanel, useBrowserStore } from "../../browser";

// Shared flat toolbar button, matching the bottom status bar items (Docs, Feedback)
// so the title bar toolbar reads with the exact same styling, colors, and font sizing.
const TOOLBAR_BTN =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60";

// The PTY connects (phase "connected") well before the agent's TUI actually
// paints — setup.sh runs its DB restore/flush silently, then Claude/OpenClaw
// initialize, which can take tens of seconds. Rather than flash a blank
// terminal in that gap, we keep the bootstrap overlay up until the agent has
// emitted a real render: a burst of output (≥ MIN bytes) that then goes quiet
// (SETTLE) — or a hard cap so we never hang the overlay forever. A tiny early
// paint (e.g. just the empty composer box) stays under MIN, so the overlay
// waits for the full UI.
const AGENT_PAINT_MIN_BYTES = 512;
const AGENT_PAINT_SETTLE_MS = 700;
const AGENT_PAINT_CAP_MS = 20_000;

// Flow control. term.write() is asynchronous — xterm.js queues the chunk and
// parses it on a later task — so an agent that floods output (streaming a long
// diff, a `find /`, a repainting spinner) can enqueue far more than the parser
// drains. Unbounded, that queue is what turns into multi-second input lag and
// half-painted frames. So we count unparsed chars and, above the high water
// mark, apply REAL backpressure at the source (stop draining the bridge's
// stdout in the main process) until the queue falls back below the low mark.
// Two marks rather than one so we don't thrash pause/resume on every chunk.
const FLOW_HIGH_WATER_CHARS = 200_000;
const FLOW_LOW_WATER_CHARS = 50_000;

// xterm.js is loaded dynamically so it doesn't bloat the workspace
// dashboard bundle for users who never open an Openrind Shell session.
type TerminalType = import("@xterm/xterm").Terminal;
type FitAddonType = import("@xterm/addon-fit").FitAddon;
type WebglAddonType = import("@xterm/addon-webgl").WebglAddon;
type WebglAddonCtor = typeof import("@xterm/addon-webgl").WebglAddon;

/**
 * Resolve the Unicode width provider for a new Terminal.
 *
 * An agent's TUI lays each frame out against the widths ITS measuring library
 * reports, and xterm has to agree cell-for-cell or the cursor drifts and glyphs
 * strand. xterm defaults to Unicode 6, where most modern emoji measure as width
 * 1 — that mismatch is what garbled the banner line and left stray emoji /
 * number glyphs at the top of the pane.
 *
 * Claude Code's Ink measures with string-width, which does full GRAPHEME
 * CLUSTERING: ZWJ sequences, VS16 presentation selectors, combining marks and
 * regional-indicator flag pairs each occupy exactly one cell.
 * addon-unicode11 only corrects the wcwidth tables, so those clusters still
 * measured wide; addon-unicode-graphemes is the superset that handles both and
 * self-selects its own activeVersion ("15-graphemes").
 *
 * The graphemes addon is flagged experimental upstream, so unicode11 stays as
 * the degraded path — partially-correct widths beat no width fix at all.
 *
 * @returns the addon plus the activeVersion to force, or null to let the addon
 *   choose (the graphemes addon sets its own).
 */
async function loadUnicodeAddon(): Promise<{
  addon: import("@xterm/xterm").ITerminalAddon;
  activeVersion: string | null;
}> {
  try {
    const { UnicodeGraphemesAddon } = await import(
      "@xterm/addon-unicode-graphemes"
    );
    return { addon: new UnicodeGraphemesAddon(), activeVersion: null };
  } catch {
    const { Unicode11Addon } = await import("@xterm/addon-unicode11");
    return { addon: new Unicode11Addon(), activeVersion: "11" };
  }
}

/**
 * Resolve the WebGL renderer addon's constructor, or null if the chunk can't be
 * loaded at all. A null result means the terminal keeps xterm's default DOM
 * renderer; whether WebGL2 actually initialises is only known once the addon is
 * loaded into a Terminal, so that failure is handled at the call site.
 */
async function loadWebglAddonCtor(): Promise<WebglAddonCtor | null> {
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    return WebglAddon;
  } catch {
    return null;
  }
}

/**
 * Verify xterm's stylesheet actually reached the document.
 *
 * A missing `@xterm/xterm/css/xterm.css` is indistinguishable from a broken
 * terminal emulator: the pane is blank, with a stray resize handle in the
 * corner where the unpositioned helper <textarea> landed. There is no error, no
 * exception and no failed request — just a black box. Since that is exactly the
 * kind of bug that gets misdiagnosed as "xterm.js can't render TUIs", assert it
 * at runtime instead of trusting the import to survive future refactors.
 *
 * `position: absolute` on the helper textarea comes only from the stylesheet, so
 * it is a reliable sentinel.
 */
function assertXtermStylesLoaded(term: TerminalType): boolean {
  try {
    const helper = term.element?.querySelector(".xterm-helper-textarea");
    if (!helper) return false;
    if (getComputedStyle(helper).position === "absolute") return true;
  } catch {
    return false;
  }
  console.error(
    "[openrindShellTerminal] xterm stylesheet is NOT loaded. The terminal will " +
      'render blank. Restore `import "@xterm/xterm/css/xterm.css"` in ' +
      "openrind-shell-terminal.tsx.",
  );
  return false;
}

/** Which renderer the terminal should try. See RENDERER_PREF_KEY. */
type RendererPreference = "auto" | "webgl" | "dom";

/**
 * Kill switch for the terminal renderer, readable and writable from DevTools so
 * a machine whose GPU stack paints nothing can be recovered WITHOUT a rebuild:
 *
 *   localStorage.setItem("openrind-shell:renderer", "dom");  // then reconnect
 *
 * "auto" (default) uses WebGL only when probeWebgl2() clears it; "webgl" forces
 * it past the probe; "dom" pins xterm's DOM renderer.
 */
const RENDERER_PREF_KEY = "openrind-shell:renderer";

function readRendererPreference(): RendererPreference {
  try {
    const raw = localStorage.getItem(RENDERER_PREF_KEY);
    if (raw === "webgl" || raw === "dom" || raw === "auto") return raw;
  } catch {
    // localStorage blocked — fall through to the default.
  }
  return "auto";
}

/**
 * Pre-flight WebGL2 check, run on a THROWAWAY canvas.
 *
 * The xterm WebGL addon reports genuine context loss via onContextLoss, but it
 * has no signal for "initialised and then quietly painted nothing" — which is
 * what a blank terminal pane looks like. Probing a scratch canvas first means a
 * hostile GPU stack is detected before the real terminal is ever handed to the
 * addon, so the failure mode is a DOM-rendered terminal rather than a black box.
 */
function probeWebgl2(): { ok: boolean; reason: string } {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const gl = canvas.getContext("webgl2");
    if (!gl) return { ok: false, reason: "no webgl2 context" };
    if (gl.isContextLost()) return { ok: false, reason: "context lost on creation" };
    // A software rasteriser makes the GPU renderer slower than the DOM one and,
    // on some Windows/RDP/VM stacks, produces no visible output at all. The
    // debug extension is not always exposed; an unknown renderer is allowed
    // through rather than treated as a failure.
    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
    const name = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
      : "";
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) {
      return { ok: false, reason: `software renderer (${name})` };
    }
    // Release the probe context immediately; browsers cap live WebGL contexts
    // and the terminal needs one of its own.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: true, reason: name || "webgl2" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "probe threw",
    };
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
  }
}

type ElectronBridge = NonNullable<Window["__OPENRIND_DESKTOP_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__ ?? null;
}

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const bridge = getBridge();
  if (!bridge?.invokeDesktop) {
    throw new Error("Electron desktop bridge is not available.");
  }
  return (await bridge.invokeDesktop(command, ...args)) as T;
}

export type OpenrindShellTerminalProps = {
   workspaceId: string;
  profile: SandboxProfile;
  /** Optional agent conversation binding. When set, the launched agent is
   *  bound to this id (Claude Code `--session-id`/`--resume`, OpenClaw
   *  `--session`) and the PTY registry keys on (sandbox, sessionId) —
   *  sessions are CONCURRENT, so other conversations' PTYs keep working
   *  while this one is shown. Null/undefined ⇒ the sandbox's default
   *  conversation (the sidebar Sandboxes entries use this). */
  sessionId?: string | null;
  /** Optional callback when the renderer decides to fully tear down the
   *  workspace (clicked "Delete sandbox" + confirmed). Caller is
   *  responsible for navigating away. */
  onSandboxDeleted?: () => void;
  /** Optional callback to route the user to Settings when the bootstrap
   *  fails. Credential errors (DATABASE_URL / ANTHROPIC_API_KEY) target the
   *  Environment page where the sandbox keys are managed; infrastructure
   *  errors (gateway / installer) target the Sandbox page. */
  onOpenSettings?: (target: "environment" | "sandbox") => void;
  /** When provided, a "Chat" button appears in the toolbar letting the
   *  user switch back to the regular Openrind Desktop chat UI. The PTY session
   *  ends but the sandbox persists — switching back to Terminal reconnects. */
  onSwitchToChat?: () => void;
  /** When provided, called after the user commits a display-label rename.
   *  The settings TestLaunchPanel uses this to stop the current session and
   *  update the workspace ID so the next "Launch session" connects to a
   *  fresh sandbox with the new name. In the main session view this prop is
   *  NOT passed — the rename is cosmetic (localStorage) only. */
  onRenameCommit?: (newName: string) => void;
};

type Phase =
  | "starting"
  | "ensuring-sandbox"
  | "mounting-terminal"
  | "connecting-pty"
  | "connected"
  | "exited"
  | "error";

type SandboxWorkspaceFile = {
  name: string;
  path: string;
  size: number;
  modifiedAt: number;
};

type BootstrapProgressEvent = {
  phase: string;
  message: string;
  timestamp: number;
};

/**
 * Mirrors deriveOpenrindShellSandboxName() in openrind-shell-terminal.mjs.
 * Used to pre-populate lastKnownSandboxNameRef so deleteAndReconnect can
 * delete a broken sandbox even when openrindEnsureSandbox throws before
 * returning (i.e. before setSandboxName is ever called).
 */
function deriveExpectedSandboxName(workspaceId: string): string {
  if (/^or-(?:[a-z0-9-]{1,7}-[a-f0-9]{8}|[a-z0-9-]{1,8}-[a-f0-9]{7})$/.test(workspaceId)) {
    return workspaceId;
  }
  const trimmed = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `openrind-shell-${trimmed}`;
}

export function OpenrindShellTerminal(props: OpenrindShellTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalType | null>(null);
  const fitRef = useRef<FitAddonType | null>(null);
  // Null whenever the GPU renderer isn't active: WebGL2 unavailable at mount,
  // or the context was lost later and we fell back to the DOM renderer.
  const webglRef = useRef<WebglAddonType | null>(null);
  // Which renderer actually ended up painting, for the status tooltip and the
  // raw-stream capture notice — a bug report about a blank or torn pane is
  // near-useless without it.
  const rendererRef = useRef<string>("dom");
  const sessionIdRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Flow control bookkeeping (see FLOW_*): chars handed to term.write() that
  // xterm hasn't parsed yet, and whether we've asked main to stop draining.
  const unprocessedRef = useRef(0);
  const flowPausedRef = useRef(false);
  // Persists the last successfully resolved sandbox name so that the
  // "Delete sandbox" and "Pop out" buttons remain functional even when
  // sandboxName state is null (e.g. after an error before first connect).
  const lastKnownSandboxNameRef = useRef<string | null>(null);
  // Buffer to hold PTY bytes that arrive before xterm.js finishes
  // mounting and the data subscription is set up.
  const earlyBufferRef = useRef<string[]>([]);
  // True when the current unmount is an explicit "end session" / delete
  // (kill the PTY) rather than navigation (detach + keep the PTY alive so
  // returning replays the buffer). cleanup() reads this to choose between
  // openrindPtyDetach and openrindPtyClose.
  const explicitEndRef = useRef(false);
  // Paint tracking for the "keep the overlay up until the agent renders" gate.
  // trackPaintRef is armed only on a fresh open; bytes accumulate until the
  // settle timer (or the cap timer) marks the agent ready.
  const trackPaintRef = useRef(false);
  const paintBytesRef = useRef(0);
  const paintSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paintCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sandboxName, setSandboxName] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  // True only while a FIRST-TIME bootstrap is running (image pull / sandbox
  // create / fresh connect). A lossless re-attach to an already-running PTY
  // leaves this false so the 3-step bootstrap overlay never flashes.
  const [isFreshBootstrap, setIsFreshBootstrap] = useState(false);
  // On a fresh bootstrap, gates the overlay: stays true until the agent's TUI
  // has actually painted (see AGENT_PAINT_* + the paint tracking in the run
  // effect). Prevents the ~30s blank-terminal gap between PTY-connect and the
  // agent rendering.
  const [agentReady, setAgentReady] = useState(false);
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);
  const [bootstrapEvents, setBootstrapEvents] = useState<BootstrapProgressEvent[]>([]);
  const [bootstrapStartedAt, setBootstrapStartedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [popoutBusy, setPopoutBusy] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filesRequestRef = useRef(0);
  const [uploadBusy, setUploadBusy] = useState(false);
  const { showToast } = useStatusToasts();
  const [sandboxFiles, setSandboxFiles] = useState<SandboxWorkspaceFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);

  useEffect(() => {
    filesRequestRef.current += 1;
    setSandboxFiles([]);
    setFilesLoading(false);
    setFilesError(null);
  }, [props.workspaceId]);

  const refreshSandboxFiles = useCallback(async () => {
    const effectiveName = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!effectiveName) return;
    const requestId = ++filesRequestRef.current;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const files = await invoke<SandboxWorkspaceFile[]>(
        "openrindShellListFiles",
        effectiveName,
      );
      if (requestId === filesRequestRef.current) {
        setSandboxFiles(files);
      }
    } catch (error) {
      if (requestId === filesRequestRef.current) {
        setFilesError(
          error instanceof Error ? error.message : "Could not read sandbox files.",
        );
      }
    } finally {
      if (requestId === filesRequestRef.current) {
        setFilesLoading(false);
      }
    }
  }, [sandboxName]);

  useEffect(() => {
    if (phase === "connected") {
      void refreshSandboxFiles();
    }
  }, [phase, refreshSandboxFiles]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const effectiveName = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!effectiveName) return;

    setUploadBusy(true);
    const uploadedNames: string[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        await new Promise<void>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const base64 = (reader.result as string).split(",")[1] ?? "";
              await invoke("openrindShellUpload", effectiveName, base64, file.name);
              uploadedNames.push(file.name);
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      }
      
      const summary = uploadedNames.join(", ");
      showToast({
        title: uploadedNames.length === 1 ? `Uploaded ${uploadedNames[0]} to the shared folder.` : `Uploaded ${uploadedNames.length} files to the shared folder.`,
        description: uploadedNames.length > 1 ? summary : undefined,
        tone: "success",
      });
      
    } catch (err) {
      console.error("Upload failed", err);
      if (uploadedNames.length > 0) {
        showToast({
          title: `Upload partially failed`,
          description: `Successfully uploaded ${uploadedNames.length} file(s), but a subsequent file failed.`,
          tone: "warning",
        });
      } else {
        showToast({
          title: err instanceof Error ? err.message : "Upload failed",
          tone: "warning",
        });
      }
    } finally {
      await refreshSandboxFiles();
      setUploadBusy(false);
      // Reset input so the same file can be uploaded again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [refreshSandboxFiles, sandboxName, showToast]);

  const removeUploadedFile = useCallback(async (filename: string): Promise<boolean> => {
    const effectiveName = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!effectiveName) return false;
    try {
      await invoke("openrindShellDeleteFile", effectiveName, filename);
      setSandboxFiles((current) => current.filter((file) => file.name !== filename));
      await refreshSandboxFiles();
      showToast({
        title: `Removed ${filename} from sandbox`,
        tone: "success",
      });
      return true;
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Failed to remove file",
        tone: "warning",
      });
      return false;
    }
  }, [refreshSandboxFiles, sandboxName, showToast]);

  const downloadSandboxFile = useCallback(async (file: SandboxWorkspaceFile) => {
    const effectiveName = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!effectiveName || downloadingFile) return;

    setDownloadingFile(file.name);
    try {
      const result = await invoke<{ canceled: boolean; path?: string }>(
        "openrindShellDownloadFile",
        effectiveName,
        file.name,
      );
      if (result.canceled) return;
      showToast({
        title: `Downloaded ${file.name}`,
        description: result.path,
        tone: "success",
      });
    } catch (err) {
      showToast({
        title: err instanceof Error ? err.message : "Failed to download file",
        tone: "warning",
      });
    } finally {
      setDownloadingFile(null);
    }
  }, [downloadingFile, sandboxName, showToast]);

  // Overflow ("⋮") menu for secondary/management actions, so the main toolbar
  // stays to its essentials.
  const [filesModalOpen, setFilesModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!filesModalOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilesModalOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [filesModalOpen]);

  // User-editable display name for the sandbox. The actual sandbox name
  // used by openshell never changes — this is purely cosmetic.
  const [displayName, setDisplayName] = useState<string>("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  // Derived sandbox name from workspaceId — available immediately without
  // waiting for openrindEnsureSandbox to return. Shown in the header from
  // the very first render so the user never sees "(no sandbox)".
  const [expectedSandboxName, setExpectedSandboxName] = useState<string>(() =>
    deriveExpectedSandboxName(props.workspaceId)
  );

  useEffect(() => {
    let cancelled = false;
    invoke<string>(
      "openrindDeriveSandboxName",
      props.workspaceId
    ).then((name) => {
      if (!cancelled && typeof name === "string" && name) {
        setExpectedSandboxName(name);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId]);

  // Stable callback for "reconnect" so the user can rebuild a dead PTY
  // without rerendering the whole component.
  const [reconnectKey, setReconnectKey] = useState(0);
  const reconnect = useCallback(() => setReconnectKey((k) => k + 1), []);

  // True when the user deliberately cancelled a provisioning operation.
  // While true, run() exits immediately to "exited" phase so the spinner
  // disappears. handleLaunch clears this flag and increments reconnectKey.
  const [userAborted, setUserAborted] = useState(false);
  const lastAbortedWorkspaceRef = useRef<string | null>(null);

  const handleAbort = useCallback(() => {
    lastAbortedWorkspaceRef.current = props.workspaceId;
    setUserAborted(true);
    setReconnectKey((k) => k + 1); // triggers cleanup of the current run()
  }, [props.workspaceId]);

  const handleLaunch = useCallback(() => {
    setUserAborted(false);
    lastAbortedWorkspaceRef.current = null;
    explicitEndRef.current = false;
    // Close any stale (likely exited) session first so the next run()'s probe
    // doesn't re-attach to the corpse — we want a genuinely fresh connect.
    const staleId = sessionIdRef.current;
    sessionIdRef.current = null;
    void (async () => {
      if (staleId) {
        try {
          await invoke("openrindPtyClose", staleId);
        } catch {
          // Best-effort — a fresh bootstrap recovers regardless.
        }
      }
      setReconnectKey((k) => k + 1);
    })();
  }, []);



  // Track whether this component has ever reached "connected" phase so we
  // can show "Launch session" on first open vs "Reconnect" after a drop.
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const browser = useBrowserStore(props.sessionId || sandboxName || expectedSandboxName || "default_sandbox");

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    }, 50);
    return () => clearTimeout(timer);
  }, [browserOpen]);

  // True when the current error message means the sandbox must be deleted
  // before a retry can succeed (stuck-provisioning or container error state).
  // Used to make the toolbar button call deleteAndReconnect instead of reconnect
  // so the broken sandbox is removed even if the user skips the error card.
  const errorNeedsDelete = Boolean(
    errorMessage &&
    (/STUCK_PROVISIONING:/i.test(errorMessage) ||
      /is in error state/i.test(errorMessage)),
  );

  // Load/persist the user-facing display name from localStorage.
  // Uses sandboxName (confirmed by backend) when available, falls back to
  // expectedSandboxName (derived from workspaceId) so the header is
  // populated from first render instead of showing "(no sandbox)".
  useEffect(() => {
    const name = sandboxName ?? expectedSandboxName;
    const stored = localStorage.getItem(`openrind-shell-display:${name}`);
    setDisplayName(stored ?? name);
  }, [sandboxName, expectedSandboxName]);

  const commitRename = useCallback(() => {
    const effectiveName = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!effectiveName) return;
    const trimmed = renameValue.trim();
    const next = trimmed || effectiveName;
    if (trimmed)
      localStorage.setItem(`openrind-shell-display:${effectiveName}`, trimmed);
    else localStorage.removeItem(`openrind-shell-display:${effectiveName}`);
    setDisplayName(next);
    setIsRenaming(false);
    // Clear any stale error so the error card doesn't linger after a rename.
    setErrorMessage(null);
    setPhase((prev) => (prev === "error" ? "exited" : prev));
    // If onRenameCommit is provided (settings TestLaunchPanel), calling it
    // will stop the current session and swap the workspace ID — reset
    // hasEverConnected so the button reads "Launch session" for the new
    // workspace. In the main session view (no prop), the rename is cosmetic
    // only and the button correctly stays "Reconnect" for the same sandbox.
    if (trimmed && props.onRenameCommit) {
      setHasEverConnected(false);
      props.onRenameCommit(trimmed);
    }
  }, [sandboxName, renameValue, props.onRenameCommit]);

  // Mark first successful connection and auto-focus the terminal so the
  // user can type immediately without having to click.
  useEffect(() => {
    if (phase !== "connected") return;
    // During a fresh launch the bootstrap overlay still owns focus after the
    // PTY connects. Focus again when the first agent paint (or its UI cap)
    // removes that overlay; otherwise Claude's visible first-run prompt looks
    // unresponsive until the user deliberately refocuses xterm.
    if (isFreshBootstrap && !agentReady) return;
    setHasEverConnected(true);
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus();
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [phase, isFreshBootstrap, agentReady]);

  useEffect(() => {
    let cancelled = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubProgress: (() => void) | undefined;

    // Self-heal a GPU renderer that activated cleanly but is not actually
    // drawing. probeWebgl2() catches a hostile GPU stack up front, but a driver
    // can still pass every capability check and then paint nothing — which
    // presents as a completely blank pane, the worst outcome of the whole
    // renderer change.
    //
    // The addon rasterises glyphs into a texture atlas on its first real paint,
    // so once the agent has painted a full screen with no atlas in existence,
    // the canvas is not being drawn to. Drop to the DOM renderer and repaint.
    // A false positive here just costs GPU acceleration; a false negative costs
    // the user their entire terminal, so this errs toward falling back.
    const verifyRendererPainted = () => {
      const term = termRef.current;
      const webgl = webglRef.current;
      if (!term || !webgl) return;
      if (webgl.textureAtlas) return;
      try {
        webgl.dispose();
      } catch {
        // Already gone.
      }
      webglRef.current = null;
      rendererRef.current = "dom (webgl drew nothing)";
      console.warn(
        "[openrindShellTerminal] WebGL renderer produced no glyphs — fell back to the DOM renderer.",
      );
      try {
        term.refresh(0, term.rows - 1);
      } catch {
        // Disposed mid-check.
      }
    };

    // Mark the agent's UI as painted: tear down paint tracking + reveal the
    // terminal by hiding the bootstrap overlay. Idempotent.
    const markAgentReady = () => {
      if (!trackPaintRef.current) return;
      trackPaintRef.current = false;
      verifyRendererPainted();
      if (paintSettleTimerRef.current) {
        clearTimeout(paintSettleTimerRef.current);
        paintSettleTimerRef.current = null;
      }
      if (paintCapTimerRef.current) {
        clearTimeout(paintCapTimerRef.current);
        paintCapTimerRef.current = null;
      }
      setAgentReady(true);
    };

    // Bridge readiness is authoritative. Claude can legitimately spend longer
    // than this UI cap loading persisted state, so quiet output is not a PTY
    // error and must not be injected into the agent's terminal byte stream.
    const markAgentReadyOnPaintTimeout = () => {
      if (!trackPaintRef.current) return;
      markAgentReady();
    };

    // ── Flow control (see FLOW_* constants) ───────────────────────────────
    // Applied at the SOURCE rather than by buffering here: pausing the bridge's
    // stdout in the main process propagates all the way back to the agent's
    // write() into the container PTY, so the agent throttles itself instead of
    // us accumulating its backlog in the renderer.
    const maybePauseFlow = () => {
      if (flowPausedRef.current) return;
      if (unprocessedRef.current < FLOW_HIGH_WATER_CHARS) return;
      const id = sessionIdRef.current;
      if (!id) return;
      flowPausedRef.current = true;
      void invoke("openrindPtyPause", id).catch(() => {
        // Pause never landed, so the stream is still flowing — clear the flag
        // rather than sit in a "paused" state nothing will ever resume from.
        flowPausedRef.current = false;
      });
    };

    const maybeResumeFlow = () => {
      if (!flowPausedRef.current) return;
      if (unprocessedRef.current > FLOW_LOW_WATER_CHARS) return;
      flowPausedRef.current = false;
      const id = sessionIdRef.current;
      if (!id) return;
      void invoke("openrindPtyResume", id).catch(() => {
        // Best-effort: main also resumes on detach, so a dropped resume can't
        // wedge the session permanently.
      });
    };

    // Every STREAMING chunk reaches xterm through here, so the accounting can't
    // be bypassed: count the chunk as in-flight until xterm's write callback
    // confirms it has been PARSED (not merely queued), then re-check the low
    // water mark.
    //
    // The one deliberate exception is the buffered-replay write on the attach
    // path. It is fully awaited before anything else proceeds, so it cannot
    // grow the queue the way live data can, and it runs after sessionIdRef is
    // set but before openrindPtyAttach — counting it would fire a pause/resume
    // pair at a session that is not streaming yet.
    const writeCounted = (
      term: TerminalType,
      data: string,
      onParsed?: () => void,
    ) => {
      unprocessedRef.current += data.length;
      term.write(data, () => {
        unprocessedRef.current -= data.length;
        maybeResumeFlow();
        onParsed?.();
      });
      maybePauseFlow();
    };

    // Drain the chunks that arrived before xterm existed.
    //
    // These have to go through writeCounted like live data does. Writing them
    // straight to term.write() left a pre-ready burst — which is exactly when
    // the biggest one arrives, the agent's first full-screen paint plus any
    // replayed buffer — parsed with no backpressure at all, recreating the lag
    // the flow control exists to remove.
    //
    // Paint bytes are deliberately NOT re-counted: writeToTerm already counted
    // them when the chunk was buffered, and counting again would double every
    // pre-ready byte and trip the agent-ready heuristic early.
    //
    // Resolves once every flushed chunk has been parsed, so callers that resize
    // afterwards don't re-wrap a replay that is still queued (same reason the
    // buffered-replay write above is awaited).
    const flushEarlyBuffer = (term: TerminalType) => {
      const chunks = earlyBufferRef.current;
      if (chunks.length === 0) return Promise.resolve();
      // Take the chunks and swap in a fresh array. Nothing can interleave
      // between the two (single-threaded), so no chunk is dropped or written
      // twice, and anything that arrives during the flush goes straight to the
      // terminal (callers set termRef first) and lands after these in xterm's
      // FIFO write queue.
      earlyBufferRef.current = [];
      return new Promise<void>((resolve) => {
        let pending = chunks.length;
        for (const chunk of chunks) {
          writeCounted(term, chunk, () => {
            pending -= 1;
            if (pending === 0) resolve();
          });
        }
      });
    };

    const writeToTerm = (data: string) => {
      if (termRef.current) {
        writeCounted(termRef.current, data);
      } else {
        earlyBufferRef.current.push(data);
      }
      // While waiting for the agent to paint (fresh open only), accumulate
      // output bytes; once a real render burst (≥ MIN) settles, reveal the
      // terminal. A tiny early paint stays under MIN so the overlay waits for
      // the full UI instead of flashing a half-drawn screen.
      if (trackPaintRef.current) {
        paintBytesRef.current += data.length;
        if (paintBytesRef.current >= AGENT_PAINT_MIN_BYTES) {
          if (paintSettleTimerRef.current) {
            clearTimeout(paintSettleTimerRef.current);
          }
          paintSettleTimerRef.current = setTimeout(
            markAgentReady,
            AGENT_PAINT_SETTLE_MS,
          );
        }
      }
    };

    const cleanup = async () => {
      cancelled = true;
      unsubData?.();
      unsubExit?.();
      unsubProgress?.();
      trackPaintRef.current = false;
      if (paintSettleTimerRef.current) {
        clearTimeout(paintSettleTimerRef.current);
        paintSettleTimerRef.current = null;
      }
      if (paintCapTimerRef.current) {
        clearTimeout(paintCapTimerRef.current);
        paintCapTimerRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      // Reset flow-control state so a remount starts with an empty queue. The
      // main process resumes the stream itself on detach/attach, so there is no
      // need to round-trip a resume here on the way out.
      unprocessedRef.current = 0;
      flowPausedRef.current = false;
      if (sessionIdRef.current) {
        const id = sessionIdRef.current;
        sessionIdRef.current = null;
        try {
          // Navigation (workspace switch, route change, switch-to-chat) ⇒
          // DETACH: keep the wsl child + output buffer alive in main so the
          // next mount replays the scrollback instantly. Only an explicit
          // end/delete CLOSES (kills) the PTY.
          await invoke(
            explicitEndRef.current ? "openrindPtyClose" : "openrindPtyDetach",
            id,
          );
        } catch {
          // Best-effort.
        }
      }
      // Dispose the GPU renderer before the terminal so its WebGL context and
      // texture atlas are released deterministically rather than on GC.
      try {
        webglRef.current?.dispose();
      } catch {
        // Context may already be gone.
      }
      webglRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      earlyBufferRef.current = [];
    };

    const run = async () => {
      try {
        // If the user deliberately cancelled the previous provisioning attempt
        // for this same workspace, stay in "exited" state and do nothing — the
        // handleLaunch callback will reset userAborted + increment reconnectKey
        // to start a fresh run when the user explicitly clicks "Launch session".
        if (
          userAborted &&
          lastAbortedWorkspaceRef.current === props.workspaceId
        ) {
          setPhase("exited");
          return;
        }

        // Pre-populate the sandbox name ref from the workspace ID so that
        // deleteAndReconnect can delete a broken sandbox even when
        // openrindEnsureSandbox throws before returning (sandbox in error
        // state, stuck-provisioning, etc.) — i.e. before setSandboxName
        // is ever called. Only set if not already known from a prior run.
        const authoritativeName = await invoke<string>(
          "openrindDeriveSandboxName",
          props.workspaceId,
        );
        if (!lastKnownSandboxNameRef.current) {
          lastKnownSandboxNameRef.current = authoritativeName;
        }

        // 0. Subscribe to bootstrap progress events BEFORE calling
        // openrindEnsureSandbox so the founder sees the pull / stage /
        // create phases stream in. The session-progress channel is the
        // same one Phase O4's TestLaunchPanel uses.
        const bridge = getBridge();
        // Clear any stale message from a previous run so polling messages
        // ("Sandbox is Provisioning, waiting…") are visible instead of
        // being hidden behind a stale "ready" message.
        setBootstrapMessage(null);
        const bootstrapStartedAt = Date.now();
        setBootstrapStartedAt(bootstrapStartedAt);
        setBootstrapEvents([{
          phase: "starting",
          message: "Preparing the Openrind Shell launch plan...",
          timestamp: bootstrapStartedAt,
        }]);
        // Reset per-run so switching between two Openrind Shell workspaces (the
        // component stays mounted, only props change) doesn't carry the prior
        // workspace's bootstrap flag into a lossless re-attach. The fresh
        // branch sets it true again only when there is no live session.
        setIsFreshBootstrap(false);
        // Reset the agent-paint gate per run (see AGENT_PAINT_*).
        setAgentReady(false);
        trackPaintRef.current = false;
        paintBytesRef.current = 0;
        if (paintSettleTimerRef.current) {
          clearTimeout(paintSettleTimerRef.current);
          paintSettleTimerRef.current = null;
        }
        if (paintCapTimerRef.current) {
          clearTimeout(paintCapTimerRef.current);
          paintCapTimerRef.current = null;
        }
        unsubProgress = bridge?.openrindShell?.onSessionProgress?.((evt) => {
          if (cancelled) return;
          // Progress is broadcast by Electron because provisioning outlives any
          // one renderer view. Ignore activity from sandboxes that are running
          // concurrently after the user switches sessions.
          if (evt.sandboxName && evt.sandboxName !== authoritativeName) return;
          const message = String(evt.message ?? "").trim();
          if (!message) return;
          const timestamp = Date.now();
          setBootstrapMessage(message);
          setBootstrapEvents((previous) => {
            const next = previous.concat({ phase: evt.phase, message, timestamp });
            return next.length > 24 ? next.slice(-24) : next;
          });
        });

        // 1. Subscribe to PTY events BEFORE opening/attaching the PTY so the
        // initial sandbox-connect output (welcome banner, prompt) and any
        // live bytes that arrive mid-attach aren't lost. Handlers gate on
        // sessionIdRef so they only fire once we own a session.
        unsubData = bridge?.openrindShell?.onPtyData?.((payload) => {
          if (cancelled) return;
          if (payload.sessionId === sessionIdRef.current) {
            writeToTerm(payload.data);
          }
        });
        unsubExit = bridge?.openrindShell?.onPtyExit?.((payload) => {
          if (cancelled) return;
          if (payload.sessionId === sessionIdRef.current) {
            // Keep sessionIdRef set: the dead session is retained in the main
            // process (with its buffer) so Reconnect / End session can close
            // it by id, and a re-attach after navigation replays its output.
            writeToTerm(
              `\r\n\x1b[33m[Session ended (exit ${payload.exitCode ?? "?"}). Click Reconnect to start a new session.]\x1b[0m\r\n`,
            );
            setPhase("exited");
          }
        });

        // 2. Mount xterm.js FIRST — both so we have real cols/rows to hand to
        // the PTY and so we have a live terminal to replay buffered scrollback
        // into on a re-attach. The bootstrap overlay (gated on
        // isFreshBootstrap) sits ON TOP of this container via absolute
        // positioning, so mounting underneath first is invisible.
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");
        // Resolve the optional addons up front, while there is still no Terminal
        // instance to leak. Every await between `new Terminal()` and the
        // termRef.current assignment below is a window in which a cancelled run
        // would abandon an opened terminal that cleanup() cannot see.
        const unicode = await loadUnicodeAddon();
        const WebglAddon = await loadWebglAddonCtor();
        if (cancelled || !containerRef.current) return;

        // Wait for the browser to complete layout so fit() can measure
        // real pixel dimensions. Two RAFs are the minimum: the first fires
        // before the style-recalc commit, the second fires after it.
        // This prevents cols=1 (vertical text) on first open.
        const waitFrames = (n: number) =>
          new Promise<void>((resolve) => {
            const step = (remaining: number) =>
              remaining <= 0
                ? resolve()
                : requestAnimationFrame(() => step(remaining - 1));
            step(n);
          });
        await waitFrames(2);
        if (cancelled || !containerRef.current) return;

        // If the container still has 0 width after 2 frames (can happen
        // when the parent's height is derived purely from flexbox), keep
        // polling up to ~600 ms before giving up and using defaults.
        // (The absolute-inset-0 wrapper in session-page.tsx should prevent
        // this, but this guard catches any remaining edge cases.)
        let pollAttempts = 0;
        while (
          containerRef.current &&
          containerRef.current.clientWidth === 0 &&
          pollAttempts < 10
        ) {
          await waitFrames(2);
          if (cancelled) return;
          pollAttempts++;
        }
        if (cancelled || !containerRef.current) return;

        // NOTE: no `windowsPty`/ConPTY hint here. The PTY bytes now come raw
        // from a real Linux PTY inside the sandbox (openrind-pty-bridge.py),
        // piped through wsl.exe WITHOUT node-pty/ConPTY. Telling xterm the
        // backend is ConPTY would make it apply ConPTY-specific input/reflow
        // handling to a stream that isn't ConPTY, re-introducing corruption.
        // Standard handling is correct for the raw Linux-PTY stream.
        const term = new Terminal({
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 13,
          cursorBlink: true,
          scrollback: 5_000,
          allowProposedApi: true,
          theme: {
            background: "#0a0a0a",
            foreground: "#e6e6e6",
            cursor: "#e6e6e6",
            selectionBackground: "#444",
          },
        });
        const fit = new FitAddon();
        // Install the Unicode width tables BEFORE any content is written so the
        // cell widths match what the agent's renderer assumed when it laid the
        // frame out (see loadUnicodeAddon).
        term.loadAddon(unicode.addon);
        if (unicode.activeVersion) {
          term.unicode.activeVersion = unicode.activeVersion;
        }
        term.loadAddon(fit);
        term.open(containerRef.current);

        // Renderer: WebGL2 on the GPU instead of xterm's default DOM renderer.
        // Agent TUIs repaint whole frames many times a second (Ink re-emits the
        // entire composer + transcript viewport on each token); the DOM renderer
        // rebuilds a <span> tree per row for every one of those frames, which is
        // where the tearing, stranded glyphs and input lag come from. Loaded
        // AFTER term.open() because it needs the attached canvas, and BEFORE
        // fit() so cell metrics are measured with the renderer that will
        // actually paint.
        //
        // Degraded path: no WebGL2 (blocklisted driver, software rendering,
        // context lost later under GPU pressure) ⇒ stay on the DOM renderer.
        // Uglier and slower beats a blank pane, so the GPU path is only taken
        // when a scratch-canvas probe clears it — see probeWebgl2 — and
        // localStorage can pin either renderer without a rebuild.
        const rendererPref = readRendererPreference();
        let activeRenderer = "dom";
        if (WebglAddon && rendererPref !== "dom") {
          const probe =
            rendererPref === "webgl"
              ? { ok: true, reason: "forced via localStorage" }
              : probeWebgl2();
          if (!probe.ok) {
            console.warn(
              `[openrindShellTerminal] WebGL unavailable (${probe.reason}) — using the DOM renderer.`,
            );
          } else {
            try {
              const webgl = new WebglAddon();
              webgl.onContextLoss(() => {
                try {
                  webgl.dispose();
                } catch {
                  // Already disposed.
                }
                if (webglRef.current === webgl) webglRef.current = null;
                rendererRef.current = "dom (after context loss)";
                console.warn(
                  "[openrindShellTerminal] WebGL context lost — fell back to the DOM renderer.",
                );
              });
              // loadAddon() is where the addon activates and where it throws if
              // WebGL2 can't be initialised, so the catch has to wrap it.
              term.loadAddon(webgl);
              webglRef.current = webgl;
              activeRenderer = "webgl";
            } catch (err) {
              webglRef.current = null;
              console.warn(
                "[openrindShellTerminal] WebGL renderer failed to activate — using the DOM renderer.",
                err,
              );
            }
          }
        }
        const stylesOk = assertXtermStylesLoaded(term);
        rendererRef.current = stylesOk
          ? activeRenderer
          : `${activeRenderer} (STYLESHEET MISSING)`;
        console.info(
          `[openrindShellTerminal] renderer=${activeRenderer} (pref=${rendererPref}) unicode=${term.unicode.activeVersion} styles=${stylesOk ? "ok" : "MISSING"}`,
        );

        // Initial fit — may give cols=1 if the browser hasn't committed
        // layout for the container yet (timing race on first mount).
        try {
          fit.fit();
        } catch {
          // ignore
        }
        termRef.current = term;
        fitRef.current = fit;

        // Flush any bytes that arrived during mount. Awaited so the parser has
        // caught up before the ResizeObserver / fit() below can re-wrap them.
        await flushEarlyBuffer(term);
        if (cancelled) return;

        // ── Key fix for the cols=1 / vertical-text bug ──────────────────
        // Set up the ResizeObserver NOW, before the PTY is opened.
        // The ResizeObserver fires once on the FIRST frame after observe()
        // regardless of whether the size changed — this gives fit.fit() a
        // second chance to measure with fully-committed CSS dimensions.
        // We then wait two frames so that callback has run and corrected
        // term.cols before we pass it to openrindPtyOpen.
        //
        // Without this, the initial fit() above can race against the browser
        // layout commit and measure 0px → cols=1. Once cols=1 is set,
        // a ResizeObserver firing later calls fit.fit() → still cols=1 (no
        // change) → term.onResize never fires → no SIGWINCH → cols stays 1.
        if (containerRef.current) {
          const ro = new ResizeObserver(() => {
            try {
              fitRef.current?.fit();
            } catch {
              // Container unmounted — ignore.
            }
          });
          ro.observe(containerRef.current);
          resizeObserverRef.current = ro;
        }

        // Wait for the ResizeObserver initial callback to complete.
        // RO fires at the end of each rendering frame (after RAF).
        // Two frames is sufficient: frame N fires RAF → frame N+1 the
        // RO callback runs → fit.fit() corrects cols/rows.
        await waitFrames(2);
        if (cancelled || !containerRef.current) return;

        // Hard fallback: if fit() still reports cols ≤ 2 the container
        // genuinely has 0px CSS width.  Force a sane default so Claude
        // Code TUI at least opens usably; the ResizeObserver will correct
        // the PTY dimensions once the user resizes or the layout settles.
        if (term.cols <= 2) {
          try {
            term.resize(120, term.rows > 2 ? term.rows : 32);
          } catch {
            // ignore
          }
        }

        // Geometry is final now. Force one full repaint of the viewport: the
        // renderer was attached while the terminal was still at its default
        // 80x24, and every fit()/resize() since then only marks the CHANGED
        // rows dirty. Anything already written during mount would otherwise
        // keep whatever the pre-resize pass left on screen — which, for the
        // GPU renderer, can be nothing at all.
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          // Terminal disposed mid-mount — nothing to repaint.
        }

        // Wire terminal input → PTY stdin (every keystroke, incl. arrows)
        // and xterm's own resize → PTY SIGWINCH. Identical for the re-attach
        // and fresh-open paths, so define once and call in each branch.
        const wireTerminalIO = () => {
          term.onData((data) => {
            if (!sessionIdRef.current) return;
            void invoke("openrindPtyWrite", {
              sessionId: sessionIdRef.current,
              data,
            });
          });
          term.onResize(({ cols, rows }) => {
            if (!sessionIdRef.current) return;
            void invoke("openrindPtyResize", {
              sessionId: sessionIdRef.current,
              cols,
              rows,
            });
          });
        };

        // 3. Probe for an already-running PTY for THIS sandbox AND this
        // session. If one exists the renderer simply navigated away earlier
        // (we detached, keeping the wsl child + scrollback alive), so we
        // re-attach losslessly — no re-bootstrap, no agent relaunch. A live
        // PTY for a DIFFERENT session in this sandbox is NOT a match: it means
        // the user switched tasks, so we fall through to a fresh open (which
        // tears the old PTY down — one agent per sandbox at a time).
        const agentSessionId = props.sessionId ?? null;
        let liveSession = false;
        try {
          const sessionsList =
            await invoke<
              Array<{ sandboxName: string; agentSessionId: string | null }>
            >("openrindPtyList");
          liveSession = sessionsList.some(
            (s) =>
              s.sandboxName === authoritativeName &&
              (s.agentSessionId ?? null) === agentSessionId,
          );
        } catch {
          liveSession = false;
        }
        if (cancelled) return;

        if (liveSession) {
          // ── Lossless re-attach (two-phase) ─────────────────────────────
          // Phase 1: get session id + buffered scrollback. The main process
          // does NOT call attachHandlers here, so no pty-data events fly yet.
          const attached = await invoke<{
            id: string;
            buffered: string;
            cols?: number;
            rows?: number;
            exited: boolean;
            reused?: boolean;
          }>("openrindPtyAttachOrOpen", {
            sandboxName: authoritativeName,
            workspaceId: props.workspaceId,
            cols: term.cols,
            rows: term.rows,
            sessionId: agentSessionId,
            profile: props.profile,
          });
          if (cancelled) {
            void invoke("openrindPtyDetach", attached.id).catch(() => {});
            return;
          }
          setSandboxName(authoritativeName);
          lastKnownSandboxNameRef.current = authoritativeName;
          // Set sessionIdRef BEFORE phase 2 so the onPtyData handler accepts
          // events the moment the main process starts streaming.
          sessionIdRef.current = attached.id;
          // Input must be live before replay/attach exposes an interactive
          // prompt. A slow replay must never leave a visible Claude screen with
          // an unwired keyboard.
          wireTerminalIO();
          // Replay the buffered bytes at the geometry they were RECORDED at.
          // The buffer is the agent's raw PTY output: absolute cursor moves
          // plus hard wraps at the pty's width. Replaying a 120-col recording
          // into a differently-sized xterm mis-wraps every full-width row and
          // strands fragments above the agent's next repaint. So: temporarily
          // match the recorded size, replay, and only then fit to the real
          // pane — the resulting resize frame makes the agent repaint a clean
          // full frame at the new geometry.
          const recordedCols = attached.cols ?? term.cols;
          const recordedRows = attached.rows ?? term.rows;
          if (attached.buffered) {
            if (term.cols !== recordedCols || term.rows !== recordedRows) {
              try {
                term.resize(recordedCols, recordedRows);
              } catch {
                // ignore — worst case the replay wraps like before
              }
            }
            // Wait for the replay to PARSE before any further resize: xterm
            // parses writes asynchronously, and resizing with the replay
            // still queued would re-wrap it at the new size again.
            await new Promise<void>((resolve) =>
              term.write(attached.buffered, resolve),
            );
          }
          if (cancelled) {
            void invoke("openrindPtyDetach", attached.id).catch(() => {});
            return;
          }
          // Same await rationale as the replay above: the fit() further down
          // must not resize while these are still queued.
          await flushEarlyBuffer(term);
          if (cancelled) {
            void invoke("openrindPtyDetach", attached.id).catch(() => {});
            return;
          }
          // Phase 2: wire live PTY streaming now that sessionIdRef is set.
          if (!attached.exited) {
            await invoke("openrindPtyAttach", attached.id, {
              replayBuffered: attached.reused === false,
            });
          }
          if (cancelled) {
            void invoke("openrindPtyDetach", attached.id).catch(() => {});
            return;
          }
          // Now fit to the actual container. For a live session the resize
          // frame reaches the agent's PTY (wireTerminalIO is up) and the agent
          // repaints the whole frame at the new size. A dead session stays at
          // its recorded geometry so the corpse replay stays legible.
          if (!attached.exited) {
            try {
              fitRef.current?.fit();
            } catch {
              // ignore
            }
          }
          setHasEverConnected(true);
          setPhase(attached.exited ? "exited" : "connected");
          return;
        }

        // ── Fresh bootstrap ───────────────────────────────────────────────
        // No live session: this is a first open (or a reconnect after the PTY
        // was explicitly closed). Now show the bootstrap overlay, ensure the
        // sandbox is up (idempotent), then open a new PTY.
        setIsFreshBootstrap(true);
        setPhase("ensuring-sandbox");
        const sandbox = await invoke<{ sandboxName: string; existed: boolean }>(
          "openrindEnsureSandbox",
          { workspaceId: props.workspaceId, profile: props.profile },
        );
        if (cancelled) return;
        setSandboxName(sandbox.sandboxName);
        lastKnownSandboxNameRef.current = sandbox.sandboxName;

        // Open the PTY. Pass the current xterm size — now guaranteed to be the
        // result of a ResizeObserver-corrected fit() call.
        setPhase("connecting-pty");
        const pty = await invoke<{ id: string }>("openrindPtyOpen", {
          sandboxName: sandbox.sandboxName,
          workspaceId: props.workspaceId,
          cols: term.cols,
          rows: term.rows,
          sessionId: agentSessionId,
          profile: props.profile,
        });
        if (cancelled) {
          await invoke("openrindPtyClose", pty.id).catch(() => {});
          return;
        }
        sessionIdRef.current = pty.id;
        // Wire input immediately after PTY ownership is established, before
        // buffered output can expose a prompt that appears unresponsive.
        wireTerminalIO();
        // Start paint tracking only after provisioning, but before main attaches
        // the output stream. Main then installs the handler and replays all bytes
        // atomically, so Claude's first full-screen frame cannot race ahead of
        // this session id.
        paintBytesRef.current = 0;
        trackPaintRef.current = true;
        if (paintCapTimerRef.current) clearTimeout(paintCapTimerRef.current);
        paintCapTimerRef.current = setTimeout(
          markAgentReadyOnPaintTimeout,
          AGENT_PAINT_CAP_MS,
        );
        await invoke("openrindPtyAttach", pty.id, { replayBuffered: true });
        if (cancelled) return;
        await flushEarlyBuffer(term);
        if (cancelled) return;
        setPhase("connected");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setPhase("error");
      }
    };

    void run();
    return () => {
      void cleanup();
    };
  }, [
    props.workspaceId,
    props.profile,
    props.sessionId,
    reconnectKey,
    userAborted,
  ]);

  const popOut = useCallback(async () => {
    const name = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!name) return;
    setPopoutBusy(true);
    setPopoutError(null);
    try {
      await invoke("openrindPopOutTerminal", {
        sandboxName: name,
        workspaceId: props.workspaceId,
        profile: props.profile,
      });
    } catch (err) {
      setPopoutError(err instanceof Error ? err.message : String(err));
    } finally {
      setPopoutBusy(false);
    }
  }, [props.profile, props.workspaceId, sandboxName]);

  const deleteSandbox = useCallback(async () => {
    const nameToDelete = sandboxName ?? lastKnownSandboxNameRef.current;
    if (!nameToDelete) return;
    const ok = window.confirm(
      `Delete sandbox "${nameToDelete}"?\n\n` +
        "The Postgres-backed /home/agent will remain, but this sandbox " +
        "instance is gone. Reopening the workspace will create a fresh " +
        "sandbox and restore the home directory from PostgreSQL.",
    );
    if (!ok) return;
    // Kill the local PTY before tearing down the sandbox so we never leave a
    // wsl child pointed at a deleted container. explicitEndRef makes the
    // subsequent unmount a CLOSE (no-op, already closed) rather than a detach.
    explicitEndRef.current = true;
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id) {
      await invoke("openrindPtyClose", id).catch(() => {});
    }
    try {
      await invoke("openrindDeleteSandbox", nameToDelete);
      props.onSandboxDeleted?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [sandboxName, props.onSandboxDeleted, props]);

  /** Delete the stuck sandbox silently then immediately reconnect so
   *  openrindEnsureSandbox creates a brand-new one. Used from the
   *  BootstrapErrorCard when the sandbox is stuck in Provisioning. */
  const deleteAndReconnect = useCallback(async () => {
    const nameToDelete = sandboxName ?? lastKnownSandboxNameRef.current;
    if (nameToDelete) {
      try {
        await invoke("openrindDeleteSandbox", nameToDelete);
      } catch {
        // Best-effort — even if delete fails, attempt a reconnect; the
        // "already exists" guard in createOpenrindShellSandbox handles partial state.
      }
    }
    handleLaunch();
  }, [sandboxName, handleLaunch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — styled to match the SessionPage chat header (which is
          hidden while a sandbox terminal is showing) so the surface reads
          as ONE consistent header instead of two stacked ones. */}
      <div className="z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-dls-border bg-dls-surface px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          {isRenaming ? (
            <input
              autoFocus
              className="h-7 rounded-md border border-dls-border bg-dls-hover px-2 font-mono text-[13px] text-dls-text outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setIsRenaming(false);
              }}
              onBlur={commitRename}
            />
          ) : (
            <button
              className="group flex min-w-0 items-center gap-1.5 text-left"
              title={
                sandboxName
                  ? `Display label (cosmetic only)\nActual sandbox: ${sandboxName}\n\nClick to rename`
                  : "Click to rename display label"
              }
              onClick={() => {
                setRenameValue(displayName);
                setIsRenaming(true);
              }}
            >
              <span className="truncate text-[15px] font-semibold text-dls-text">
                {displayName || sandboxName || expectedSandboxName}
              </span>
              <Pencil
                size={11}
                className="shrink-0 text-dls-secondary opacity-0 transition-opacity group-hover:opacity-100"
              />
            </button>
          )}
          <span
            className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
              phase === "connected"
                ? "border-green-7/60 bg-green-3/30 text-green-11"
                : phase === "exited" || phase === "error"
                  ? "border-red-7/50 bg-red-2/30 text-red-11"
                  : "border-amber-7/50 bg-amber-2/30 text-amber-11"
            }`}
            title={`Renderer: ${rendererRef.current}\n\nIf the pane is blank or torn, pin the other renderer from DevTools and reconnect:\n  localStorage.setItem("${RENDERER_PREF_KEY}", "dom")\n  localStorage.setItem("${RENDERER_PREF_KEY}", "webgl")\n  localStorage.removeItem("${RENDERER_PREF_KEY}")  // auto`}
          >
            {phaseLabel(phase)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {phase === "exited" || phase === "error" ? (
            <button
              type="button"
              className={TOOLBAR_BTN}
              onClick={
                errorNeedsDelete
                  ? () => void deleteAndReconnect()
                  : handleLaunch
              }
              onMouseDown={(e) => e.preventDefault()}
              title={
                errorNeedsDelete
                  ? "Delete the broken sandbox and launch a fresh one"
                  : hasEverConnected
                    ? "Reconnect to the sandbox"
                    : "Launch a new session"
              }
            >
              <RotateCcw className="h-4 w-4" />
              <span className="text-[11px] font-medium">
                {errorNeedsDelete
                  ? "Delete & relaunch"
                  : hasEverConnected
                    ? "Reconnect"
                    : "Launch session"}
              </span>
            </button>
          ) : phase !== "connected" ? (
            // During provisioning — show a Cancel button so the user is never
            // stuck at the spinner with no escape.
            <button
              type="button"
              className={TOOLBAR_BTN}
              onClick={handleAbort}
              onMouseDown={(e) => e.preventDefault()}
              title="Cancel provisioning and return to the launch screen"
            >
              <span className="text-[11px] font-medium">Cancel</span>
            </button>
          ) : null}

          {phase === "connected" && props.onSwitchToChat ? (
            <button
              type="button"
              className={TOOLBAR_BTN}
              onClick={props.onSwitchToChat}
              onMouseDown={(e) => e.preventDefault()}
              title="Switch to the regular Openrind Desktop chat UI. The session keeps running — switch back to resume it instantly."
            >
              <MessageSquare className="h-4 w-4" />
              <span className="hidden text-[11px] font-medium lg:inline">Chat</span>
            </button>
          ) : null}

          {phase === "connected" ? (
            <>
              <button
                type="button"
                className={TOOLBAR_BTN}
                onClick={handleUploadClick}
                disabled={uploadBusy}
                onMouseDown={(e) => e.preventDefault()}
                title="Attach files to the sandbox workspace"
              >
                {uploadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                <span className="text-[11px] font-medium">Attach</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: "none" }}
                multiple
                onChange={handleFileChange}
              />
              <button
                type="button"
                className={TOOLBAR_BTN}
                aria-label="Files"
                onClick={() => {
                  setFilesModalOpen(true);
                  void refreshSandboxFiles();
                }}
                onMouseDown={(e) => e.preventDefault()}
                title="View files in the sandbox FUSE workspace"
              >
                <FileText className="h-4 w-4" />
                <span className="text-[11px] font-medium">
                  Files{sandboxFiles.length > 0 ? ` (${sandboxFiles.length})` : ""}
                </span>
              </button>
              <button
                type="button"
                className={`${TOOLBAR_BTN} ${browserOpen ? "bg-dls-hover text-dls-text font-semibold" : ""}`}
                aria-label="Browser Agent"
                onClick={() => setBrowserOpen((prev) => !prev)}
                onMouseDown={(e) => e.preventDefault()}
                title="Toggle Browser Agent panel"
              >
                <Globe className="h-4 w-4" />
                <span className="text-[11px] font-medium">Browser</span>
              </button>
              <TerminalMicButton
                onText={(text) => {
                  const id = sessionIdRef.current;
                  if (!id) return;
                  const flat = text.replace(/\r?\n/g, " ").trim();
                  if (!flat) return;
                  void invoke("openrindPtyWrite", { sessionId: id, data: flat });
                  try {
                    termRef.current?.focus();
                  } catch {
                    /* ignore */
                  }
                }}
                onError={(message) => {
                  try {
                    termRef.current?.write(
                      `\r\n\x1b[31m[voice] ${message}\x1b[0m\r\n`,
                    );
                  } catch {
                    /* ignore */
                  }
                }}
              />
            </>
          ) : null}
        </div>
      </div>
      {popoutError ? (
        <div className="border-b border-red-7/40 bg-red-2/20 px-4 py-2 text-xs text-red-12">
          Pop out failed: {popoutError}
        </div>
      ) : null}

      {/* The terminal container is always in the DOM with real CSS dimensions
          so xterm.js fit() measures correctly on first paint (avoids cols=1
          vertical-text bug). Loading / error overlays sit on top via absolute
          positioning rather than hiding the container with display:none. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="relative min-h-0 flex-1">
          {/* Terminal container: always focused when the cursor is over it.
            focus-on-hover means the user doesn't need to click after
            interacting with toolbar buttons — moving the mouse back over
            the terminal instantly restores keystroke capture so Claude
            Code's TUI (theme selectors, menus, etc.) responds correctly.
            onClick is a fallback for touch/keyboard navigation.

            The padded wrapper (matching the xterm theme background) keeps
            the TUI's bottom-anchored input row from sitting flush against
            the app chrome below the pane. FitAddon measures containerRef
            (the inner h-full div), so the proposed rows already account
            for the padding — the last row is never clipped. */}
        <div
          className="absolute inset-0 bg-[#0a0a0a] px-2 pb-2 pt-1"
          onMouseEnter={() => {
            try {
              termRef.current?.focus();
            } catch {
              /* ignore */
            }
          }}
          onClick={() => {
            try {
              termRef.current?.focus();
            } catch {
              /* ignore */
            }
          }}
        >
          <div ref={containerRef} className="h-full w-full" />
        </div>
        {errorMessage && phase === "error" ? (
          <div className="absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-dls-surface p-4 md:p-6 md:items-center">
            <BootstrapErrorCard
              message={errorMessage}
              profile={props.profile}
              onRetry={reconnect}
              onDeleteAndReconnect={deleteAndReconnect}
              onOpenSettings={props.onOpenSettings}
            />
          </div>
        ) : isFreshBootstrap &&
          !agentReady &&
          phase !== "exited" &&
          phase !== "error" ? (
          // Show the bootstrap overlay during a FIRST-TIME launch and KEEP it up
          // until the agent's TUI has actually painted (!agentReady), not just
          // until the PTY connects — otherwise the terminal flashes blank for
          // the ~30s the agent spends initializing. A lossless re-attach
          // (isFreshBootstrap === false) skips it so returning is instant.
          // "error" without an errorMessage (cleared by commitRename) falls
          // through here — don't show the spinner, just show the terminal.
          <div className="absolute inset-0 z-10 flex items-start justify-center overflow-y-auto bg-dls-surface p-4 md:p-6 md:items-center">
            <BootstrapProgress
              bootstrapMessage={bootstrapMessage}
              events={bootstrapEvents}
              startedAt={bootstrapStartedAt}
              existed={false}
              onAbort={handleAbort}
            />
          </div>
        ) : null}
        </div>

        {browserOpen ? (
          <aside style={{ width: 380, minWidth: 320 }} className="flex flex-col border-l border-dls-border bg-dls-surface z-20">
            <BrowserPanel
              state={browser.state}
              onStart={browser.startSession}
              onStop={browser.stopSession}
              onNavigate={browser.navigate}
              onTakeControl={browser.takeControl}
              onResume={browser.resumeControl}
              onSetBounds={browser.setBounds}
              onClosePanel={() => setBrowserOpen(false)}
            />
          </aside>
        ) : null}
      </div>

      {filesModalOpen ? (
        <div className="fixed inset-0 z-[60] bg-gray-1/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setFilesModalOpen(false)}>
          <div className="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-6/70 flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-12 flex items-center gap-2">
                <FileText size={16} className="text-gray-9" />
                Sandbox Files
              </h3>
              <button
                type="button"
                className="flex items-center justify-center h-7 w-7 rounded-full hover:bg-gray-4 text-gray-10 hover:text-gray-12 transition-colors"
                onClick={() => setFilesModalOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-2 max-h-[60vh] overflow-y-auto">
              {filesLoading && sandboxFiles.length === 0 ? (
                <div className="flex items-center justify-center gap-2 p-6 text-sm text-gray-10">
                  <Loader2 className="animate-spin" size={15} />
                  Reading /sandbox/work/inbox…
                </div>
              ) : filesError ? (
                <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-red-11">
                  <span>{filesError}</span>
                  <button
                    type="button"
                    className="rounded-md border border-gray-6 px-3 py-1.5 text-xs text-gray-11 hover:bg-gray-3"
                    onClick={() => void refreshSandboxFiles()}
                  >
                    Retry
                  </button>
                </div>
              ) : sandboxFiles.length === 0 ? (
                <div className="p-6 text-center text-sm text-gray-10">
                  No files in /sandbox/work/inbox.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {sandboxFiles.map((file) => (
                    <div key={file.path} className="flex items-center gap-3 rounded-xl px-4 py-3 transition-colors hover:bg-gray-3/50 group">
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-[13px] font-medium text-gray-11 flex items-baseline gap-2">
                          {file.name}
                          <span className="text-[11px] font-normal text-gray-9">{formatBytes(file.size)}</span>
                        </div>
                        <div className="truncate text-[11px] text-gray-10 mt-0.5">{file.path}</div>
                      </div>
                      <div className="flex items-center gap-1 opacity-100">
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-10 hover:bg-gray-4 hover:text-gray-12 transition-colors"
                          title="Copy path"
                          onClick={async (e) => {
                            e.stopPropagation();
                            const path = file.path;
                            try {
                              if (navigator.clipboard && navigator.clipboard.writeText) {
                                await navigator.clipboard.writeText(path);
                              } else {
                                throw new Error("Clipboard API not available");
                              }
                              showToast({
                                title: "Path copied to clipboard",
                                tone: "success",
                              });
                            } catch (err) {
                              try {
                                const input = document.createElement("input");
                                input.setAttribute("value", path);
                                document.body.appendChild(input);
                                input.select();
                                document.execCommand("copy");
                                document.body.removeChild(input);
                                showToast({
                                  title: "Path copied to clipboard",
                                  tone: "success",
                                });
                              } catch (fallbackErr) {
                                showToast({
                                  title: "Failed to copy path",
                                  tone: "warning",
                                });
                              }
                            }
                          }}
                        >
                          <Copy size={15} />
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-10 hover:bg-gray-4 hover:text-gray-12 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          title="Download to computer"
                          disabled={downloadingFile !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            void downloadSandboxFile(file);
                          }}
                        >
                          {downloadingFile === file.name ? (
                            <Loader2 className="animate-spin" size={15} />
                          ) : (
                            <Download size={15} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-10 hover:bg-red-3 hover:text-red-11 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          title="Delete file"
                          disabled={downloadingFile !== null}
                          onClick={async (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const success = await removeUploadedFile(file.name);
                            if (success && sandboxFiles.length === 1) setFilesModalOpen(false);
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

/**
 * Microphone button for the terminal toolbar. Records speech, transcribes it,
 * and hands the text to onText — which the terminal writes into the PTY so it lands
 * in Claude Code's input box. Renders nothing when the runtime can't record/transcribe.
 */
function TerminalMicButton(props: {
  onText: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const { status, error, start, stop } =
    useVoiceInput(props.onText, props.onError);
  if (status === "unsupported") return null;

  const recording = status === "recording";
  const transcribing = status === "transcribing";

  let title = "Dictate into the terminal";
  if (recording) title = "Stop recording";
  else if (transcribing) title = "Transcribing…";
  else if (status === "error" && error) title = `${error} — click to try again`;

  return (
    <button
      type="button"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
        recording
          ? "bg-red-3 text-red-11 hover:bg-red-4"
          : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
      }`}
      onClick={() => {
        if (props.disabled || transcribing) return;
        if (recording) stop();
        else start();
      }}
      onMouseDown={(e) => e.preventDefault()}
      disabled={props.disabled || transcribing}
      title={title}
      aria-label={title}
      aria-pressed={recording}
    >
      {transcribing ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : recording ? (
        <Square className="h-3.5 w-3.5 fill-current animate-pulse" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </button>
  );
}

type BootstrapProgressProps = {
  bootstrapMessage: string | null;
  events: BootstrapProgressEvent[];
  startedAt: number | null;
  existed: boolean;
  /** When provided, renders a "Cancel provisioning" link inside the card.
   *  Calling it sets userAborted=true so run() exits immediately, and the
   *  user can re-launch manually via the toolbar "Launch session" button. */
  onAbort?: () => void;
};

function formatBootstrapElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
}

const BOOTSTRAP_LOG_DATE = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
});
const BOOTSTRAP_LOG_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function BootstrapProgress(props: BootstrapProgressProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsed = props.startedAt ? formatBootstrapElapsed(now - props.startedAt) : "0s";
  const activities = props.events.slice(-8).reverse();
  const currentMessage = props.bootstrapMessage ?? "Waiting for the next OpenShell event...";

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-xl border border-dls-border bg-dls-surface shadow-2xl">
      <div className="flex items-center gap-2.5 border-b border-dls-border px-4 py-3">
        <Loader2 size={15} className="shrink-0 animate-spin text-amber-10" />
        <div className="min-w-0 truncate text-[13px] font-semibold text-gray-12">
          {props.existed ? "Reconnecting to Openrind Shell" : "Provisioning Openrind Shell"}
        </div>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-gray-8"
          title="Elapsed time"
        >
          {elapsed}
        </span>
      </div>

      <div className="p-4">
        <div role="log" aria-live="polite" aria-relevant="additions text">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-gray-9">
            Activity
          </div>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-dls-border bg-gray-1/40">
            {activities.length > 0 ? (
              activities.map((event, index) => {
                const timestamp = new Date(event.timestamp);
                return (
                  <div
                    key={`${event.timestamp}-${index}`}
                    className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 border-b border-dls-border/60 px-3 py-1.5 last:border-b-0"
                  >
                    <time
                      dateTime={timestamp.toISOString()}
                      title={timestamp.toLocaleString()}
                      className="whitespace-nowrap font-mono text-[9px] leading-4 tabular-nums text-gray-8"
                    >
                      {BOOTSTRAP_LOG_DATE.format(timestamp)}{" "}
                      {BOOTSTRAP_LOG_TIME.format(timestamp)}
                    </time>
                    <span className={`min-w-0 break-words font-mono text-[10px] leading-4 ${index === 0 ? "text-gray-12" : "text-gray-9"}`}>
                      {event.message}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="break-words px-3 py-2 font-mono text-[10px] leading-4 text-gray-10">
                {currentMessage}
              </div>
            )}
          </div>
        </div>
        {props.onAbort ? (
          <div className="flex justify-center pt-3">
            <button
              type="button"
              className="text-[10px] text-gray-8 underline-offset-2 transition-colors hover:text-gray-11 hover:underline"
              onClick={props.onAbort}
            >
              Cancel provisioning
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type BootstrapErrorCardProps = {
  message: string;
  profile: SandboxProfile;
  onRetry: () => void;
  onDeleteAndReconnect?: () => void;
  onOpenSettings?: (target: "environment" | "sandbox") => void;
};

function BootstrapErrorCard(props: BootstrapErrorCardProps) {
  // Detect actionable errors so the founder sees a clear next step
  // instead of a raw stderr dump.
  //
  // NOTE: Electron IPC wraps thrown errors with the prefix
  // "Error invoking remote method 'openrind-desktop:desktop': Error: " before the
  // original message reaches the renderer. All pattern matches therefore
  // use regex /test/ rather than String.startsWith so they work regardless
  // of this wrapping.
  const stuckProvisioning = /STUCK_PROVISIONING:/i.test(props.message);
  // Sandbox reached the "error" phase (Docker container failed to start,
  // setup.sh crashed, etc.). The sandbox must be deleted and recreated.
  const sandboxErrorState = /is in error state/i.test(props.message);
  const missingDatabase = /DATABASE_URL is not configured/i.test(props.message);
  const missingApiKey = /ANTHROPIC_API_KEY (?:is not configured|is required by Haloop)/i.test(
    props.message,
  );
  const openshellUnready = /OpenShell is not ready/i.test(props.message);
  const haloopUnavailable = /Haloop/i.test(props.message) && !missingApiKey;
  const gatewayUnresponsive =
    /gateway is not responding|sandbox list timed out/i.test(props.message);
  const credentialIssue = missingDatabase || missingApiKey;
  const needsDeleteAndRecreate = stuckProvisioning || sandboxErrorState;

  let title = "Could not start Openrind Shell session.";
  let detail = props.message;
  if (stuckProvisioning) {
    title = "Sandbox is stuck in Provisioning.";
    detail =
      "The sandbox has been provisioning for over 90 seconds and hasn't become ready. " +
      "This usually means the OpenShell gateway lost track of the container. " +
      'Click "Delete & start fresh" to remove the stuck sandbox and create a new one.';
  } else if (sandboxErrorState) {
    title = "Sandbox is in an error state.";
    detail =
      "The sandbox container failed to start or encountered a fatal error during setup. " +
      'Click "Delete & start fresh" to delete the broken sandbox and create a new one.';
  } else if (missingDatabase) {
    title = "DATABASE_URL is not configured.";
    detail =
      "Openrind Shell stores workspace state in PostgreSQL. Open Settings → Environment → " +
      "Sandbox credentials and paste your connection string.";
  } else if (missingApiKey) {
    title = "ANTHROPIC_API_KEY is not configured.";
    detail =
      "The required Haloop edge needs an upstream Anthropic API key; it is retained by Desktop and is not copied into the sandbox. " +
      "Open Settings → Environment → Sandbox credentials and paste your Anthropic API key.";
  } else if (haloopUnavailable) {
    title = "Haloop inference edge is unavailable.";
    detail = `${props.message} Openrind Shell will not bypass Haloop; resolve the reported edge or port problem, then retry.`;
  } else if (gatewayUnresponsive) {
    title = "OpenShell gateway is not responding.";
    detail =
      "The openshell CLI couldn't reach its gateway. Open Settings → Sandbox → " +
      "OpenShell health and click Restart Gateway, then try again.";
  } else if (openshellUnready) {
    title = "OpenShell stack isn't ready.";
    detail =
      "Open Settings → Sandbox and run the installer / Doctor — the WSL distro, " +
      "Docker, OpenShell CLI, or gateway is missing or unhealthy.";
  }

  return (
    <div className="max-w-lg space-y-4 rounded-2xl border border-red-7/40 bg-red-2/20 p-5">
      <div className="flex items-center gap-2 text-red-12">
        <AlertTriangle size={16} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      <div className="text-sm text-gray-11">{detail}</div>
      {!credentialIssue && !needsDeleteAndRecreate ? (
        <div className="font-mono text-xs text-red-12 break-words">
          {props.message}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {needsDeleteAndRecreate && props.onDeleteAndReconnect ? (
          <Button variant="primary" onClick={props.onDeleteAndReconnect}>
            <RotateCcw size={14} className="mr-1.5" />
            Delete &amp; start fresh
          </Button>
        ) : null}
        {credentialIssue && props.onOpenSettings ? (
          <Button
            variant="primary"
            onClick={() => props.onOpenSettings?.("environment")}
          >
            <Settings size={14} className="mr-1.5" />
            Open Settings → Environment
          </Button>
        ) : null}
        {(openshellUnready || gatewayUnresponsive) && props.onOpenSettings ? (
          <Button
            variant="primary"
            onClick={() => props.onOpenSettings?.("sandbox")}
          >
            <Settings size={14} className="mr-1.5" />
            Open Settings → Sandbox
          </Button>
        ) : null}
        <Button variant="outline" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "starting":
      return "Starting...";
    case "ensuring-sandbox":
      return "Preparing sandbox (pull + create)...";
    case "mounting-terminal":
      return "Mounting terminal...";
    case "connecting-pty":
      return "Opening PTY...";
    case "connected":
      return "Connected";
    case "exited":
      return "Disconnected";
    case "error":
      return "Error";
    default:
      return phase;
  }
}
