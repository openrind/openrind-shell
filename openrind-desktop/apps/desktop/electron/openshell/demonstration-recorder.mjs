// Desktop Workflow Demonstration Recorder (VLA & Human Task Demonstration Capture)
import electron from "electron";
const { BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } = electron;
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import { scrubPiiText } from "./selltraces-projector.mjs";

class DemonstrationArtifactStore {
  constructor() {
    this.artifacts = new Map();
  }

  record(name, content, mediaType = "text/plain") {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    const hash = createHash("sha256").update(buf).digest("hex");
    if (!this.artifacts.has(hash)) {
      this.artifacts.set(hash, {
        hash,
        size: buf.length,
        mediaType,
        originalName: name,
        buffer: buf,
      });
    }
    return hash;
  }

  get(hash) {
    return this.artifacts.get(hash) || null;
  }

  getManifest() {
    const manifest = {};
    for (const [hash, item] of this.artifacts.entries()) {
      manifest[hash] = {
        hash: item.hash,
        size: item.size,
        mediaType: item.mediaType,
        originalName: item.originalName,
        buffer: item.buffer,
      };
    }
    return manifest;
  }
}

class DemonstrationProducer {
  constructor({ identity, producerId = "workflow-recorder", producerInstanceId = "desktop-host" }) {
    this.identity = identity;
    this.producerId = producerId;
    this.producerInstanceId = producerInstanceId;
    this.artifactStore = new DemonstrationArtifactStore();
    this.records = [];
    this.sequence = 1;
    this.isSealed = false;
  }

  emit({ kind = "event", observedAtUnixNs = null, payload = {} }) {
    if (this.isSealed) return null;
    const record = {
      record_id: `rec-${this.identity.run_id}-${this.sequence}`,
      run_id: this.identity.run_id,
      trace_id: this.identity.trace_id,
      span_id: this.identity.root_span_id,
      session_id: this.identity.session_id,
      producer_id: this.producerId,
      producer_instance_id: this.producerInstanceId,
      sequence: this.sequence++,
      kind,
      observed_at_unix_ns: observedAtUnixNs || String(BigInt(Date.now()) * 1000000n),
      payload,
    };
    this.records.push(record);
    return record;
  }

  recordArtifact(name, content, mediaType) {
    return this.artifactStore.record(name, content, mediaType);
  }

  seal({ complete = true } = {}) {
    this.isSealed = true;
    return {
      receipt: {
        run_id: this.identity.run_id,
        state: complete ? "sealed_complete" : "sealed_partial",
        seal_verified: true,
      },
      totalRecords: this.records.length,
      artifacts: this.artifactStore.getManifest(),
    };
  }

  getRecords() {
    return [...this.records];
  }
}

let uIOhook = null;
try {
  const mod = await import("uiohook-napi");
  uIOhook = mod.uIOhook || mod.default || mod;
} catch (e) {
  // uiohook is optional in test environments or environments without display server
}

export function slugifyProject(title) {
  if (!title || typeof title !== "string") return "workflow-demo";
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 120);
  return slug || "workflow-demo";
}

// Capture ledger policy version stamped on every policy.recorded event.
export const CAPTURE_POLICY_VERSION = "openrind-vla-capture/1";

// Record kinds that map to valid /internal/capture/events evidence payloads
// (schemas.py EventData union). human_action and screen_observation are NOT
// evidence events; they reach the collector as AGENT spans only.
export const EVIDENCE_EVENT_KINDS = new Set([
  "task.started",
  "episode.started",
  "response.selected",
  "tool.finished",
  "artifact.recorded",
  "outcome.observed",
  "session.closed",
  "policy.recorded",
]);

// Processes whose windows are never captured (no frames, no keystrokes).
// Configured entries extend this default list; they cannot remove it.
export const DEFAULT_EXCLUDED_PROCESSES = Object.freeze([
  "keepass",
  "keepassxc",
  "bitwarden",
  "1password",
  "lastpass",
  "dashlane",
  "enpass",
]);

export function normalizeProcessName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

export function parseExcludedProcesses(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const normalized = entries
    .map((entry) => normalizeProcessName(entry))
    .filter((entry) => entry.length > 0);
  return [...new Set(normalized)];
}

export function isExcludedProcess(processName, excludedProcesses) {
  const normalized = normalizeProcessName(processName);
  if (!normalized || !excludedProcesses) return false;
  const set = excludedProcesses instanceof Set
    ? excludedProcesses
    : new Set(parseExcludedProcesses(excludedProcesses));
  return set.has(normalized);
}

// Masked screen regions applied before JPEG encode. Accepts an array or a
// JSON string of [{ x, y, w, h, display? }]. Coordinates are absolute screen
// pixels; `display` limits a region to one display id ("*" or omitted = all).
export function parseMaskRegions(value) {
  let raw = value;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const regions = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const x = Number(entry.x);
    const y = Number(entry.y);
    const w = Number(entry.w);
    const h = Number(entry.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    regions.push({
      x,
      y,
      w,
      h,
      ...(entry.display !== undefined && entry.display !== null
        ? { display: String(entry.display) }
        : {}),
    });
  }
  return regions;
}

