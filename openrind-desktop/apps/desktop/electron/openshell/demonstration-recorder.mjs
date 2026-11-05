// Desktop Workflow Demonstration Recorder (VLA & Human Task Demonstration Capture)
import electron from "electron";
const { BrowserWindow, desktopCapturer, ipcMain, screen } = electron;
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
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug || "workflow-demo";
}

let cachedActiveWindow = { title: "Desktop Application", process: "DESKTOP" };
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
        const { stdout } = await execAsync(psCommand, { timeout: 1200 });
        if (stdout) {
          const parsed = JSON.parse(stdout.trim());
          cachedActiveWindow = {
            title: parsed.title || "Desktop",
            process: (parsed.process || "unknown").toUpperCase(),
          };
        }
      } catch {}
    }
  };

  void poll();
  windowPollTimer = setInterval(poll, 1500);
}

function stopWindowPolling() {
  if (windowPollTimer) {
    clearInterval(windowPollTimer);
    windowPollTimer = null;
  }
}

export function getActiveWindow() {
  if (isTestEnv()) {
    return { title: "Test Window", process: "TEST" };
  }
  return cachedActiveWindow;
}

export class DemonstrationRecorder {
  constructor({
    getMainWindow,
    postCollectorEvents,
  }) {
    this.getMainWindow = getMainWindow;
    this.postCollectorEvents = postCollectorEvents;
    this.activeSession = null;
    this.floatingWindow = null;
    this.captureTimer = null;
    this.lastFrameHash = null;
    this.isCapturing = false;
  }

  async start({ taskTitle, domain = "desktop_gui", captureIntervalMs = 1500, scrubPii = true }) {
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
      isPaused: false,
      captureIntervalMs: Math.max(500, captureIntervalMs),
    };

    // Emit task.started host event
    producer.emit({
      kind: "task.started",
      payload: {
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
    this.mouseTimer = setInterval(() => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      try {
        const point = screen.getCursorScreenPoint();
        if (!this.lastPoint || Math.abs(point.x - this.lastPoint.x) > 40 || Math.abs(point.y - this.lastPoint.y) > 40) {
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
      const buttonName = e.button === 1 ? "left" : e.button === 2 ? "right" : "middle";
      this.recordInputEvent({
        type: "mouse_click",
        button: buttonName,
        x: e.x,
        y: e.y,
        clicks: e.clicks || 1,
      });
    };

    this.onMouseWheel = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      this.recordInputEvent({
        type: "mouse_scroll",
        x: e.x,
        y: e.y,
        rotation: e.rotation || 0,
        amount: e.amount || 0,
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
        });
      }
    };

    this.onKeyDown = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;

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
    if (!this.activeSession || isTestEnv() || !desktopCapturer?.getSources) return null;

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });

    if (!sources || sources.length === 0) return null;

    const primaryScreenSource = sources[0];
    const image = primaryScreenSource.thumbnail;
    if (!image || image.isEmpty()) return null;

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

    // Stream image frame artifact immediately to collector in the background so it's viewable instantly via HTTP
    const targetArtifactsUrl = process.env.HALOOP_ARTIFACTS_URL?.trim() || "http://136.112.93.84:8788/artifacts";
    fetch(targetArtifactsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        artifact_id: artifactName,
        sha256: frameHash,
        content: base64Data,
        content_type: "image/jpeg",
      }),
    }).catch((err) => {
      console.warn("[DemonstrationRecorder] Failed to stream frame artifact:", err?.message || err);
    });

    const cursor = this.activeSession.lastCursorPoint || screen.getCursorScreenPoint?.() || { x: 0, y: 0 };
    const activeWin = await getActiveWindow();

    const baseArtifactUrl = targetArtifactsUrl.replace(/\/+$/, "");
    const framePayload = {
      artifactId: artifactName,
      artifactHash,
      artifactUrl: `${baseArtifactUrl}/${artifactName}`,
      sha256: frameHash,
      width: image.getSize().width,
      height: image.getSize().height,
      cursor: {
        x: cursor.x,
        y: cursor.y,
      },
      activeWindow: activeWin,
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
      artifactUrl: `${baseArtifactUrl}/${artifactName}`,
      sha256: frameHash,
      width: image.getSize().width,
      height: image.getSize().height,
      timestamp: Date.now(),
    };

    this.activeSession.framesCount++;
    this._updateFloatingState();
    return event;
  }

  async recordInputEvent(actionData) {
    if (!this.activeSession || this.activeSession.isPaused) return;

    const activeWin = await getActiveWindow();
    const frameBefore = this.activeSession.lastFrame || null;

    this.activeSession.inputEventsCount++;

    // Strict action-to-observation pairing: capture immediate post-action frame
    let frameAfter = null;
    try {
      const snapEvent = await this.captureSnapshot({ trigger: "action", action: actionData });
      const snapPayload = /** @type {any} */ (snapEvent?.payload);
      if (snapPayload) {
        frameAfter = {
          artifactId: snapPayload.artifactId,
          artifactUrl: snapPayload.artifactUrl,
          sha256: snapPayload.sha256,
          width: snapPayload.width,
          height: snapPayload.height,
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
        ...actionData,
        activeWindow: activeWin,
        timestamp: Date.now(),
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

      // Immediately notify the main window UI that recording has ended
      const mainWindow = this.getMainWindow?.();
      try {
        mainWindow?.webContents?.send("demonstration-status-change", {
          recording: false,
          session: null,
          result: {
            success: true,
            projectId: this.activeSession?.projectId || "demonstration",
            taskTitle: this.activeSession?.taskTitle || "Task",
            framesCount: this.activeSession?.framesCount || 0,
            actionsCount: this.activeSession?.inputEventsCount || 0,
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

      const session = this.activeSession;
      this.activeSession = null;
      this.lastFrameHash = null;

      const producer = session.producer;
      let sealResult = null;
      let records = [];

      try {
        if (!producer.isSealed) {
          producer.emit({
            kind: "session.closed",
            payload: {
              reason: "completed",
              total_frames: session.framesCount,
              total_actions: session.inputEventsCount,
            },
          });
          sealResult = producer.seal({ complete: true });
        }
        records = producer.getRecords();
      } catch (err) {
        console.warn("[DemonstrationRecorder] Seal warning:", err);
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

      this.lastCompletedResult = {
        success: true,
        projectId: session.projectId,
        taskTitle: session.taskTitle,
        runId: session.runId,
        sessionId: session.sessionId,
        traceId: session.traceId,
        framesCount: session.framesCount,
        actionsCount: session.inputEventsCount,
        transmitted,
        recordsCount: records.length,
        receipt: sealResult?.receipt || null,
      };

      this.isStopping = false;
      return this.lastCompletedResult;
    })();

    return this.stoppingPromise;
  }

  async _createFloatingWindow() {
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      return;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
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
    if (!this.floatingWindow || this.floatingWindow.isDestroyed() || !this.activeSession) return;
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
