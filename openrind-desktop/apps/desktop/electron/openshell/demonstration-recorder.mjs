// Desktop Workflow Demonstration Recorder (VLA & Human Task Demonstration Capture)
import electron from "electron";
const { BrowserWindow, desktopCapturer, ipcMain, screen } = electron;
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import { CaptureProducer } from "../../../../packages/capture/src/producer.mjs";
import { createRunIdentity } from "../../../../packages/capture/src/identity.mjs";
import { scrubPiiText } from "./selltraces-projector.mjs";

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

export async function getActiveWindow() {
  if (process.env.NODE_ENV === "test") {
    return { title: "Test Window", process: "TEST" };
  }
  if (process.platform === "win32") {
    try {
      const psCommand = `powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public class Win { [DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount); [DllImport(\\\"user32.dll\\\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); }'; $hwnd = [Win]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 256; $null = [Win]::GetWindowText($hwnd, $sb, 256); $pidOut = 0; $null = [Win]::GetWindowThreadProcessId($hwnd, [ref]$pidOut); $p = Get-Process -Id $pidOut -ErrorAction SilentlyContinue; @{ title = $sb.ToString(); process = $p.ProcessName } | ConvertTo-Json -Compress"`;
      const { stdout } = await execAsync(psCommand, { timeout: 800 });
      if (stdout) {
        const parsed = JSON.parse(stdout.trim());
        return {
          title: parsed.title || "Desktop",
          process: (parsed.process || "unknown").toUpperCase(),
        };
      }
    } catch {}
  }
  return { title: "Desktop Application", process: "DESKTOP" };
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

    const identity = createRunIdentity({
      runId,
      taskId: projectId,
      sessionId,
      rootSpanId: traceId.slice(0, 16),
    });

    const producer = new CaptureProducer({
      identity: {
        ...identity,
        trace_id: traceId,
        run_id: runId,
        session_id: sessionId,
        root_span_id: traceId.slice(0, 16),
      },
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
    if (!uIOhook || typeof uIOhook.start !== "function") return;

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

    this.onKeyDown = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      // Handle printable character codes directly from keydown (works uniformly across Windows/macOS/Linux)
      const rawKey = e.keychar ? String.fromCharCode(e.keychar) : null;
      if (rawKey && rawKey.length === 1 && rawKey.charCodeAt(0) >= 32) {
        this.textBuffer += rawKey;
      }

      // Enter key or Tab key finishes the typed text chunk immediately
      if (e.keycode === 28 || e.keycode === 0x0E || e.keycode === 15) {
        if (this.textBuffer) {
          const text = this.textBuffer;
          this.textBuffer = "";
          this.recordInputEvent({
            type: "type_text",
            text,
          });
        }
      } else {
        if (this.textDebounce) clearTimeout(this.textDebounce);
        this.textDebounce = setTimeout(() => {
          if (this.textBuffer) {
            const text = this.textBuffer;
            this.textBuffer = "";
            this.recordInputEvent({
              type: "type_text",
              text,
            });
          }
        }, 500);
      }
    };

    this.onKeyTyped = (e) => {
      if (!this.activeSession || this.activeSession.isPaused) return;
      const char = String.fromCharCode(e.keychar || e.rawcode || 0);
      if (char && char.length === 1 && char.charCodeAt(0) >= 32) {
        this.textBuffer += char;
        if (this.textDebounce) clearTimeout(this.textDebounce);
        this.textDebounce = setTimeout(() => {
          if (this.textBuffer) {
            const text = this.textBuffer;
            this.textBuffer = "";
            this.recordInputEvent({
              type: "type_text",
              text,
            });
          }
        }, 500);
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
    if (!this.activeSession) return null;

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

    const cursor = this.activeSession.lastCursorPoint || screen.getCursorScreenPoint?.() || { x: 0, y: 0 };
    const activeWin = await getActiveWindow();

    const event = this.activeSession.producer.emit({
      kind: "screen_observation",
      observedAtUnixNs: String(BigInt(Date.now()) * 1000000n),
      payload: {
        artifactId: artifactName,
        artifactHash,
        artifactUrl: `http://136.112.93.84:8788/artifacts/${artifactName}`,
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
      },
    });

    this.activeSession.framesCount++;
    this._updateFloatingState();
    return event;
  }

  async recordInputEvent(actionData) {
    if (!this.activeSession || this.activeSession.isPaused) return;

    const activeWin = await getActiveWindow();
    this.activeSession.inputEventsCount++;
    this.activeSession.producer.emit({
      kind: "human_action",
      observedAtUnixNs: String(BigInt(Date.now()) * 1000000n),
      payload: {
        ...actionData,
        activeWindow: activeWin,
        timestamp: Date.now(),
      },
    });

    // Capture an immediate frame on key human actions (click / submit)
    void this.captureSnapshot({ trigger: "action", action: actionData });
    this._updateFloatingState();
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

      // Immediately close floating widget and restore main window so the user is never kept waiting
      if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
        this.floatingWindow.close();
        this.floatingWindow = null;
      }

      const mainWindow = this.getMainWindow?.();
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