// `trusted` is false until a window poll succeeds. A failed poll keeps the
// last title but marks it untrusted so the recorder masks conservatively
// instead of assuming the stale title is safe.
let cachedActiveWindow = { title: "Desktop Application", process: "DESKTOP", trusted: false };
let windowPollTimer = null;

function isTestEnv() {
  return process.env.NODE_ENV === "test" || process.argv.some((a) => a.includes("test"));
}

function startWindowPolling() {
  if (isTestEnv()) return;
  if (windowPollTimer) return;

  const poll = async () => {
    if (process.platform === "win32") {
      try {
        const psCommand = `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public class Win { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount); [DllImport(\\\"user32.dll\\\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); }'; $hwnd = [Win]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 256; $null = [Win]::GetWindowText($hwnd, $sb, 256); $pidOut = 0; $null = [Win]::GetWindowThreadProcessId($hwnd, [ref]$pidOut); $p = Get-Process -Id $pidOut -ErrorAction SilentlyContinue; @{ title = $sb.ToString(); process = $p.ProcessName } | ConvertTo-Json -Compress"`;
        const { stdout } = await execAsync(psCommand, { timeout: 4000 });
        if (stdout) {
          const parsed = JSON.parse(stdout.trim());
          cachedActiveWindow = {
            title: parsed.title || "Desktop",
            process: (parsed.process || "unknown").toUpperCase(),
            trusted: true,
          };
        } else {
          cachedActiveWindow = { ...cachedActiveWindow, trusted: false };
        }
      } catch {
        cachedActiveWindow = { ...cachedActiveWindow, trusted: false };
      }
    }
  };

  void poll();
  windowPollTimer = setInterval(poll, 2500);
}

function stopWindowPolling() {
  if (windowPollTimer) {
    clearInterval(windowPollTimer);
    windowPollTimer = null;
  }
}

export function getActiveWindow() {
  if (isTestEnv()) {
    return { title: "Test Window", process: "TEST", trusted: true };
  }
  return cachedActiveWindow;
}

export class DemonstrationRecorder {
  constructor({
    getMainWindow,
    postCollectorEvents,
    getActiveWindow: getActiveWindowOverride,
  }) {
    this.getMainWindow = getMainWindow;
    this.postCollectorEvents = postCollectorEvents;
    this.getActiveWindowFn = typeof getActiveWindowOverride === "function"
      ? getActiveWindowOverride
      : getActiveWindow;
    this.activeSession = null;
    this.floatingWindow = null;
    this.captureTimer = null;
    this.lastFrameHash = null;
    this.isCapturing = false;
    this.pendingAttestation = null;
  }

  async start({ taskTitle, domain = "desktop_gui", captureIntervalMs = 1500, scrubPii = true, collectorUrl = "", adminToken = "", trainingConsent = false, excludedProcesses = null, maskRegions = null }) {
    if (this.activeSession) {
      throw new Error("A demonstration recording is already in progress.");
    }

    const mainWindow = this.getMainWindow?.();
    const cleanTitle = (taskTitle || "Human Workflow Demonstration").trim();
    const projectId = slugifyProject(cleanTitle);
    const runId = `demo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const sessionId = `session-${runId}`;
    const traceId = createHash("md5").update(runId).digest("hex");

    const identity = {
      run_id: runId,
      task_id: projectId,
      session_id: sessionId,
      trace_id: traceId,
      root_span_id: traceId.slice(0, 16),
    };

    const producer = new DemonstrationProducer({
      identity,
      producerId: "workflow-recorder",
      producerInstanceId: "desktop-host",
    });

    // A new session invalidates any unanswered attestation from a prior run.
    this.pendingAttestation = null;

    const excludedProcessSet = new Set([
      ...DEFAULT_EXCLUDED_PROCESSES,
      ...parseExcludedProcesses(process.env.OPENRIND_VLA_EXCLUDED_PROCESSES),
      ...parseExcludedProcesses(excludedProcesses),
    ]);
    const maskRegionList = [
      ...parseMaskRegions(process.env.OPENRIND_VLA_MASK_REGIONS),
      ...parseMaskRegions(maskRegions),
    ];

    this.activeSession = {
      taskTitle: cleanTitle,
      projectId,
      runId,
      sessionId,
      traceId,
      startedAt: new Date().toISOString(),
      producer,
      framesCount: 0,
      inputEventsCount: 0,
      scrubPii,
      collectorUrl: (collectorUrl || "").trim(),
      adminToken: (adminToken || "").trim(),
      isPaused: false,
      captureIntervalMs: Math.max(500, captureIntervalMs),
      trainingConsent: trainingConsent === true,
      excludedProcesses: excludedProcessSet,
      maskRegions: maskRegionList,
      captureGaps: [],
      maskingLogged: false,
      excludedSkips: 0,
    };

    // Emit task.started host event
    producer.emit({
      kind: "task.started",
      payload: {
        type: "task.started",
        task_id: projectId,
        attempt_id: runId,
        domain: "other",
        instruction: scrubPii ? scrubPiiText(cleanTitle) : cleanTitle,
        harness: {
          name: "openrind-workflow-recorder",
          version: "1.0.0",
          protocol: "human_vla_demonstration",
        },
      },
    });

    // Record the capture consent policy for this session. Training use is
    // opt-in: without explicit consent the session is marked opted out.
    producer.emit({
      kind: "policy.recorded",
      payload: {
        type: "policy.recorded",
        policy_version: CAPTURE_POLICY_VERSION,
        training_opt_out: !this.activeSession.trainingConsent,
      },
    });

    // Create the floating widget window
    await this._createFloatingWindow();

    // Minimize main window to let user work on their desktop
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }

    // Start screen capture loop & mouse/cursor position tracking
    this._startCaptureLoop();
    this._startMouseTracker();
    this._startGlobalInputHook();
    startWindowPolling();

    // Baseline initial snapshot frame
    void this.captureSnapshot({ trigger: "initial" });

    return {
      started: true,
      projectId,
      runId,
      taskTitle: cleanTitle,
    };
  }

  _startMouseTracker() {
    if (isTestEnv()) return;
    this.mouseTimer = setInterval(() => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      try {
        const point = screen?.getCursorScreenPoint?.();
        if (point && (!this.lastPoint || Math.abs(point.x - this.lastPoint.x) > 40 || Math.abs(point.y - this.lastPoint.y) > 40)) {
          this.lastPoint = point;
          this.activeSession.lastCursorPoint = point;
        }
      } catch {}
    }, 200);
  }

  _stopMouseTracker() {
    if (this.mouseTimer) {
      clearInterval(this.mouseTimer);
      this.mouseTimer = null;
    }
  }

  _startGlobalInputHook() {
    if (isTestEnv() || !uIOhook || typeof uIOhook.start !== "function") return;

    this.onMouseDown = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      if (this._isExcludedWindow(this.getActiveWindowFn())) return;
      const buttonName = e.button === 1 ? "left" : e.button === 2 ? "right" : "middle";
      this.recordInputEvent({
        type: "mouse_click",
        button: buttonName,
        x: e.x,
        y: e.y,
        clicks: e.clicks || 1,
        timestamp: Date.now(),
      });
    };

    this.onMouseWheel = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      if (this._isExcludedWindow(this.getActiveWindowFn())) return;
      this.recordInputEvent({
        type: "mouse_scroll",
        x: e.x,
        y: e.y,
        rotation: e.rotation || 0,
        amount: e.amount || 0,
        timestamp: Date.now(),
      });
    };

    this.textBuffer = "";
    this.textDebounce = null;

    const keycodeMap = {
      2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
      12: "-", 13: "=", 14: "[Backspace]", 15: "[Tab]",
      16: "q", 17: "w", 18: "e", 19: "r", 20: "t", 21: "y", 22: "u", 23: "i", 24: "o", 25: "p",
      26: "[", 27: "]", 28: "[Enter]",
      30: "a", 31: "s", 32: "d", 33: "f", 34: "g", 35: "h", 36: "j", 37: "k", 38: "l",
      39: ";", 40: "'", 41: "`",
      44: "z", 45: "x", 46: "c", 47: "v", 48: "b", 49: "n", 50: "m",
      51: ",", 52: ".", 53: "/", 57: " ",
      3675: "[Windows]", 3676: "[Windows]", 3612: "[Enter]",
    };

    const flushText = () => {
      if (this.textBuffer) {
        const text = this.textBuffer;
        this.textBuffer = "";
        this.recordInputEvent({
          type: "type_text",
          text,
          timestamp: Date.now(),
        });
      }
    };

    this.onKeyDown = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;

      // Never buffer keystrokes typed into an excluded window (password
      // managers). Drop anything already buffered for the same reason.
      if (this._isExcludedWindow(this.getActiveWindowFn())) {
        this.textBuffer = "";
        return;
      }

      const specialKey = keycodeMap[e.keycode];

      // Handle hotkeys and special keys
      if (e.keycode === 3675 || e.keycode === 3676) { // Windows Key
        flushText();
        this.recordInputEvent({
          type: "key_press",
          key: "Super",
        });
        return;
      }

      if (e.keycode === 28 || e.keycode === 3612) { // Enter
        flushText();
        this.recordInputEvent({
          type: "key_press",
          key: "Enter",
        });
        return;
      }

      if (e.keycode === 14) { // Backspace
        if (this.textBuffer.length > 0) {
          this.textBuffer = this.textBuffer.slice(0, -1);
        } else {
          this.recordInputEvent({
            type: "key_press",
            key: "Backspace",
          });
        }
        return;
      }

      let char = null;
      if (e.keychar && e.keychar >= 32) {
        char = String.fromCharCode(e.keychar);
      } else if (specialKey && !specialKey.startsWith("[")) {
        char = specialKey;
      }

      if (char) {
        this.textBuffer += char;
        if (this.textDebounce) clearTimeout(this.textDebounce);
        this.textDebounce = setTimeout(flushText, 350);
      }
    };

    this.onKeyTyped = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      if (this._isExcludedWindow(this.getActiveWindowFn())) {
        this.textBuffer = "";
        return;
      }
      const rawCode = e.keychar || e.rawcode || 0;
      if (rawCode >= 32) {
        const char = String.fromCharCode(rawCode);
        if (char && !this.textBuffer.endsWith(char)) {
          this.textBuffer += char;
        }
        if (this.textDebounce) clearTimeout(this.textDebounce);
        this.textDebounce = setTimeout(flushText, 350);
      }
    };

    try {
      uIOhook.removeAllListeners?.();
      uIOhook.on("mousedown", this.onMouseDown);
      uIOhook.on("wheel", this.onMouseWheel);
      uIOhook.on("keydown", this.onKeyDown);
      uIOhook.on("keytyped", this.onKeyTyped);
      uIOhook.start();
    } catch (err) {
      console.warn("[DemonstrationRecorder] uIOhook start warning:", err);
    }
  }

  _stopGlobalInputHook() {
    if (!uIOhook) return;
    try {
      if (this.onMouseDown) uIOhook.off("mousedown", this.onMouseDown);
      if (this.onMouseWheel) uIOhook.off("wheel", this.onMouseWheel);
      if (this.onKeyDown) uIOhook.off("keydown", this.onKeyDown);
      if (this.onKeyTyped) uIOhook.off("keytyped", this.onKeyTyped);
      uIOhook.stop();
    } catch {}
  }

  _isExcludedWindow(activeWindow) {
    if (!this.activeSession) return false;
    return isExcludedProcess(activeWindow?.process, this.activeSession.excludedProcesses);
  }

  _noteCaptureGap(gap) {
    const gaps = this.activeSession?.captureGaps;
    if (!gaps || gaps.includes(gap) || gaps.length >= 1000) return;
    gaps.push(gap);
  }

  _noteMaskingActivated(reason) {
    if (!this.activeSession || this.activeSession.maskingLogged) return;
    this.activeSession.maskingLogged = true;
    console.warn(`[DemonstrationRecorder] Secure-input masking activated for this session (${reason}). Typed text is masked.`);
  }

  // Black out configured regions of a captured frame before JPEG encode.
  // Region coordinates are absolute screen pixels; they are clipped to the
  // captured display and scaled to the thumbnail size.
  _applyMaskRegions(image, display) {
    const regions = this.activeSession?.maskRegions || [];
    if (regions.length === 0) return image;
    const size = image.getSize();
    const bounds = display?.bounds || { x: 0, y: 0, width: size.width, height: size.height };
    const applicable = regions.filter((region) =>
      !region.display || region.display === "*" || String(region.display) === String(display?.id)
    );
    if (applicable.length === 0) return image;
    const scaleX = bounds.width > 0 ? size.width / bounds.width : 1;
    const scaleY = bounds.height > 0 ? size.height / bounds.height : 1;
    const bitmap = image.toBitmap();
    for (const region of applicable) {
      const x0 = Math.max(0, Math.round((region.x - (bounds.x || 0)) * scaleX));
      const y0 = Math.max(0, Math.round((region.y - (bounds.y || 0)) * scaleY));
      const x1 = Math.min(size.width, Math.round((region.x - (bounds.x || 0) + region.w) * scaleX));
      const y1 = Math.min(size.height, Math.round((region.y - (bounds.y || 0) + region.h) * scaleY));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const offset = (y * size.width + x) * 4;
          bitmap[offset] = 0;
          bitmap[offset + 1] = 0;
          bitmap[offset + 2] = 0;
          bitmap[offset + 3] = 255;
        }
      }
    }
    return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
  }

  _startCaptureLoop() {
    this.captureTimer = setInterval(async () => {
      if (!this.activeSession || this.activeSession.isPaused || this.isCapturing) {
        return;
      }
      this.isCapturing = true;
      try {
        await this.captureSnapshot({ trigger: "interval" });
      } catch (err) {
        console.error("[DemonstrationRecorder] Snapshot capture error:", err);
      } finally {
        this.isCapturing = false;
      }
    }, this.activeSession.captureIntervalMs);
  }

  async captureSnapshot({ trigger = "manual", action = null } = {}) {
    if (!this.activeSession) return null;

    // Excluded windows (password managers) are never captured: no frames.
    const activeWindow = await this.getActiveWindowFn();
    if (this._isExcludedWindow(activeWindow)) {
      this.activeSession.excludedSkips++;
      this._noteCaptureGap(`excluded_window:${normalizeProcessName(activeWindow?.process)}`);
      return null;
    }

    if (isTestEnv() || !desktopCapturer?.getSources) return null;

    let cursor = { x: 0, y: 0 };
    let currentDisplay = null;
    if (!isTestEnv()) {
      try {
        const explicitPoint = (action?.x !== undefined && action?.y !== undefined)
          ? { x: action.x, y: action.y }
          : null;
        cursor = explicitPoint || screen?.getCursorScreenPoint?.() || this.activeSession.lastCursorPoint || { x: 0, y: 0 };
        currentDisplay = screen?.getDisplayNearestPoint?.(cursor) || screen?.getPrimaryDisplay?.();
      } catch {}
    }

    const targetWidth = currentDisplay?.bounds?.width || 1920;
    const targetHeight = currentDisplay?.bounds?.height || 1080;

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: targetWidth, height: targetHeight },
      fetchWindowIcons: false,
    });

    if (!sources || sources.length === 0) return null;

    // Multi-monitor: select the screen source matching the display where the cursor/window is
    let targetSource = sources[0];
    if (currentDisplay && sources.length > 1) {
      const displayIdStr = String(currentDisplay.id);
      const matched = sources.find((s) => s.display_id === displayIdStr || s.id.includes(displayIdStr));
      if (matched) targetSource = matched;
    }

    let image = targetSource.thumbnail;
    if (!image || image.isEmpty()) return null;

    // Mask configured screen regions before encoding. If masking fails the
    // frame is dropped rather than uploaded unmasked.
    if (this.activeSession.maskRegions.length > 0) {
      try {
        image = this._applyMaskRegions(image, currentDisplay);
      } catch (err) {
        console.error("[DemonstrationRecorder] Frame region masking failed; dropping frame:", err);
        return null;
      }
    }

    // Convert to WebP or JPEG buffer
    const buffer = image.toJPEG(85);
    const frameHash = createHash("sha256").update(buffer).digest("hex");

    // Skip static frame if unchanged and not an explicit user input action
    if (trigger === "interval" && this.lastFrameHash === frameHash && !action) {
      return null;
    }
    this.lastFrameHash = frameHash;

    const base64Data = buffer.toString("base64");
    const artifactName = `screen-${Date.now()}-${this.activeSession.framesCount + 1}.jpeg`;

    const artifactHash = this.activeSession.producer.recordArtifact(
      artifactName,
      buffer,
      "image/jpeg",
    );

    // Stream image frame artifact immediately to collector in the background if configured
    const collectorBase = (this.activeSession?.collectorUrl || process.env.HALOOP_COLLECTOR_URL || "").trim().replace(/\/+$/, "");
    const targetArtifactsUrl = collectorBase
      ? `${collectorBase}/artifacts`
      : (process.env.HALOOP_ARTIFACTS_URL?.trim() || "");
    const authHeaders = this.activeSession?.adminToken
      ? { Authorization: `Bearer ${this.activeSession.adminToken}`, "X-Admin-Token": this.activeSession.adminToken }
      : {};

    if (targetArtifactsUrl) {
      fetch(targetArtifactsUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({
          artifact_id: artifactName,
          sha256: frameHash,
          content: base64Data,
          content_type: "image/jpeg",
        }),
      }).then(async (res) => {
        if (!res.ok) {
          const snippet = await res.text().then((t) => t.slice(0, 300)).catch(() => "");
          console.warn(`[DemonstrationRecorder] Frame artifact POST failed: HTTP ${res.status}${snippet ? ` — ${snippet}` : ""}`);
        }
      }).catch((err) => {
        console.warn("[DemonstrationRecorder] Failed to stream frame artifact:", err?.message || err);
      });
    }

    let activeWin = activeWindow;
    if (this.activeSession.scrubPii && activeWin?.title) {
      activeWin = { ...activeWin, title: scrubPiiText(activeWin.title) };
    }
    const titleTrusted = activeWin?.trusted !== false;

    const displayBounds = currentDisplay?.bounds || { x: 0, y: 0, width: targetWidth, height: targetHeight };
    const framePayload = {
      artifactId: artifactName,
      artifactHash,
      artifactUrl: targetArtifactsUrl ? `${targetArtifactsUrl.replace(/\/+$/, "")}/${artifactName}` : `/${artifactName}`,
      sha256: frameHash,
      width: image.getSize().width,
      height: image.getSize().height,
      display: {
        id: currentDisplay?.id ?? "primary",
        bounds: displayBounds,
        scaleFactor: currentDisplay?.scaleFactor || 1,
      },
      cursor: {
        x: cursor.x,
        y: cursor.y,
        relativeX: Math.max(0, Math.min(displayBounds.width, cursor.x - displayBounds.x)),
        relativeY: Math.max(0, Math.min(displayBounds.height, cursor.y - displayBounds.y)),
      },
      activeWindow: { ...activeWin, titleTrusted },
      trigger,
      action: action || null,
    };

    const event = this.activeSession.producer.emit({
      kind: "screen_observation",
      observedAtUnixNs: String(BigInt(Date.now()) * 1000000n),
      payload: framePayload,
    });

    this.activeSession.lastFrame = {
      artifactId: artifactName,
      artifactUrl: framePayload.artifactUrl,
      sha256: frameHash,
      width: image.getSize().width,
      height: image.getSize().height,
      timestamp: Date.now(),
    };

    this.activeSession.framesCount++;
    this._updateFloatingState();
    return event;
  }

  recordInputEvent(actionData) {
    if (!this.activeSession || this.activeSession.isPaused) return Promise.resolve(null);
    this._actionQueue = (this._actionQueue || Promise.resolve()).then(async () => {
      return this._recordInputEventInternal(actionData);
    }).catch((err) => {
      console.warn("[DemonstrationRecorder] Action queue error:", err);
      return null;
    });
    return this._actionQueue;
  }

  async _recordInputEventInternal(actionData) {
    if (!this.activeSession || this.activeSession.isPaused) return null;

    let activeWin = await this.getActiveWindowFn();
    // Excluded windows (password managers) never produce input events.
    if (this._isExcludedWindow(activeWin)) {
      this.activeSession.excludedSkips++;
      this._noteCaptureGap(`excluded_window:${normalizeProcessName(activeWin?.process)}`);
      return null;
    }
    if (this.activeSession.scrubPii && activeWin?.title) {
      activeWin = { ...activeWin, title: scrubPiiText(activeWin.title) };
    }
    // The window title is untrusted input. When title polling failed, the
    // cached title may be stale, so treat the interval as potentially
    // sensitive and mask typed text instead of assuming the title is safe.
    const titleTrusted = activeWin?.trusted !== false;
    const actionTimestamp = actionData.timestamp || Date.now();
    const frameBefore = this.activeSession.lastFrame || null;

    this.activeSession.inputEventsCount++;

    // 1. Scrub PII on input actions immediately before capture or emission (with password masking)
    const scrubbedAction = { ...actionData };
    if (this.activeSession.scrubPii && typeof scrubbedAction.text === "string") {
      const winLower = (activeWin?.title || "").toLowerCase();
      const isAuthContext = /password|passcode|passphrase|log[ -]?in|sign[ -]?in|\bpin\b|credentials|sudo|authenticate/i.test(winLower);
      if (isAuthContext || scrubbedAction.isPassword || !titleTrusted) {
        if (!titleTrusted && !isAuthContext && !scrubbedAction.isPassword) {
          this._noteMaskingActivated("window title unavailable");
        } else {
          this._noteMaskingActivated("sensitive window context");
        }
        scrubbedAction.text = "••••••••";
      } else {
        scrubbedAction.text = scrubPiiText(scrubbedAction.text);
      }
    }

    // Attach normalized coordinates if spatial coordinates exist
    const bounds = frameBefore?.display?.bounds || { width: 1920, height: 1080 };
    if (scrubbedAction.x !== undefined && scrubbedAction.y !== undefined) {
      scrubbedAction.normalizedX = bounds.width > 0 ? Number(((scrubbedAction.x - (bounds.x || 0)) / bounds.width).toFixed(4)) : 0;
      scrubbedAction.normalizedY = bounds.height > 0 ? Number(((scrubbedAction.y - (bounds.y || 0)) / bounds.height).toFixed(4)) : 0;
    }

    // 2. Add settling delay (~100ms) so OS/GPU finishes repainting active window
    if (!isTestEnv()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 3. Strict action-to-observation pairing: capture settled post-action frame
    let frameAfter = null;
    try {
      const snapEvent = await this.captureSnapshot({ trigger: "action", action: scrubbedAction });
      const snapPayload = /** @type {any} */ (snapEvent?.payload);
      if (snapPayload) {
        frameAfter = {
          artifactId: snapPayload.artifactId,
          artifactUrl: snapPayload.artifactUrl,
          sha256: snapPayload.sha256,
          width: snapPayload.width,
          height: snapPayload.height,
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      console.warn("[DemonstrationRecorder] Frame after action capture failed:", err);
    }

    if (!frameAfter && this.activeSession.lastFrame) {
      frameAfter = this.activeSession.lastFrame;
    }

    const event = this.activeSession.producer.emit({
      kind: "human_action",
      observedAtUnixNs: String(BigInt(Date.now()) * 1000000n),
      payload: {
        ...scrubbedAction,
        activeWindow: { ...activeWin, titleTrusted },
        timestamp: actionTimestamp,
        frame_before: frameBefore,
        frame_after: frameAfter,
      },
    });

    this._updateFloatingState();
    return event;
  }

  pause() {
    if (!this.activeSession) return;
    this.activeSession.isPaused = true;
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    this._updateFloatingState();
  }

  resume() {
    if (!this.activeSession) return;
    this.activeSession.isPaused = false;
    this._startCaptureLoop();
    this._updateFloatingState();
  }

  async stop() {
    if (!this.activeSession) {
      if (this.lastCompletedResult) {
        return this.lastCompletedResult;
      }
      throw new Error("No active demonstration recording to stop.");
    }
    if (this.isStopping) {
      return this.stoppingPromise;
    }
    this.isStopping = true;

    this.stoppingPromise = (async () => {
      if (this.captureTimer) {
        clearInterval(this.captureTimer);
        this.captureTimer = null;
      }
      this._stopMouseTracker();
      this._stopGlobalInputHook();
      stopWindowPolling();

      const session = this.activeSession;
      this.activeSession = null;
      this.lastFrameHash = null;

      const producer = session.producer;
      let sealResult = null;
      let records = [];

      try {
        records = producer.getRecords();
        const finalActionCount = records.filter((r) => r.kind === "human_action").length;
        if (!producer.isSealed) {
          // Host evidence events emitted before the closure; the closure
          // itself is excluded from the inventory per the capture contract.
          const hostEventIds = records
            .filter((r) => EVIDENCE_EVENT_KINDS.has(r.kind) && r.kind !== "session.closed")
            .map((r) => r.record_id);
          producer.emit({
            kind: "session.closed",
            payload: {
              type: "session.closed",
              reason: "completed",
              // A human demonstration makes no model requests, so the
              // expected request inventory is honestly empty.
              expected_request_ids: [],
              expected_event_ids: hostEventIds,
              capture_gaps: [...session.captureGaps],
            },
          });
          sealResult = producer.seal({ complete: true });
        }
        records = producer.getRecords();
      } catch (err) {
        console.warn("[DemonstrationRecorder] Seal warning:", err);
      }

      const finalActionCount = records.filter((r) => r.kind === "human_action").length;

      // Immediately notify the main window UI that recording has ended
      const mainWindow = this.getMainWindow?.();
      try {
        mainWindow?.webContents?.send("demonstration-status-change", {
          recording: false,
          session: null,
          result: {
            success: true,
            projectId: session.projectId || "demonstration",
            taskTitle: session.taskTitle || "Task",
            framesCount: session.framesCount || 0,
            actionsCount: finalActionCount,
            transmitted: true,
          },
        });
      } catch {}

      // Immediately close floating widget and restore main window so the user is never kept waiting
      if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
        this.floatingWindow.close();
        this.floatingWindow = null;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        if (typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) {
          mainWindow.restore?.();
        }
        mainWindow.show?.();
        mainWindow.focus?.();
      }

      // Post records to collector in the background
      let transmitted = false;
      if (this.postCollectorEvents) {
        try {
          await this.postCollectorEvents({
            project: session.projectId,
            sessionId: session.sessionId,
            traceId: session.traceId,
            records,
            artifacts: sealResult?.artifacts || {},
          });
          transmitted = true;
        } catch (err) {
          console.warn("[DemonstrationRecorder] Failed to stream events to Haloop:", err);
        }
      }

      // Context for the end-of-session user attestation (outcome.observed).
      // The subject hash commits to the sealed session inventory so the
      // verdict names exactly what was recorded.
      const subjectSha256 = createHash("sha256").update(JSON.stringify({
        session_id: session.sessionId,
        trace_id: session.traceId,
        record_ids: records.map((r) => r.record_id),
        artifact_hashes: Object.keys(sealResult?.artifacts || {}).sort(),
      })).digest("hex");
      this.pendingAttestation = {
        project: session.projectId,
        sessionId: session.sessionId,
        traceId: session.traceId,
        taskId: session.projectId,
        attemptId: session.runId,
        runId: session.runId,
        subjectSha256,
      };

      this.lastCompletedResult = {
        success: true,
        projectId: session.projectId,
        taskTitle: session.taskTitle,
        runId: session.runId,
        sessionId: session.sessionId,
        traceId: session.traceId,
        framesCount: session.framesCount,
        actionsCount: finalActionCount,
        transmitted,
        recordsCount: records.length,
        receipt: sealResult?.receipt || null,
      };

      this.isStopping = false;
      return this.lastCompletedResult;
    })();

    return this.stoppingPromise;
  }

  /**
   * Record the user's end-of-session attestation as capture evidence:
   * an artifact.recorded holding the attestation, then an outcome.observed
   * that references it. One-shot per session; a skip emits nothing and the
   * session keeps its downstream default. Never blocks stopping — stop()
   * has already completed when this runs.
   */
  async attestOutcome({ completed }) {
    const pending = this.pendingAttestation;
    if (!pending) {
      return { emitted: false, reason: "no_pending_attestation" };
    }
    this.pendingAttestation = null;
    if (!this.postCollectorEvents) {
      return { emitted: false, reason: "no_collector" };
    }

    const answeredAt = new Date().toISOString();
    const observedAtUnixNs = String(BigInt(Date.now()) * 1000000n);
    const attestationId = `att-${pending.runId}`;
    const attestationContent = JSON.stringify({
      prompt: "Did you complete what you intended?",
      answer: completed ? "yes" : "no",
      answered_at: answeredAt,
      session_id: pending.sessionId,
      task_id: pending.taskId,
      attempt_id: pending.attemptId,
    });

    const records = [
      {
        record_id: attestationId,
        observed_at_unix_ns: observedAtUnixNs,
        kind: "artifact.recorded",
        payload: {
          type: "artifact.recorded",
          artifact_id: attestationId,
          kind: "other",
          content: attestationContent,
          content_type: "application/json",
          boundary: "observation",
        },
      },
      {
        record_id: `out-${pending.runId}`,
        observed_at_unix_ns: observedAtUnixNs,
        kind: "outcome.observed",
        payload: {
          type: "outcome.observed",
          task_id: pending.taskId,
          attempt_id: pending.attemptId,
          // The host relays the demonstrator's own report; the capture API
          // maps self_report outcomes to the host producer role.
          origin: "self_report",
          verdict: completed ? "pass" : "fail",
          subject_sha256: pending.subjectSha256,
          verifier_name: "desktop-user-attestation",
          verifier_version: "1.0.0",
          evidence_artifact_ids: [attestationId],
        },
      },
    ];

    await this.postCollectorEvents({
      project: pending.project,
      sessionId: pending.sessionId,
      traceId: pending.traceId,
      records,
      artifacts: {},
    });
    return { emitted: true, verdict: completed ? "pass" : "fail" };
  }

  async _createFloatingWindow() {
    if (isTestEnv()) return;
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      return;
    }

    let primaryDisplay = null;
    try {
      primaryDisplay = screen?.getPrimaryDisplay?.();
    } catch {}
    if (!primaryDisplay?.workAreaSize) return;
    const { width, height } = primaryDisplay.workAreaSize;

    // Small pill in bottom-right corner
    const widgetWidth = 320;
    const widgetHeight = 70;
    const x = width - widgetWidth - 24;
    const y = height - widgetHeight - 24;

    this.floatingWindow = new BrowserWindow({
      width: widgetWidth,
      height: widgetHeight,
      x,
      y,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      transparent: true,
      hasShadow: true,
      focusable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    // Content protection prevents the widget itself from appearing in OS screen captures on Windows/macOS!
    this.floatingWindow.setContentProtection(true);

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
          body {
            background: #121218;
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 20px;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 14px;
            height: 100vh;
            -webkit-app-region: drag;
          }
          .info { display: flex; align-items: center; gap: 10px; font-size: 13px; }
          .rec-dot {
            width: 10px; height: 10px; border-radius: 50%;
            background-color: #ef4444;
            animation: pulse 1.5s infinite;
          }
          .rec-dot.paused { background-color: #f59e0b; animation: none; }
          @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.9); } 100% { opacity: 1; transform: scale(1); } }
          .time { font-family: monospace; font-weight: 600; font-size: 14px; }
          .frames { font-size: 11px; color: #a1a1aa; }
          .btn-group { display: flex; gap: 8px; -webkit-app-region: no-drag; }
          button {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #e4e4e7;
            padding: 5px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          button:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
          button.finish { background: #dc2626; border-color: #b91c1c; color: #fff; }
          button.finish:hover { background: #b91c1c; }
        </style>
      </head>
      <body>
        <div class="info">
          <div id="dot" class="rec-dot"></div>
          <div>
            <div id="timer" class="time">00:00</div>
            <div id="frames" class="frames">0 frames</div>
          </div>
        </div>
        <div class="btn-group">
          <button id="pauseBtn" onclick="togglePause()">Pause</button>
          <button class="finish" onclick="finish()">Finish</button>
        </div>
        <script>
          let startTime = Date.now();
          let timerEl = document.getElementById('timer');
          let framesEl = document.getElementById('frames');
          let dotEl = document.getElementById('dot');
          let pauseBtn = document.getElementById('pauseBtn');
          let isPaused = false;

          setInterval(() => {
            if (!isPaused) {
              let diff = Math.floor((Date.now() - startTime) / 1000);
              let m = String(Math.floor(diff / 60)).padStart(2, '0');
              let s = String(diff % 60).padStart(2, '0');
              timerEl.textContent = m + ':' + s;
            }
          }, 1000);

          function togglePause() {
            isPaused = !isPaused;
            dotEl.className = isPaused ? 'rec-dot paused' : 'rec-dot';
            pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('demonstration-widget-action', isPaused ? 'pause' : 'resume');
          }

          function finish() {
            let finishBtn = document.querySelector('.finish');
            if (finishBtn) finishBtn.textContent = 'Saving...';
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('demonstration-widget-action', 'finish');
          }
        </script>
      </body>
      </html>
    `;

    await this.floatingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

    // Listen for floating widget actions directly on ipcMain for instant response
    ipcMain.removeAllListeners("demonstration-widget-action");
    ipcMain.on("demonstration-widget-action", async (_evt, action) => {
      if (action === "pause") {
        this.pause();
        const mainWindow = this.getMainWindow?.();
        mainWindow?.webContents.send("demonstration-status-change", {
          recording: true,
          session: this.activeSession ? {
            taskTitle: this.activeSession.taskTitle,
            projectId: this.activeSession.projectId,
            startedAt: this.activeSession.startedAt,
            framesCount: this.activeSession.framesCount,
            isPaused: true,
          } : null,
        });
      } else if (action === "resume") {
        this.resume();
        const mainWindow = this.getMainWindow?.();
        mainWindow?.webContents.send("demonstration-status-change", {
          recording: true,
          session: this.activeSession ? {
            taskTitle: this.activeSession.taskTitle,
            projectId: this.activeSession.projectId,
            startedAt: this.activeSession.startedAt,
            framesCount: this.activeSession.framesCount,
            isPaused: false,
          } : null,
        });
      } else if (action === "finish") {
        try {
          const result = await this.stop();
          const mainWindow = this.getMainWindow?.();
          mainWindow?.webContents.send("demonstration-status-change", {
            recording: false,
            session: null,
            result,
          });
        } catch (err) {
          console.error("[DemonstrationRecorder] Error stopping recording from widget:", err);
        }
      }
    });
  }

  _updateFloatingState() {
    if (isTestEnv() || !this.floatingWindow || this.floatingWindow.isDestroyed() || !this.activeSession) return;
    const frames = this.activeSession.framesCount;
    this.floatingWindow.webContents.executeJavaScript(`
      if (document.getElementById('frames')) {
        document.getElementById('frames').textContent = '${frames} frames';
      }
    `).catch(() => {});

    // Sync live frame count & duration with main window UI
    const mainWindow = this.getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("demonstration-status-change", {
        recording: true,
        session: {
          taskTitle: this.activeSession.taskTitle,
          projectId: this.activeSession.projectId,
          startedAt: this.activeSession.startedAt,
          framesCount: this.activeSession.framesCount,
          isPaused: this.activeSession.isPaused,
        },
      });
    }
  }
}
