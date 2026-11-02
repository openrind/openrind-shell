// Desktop Workflow Demonstration Recorder (VLA & Human Task Demonstration Capture)
import electron from "electron";
const { BrowserWindow, desktopCapturer, screen } = electron;
import { createHash } from "node:crypto";
import { CaptureProducer } from "@openrind/capture";
import { createRunIdentity } from "@openrind/capture";
import { scrubPiiText } from "./selltraces-projector.mjs";

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

    // Start screen capture loop
    this._startCaptureLoop();

    return {
      started: true,
      projectId,
      runId,
      taskTitle: cleanTitle,
    };
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

    const artifact = this.activeSession.producer.recordArtifact(
      artifactName,
      base64Data,
      "image/jpeg",
    );

    const event = this.activeSession.producer.emit({
      kind: "screen_observation",
      observedAtUnixNs: String(BigInt(Date.now()) * 1000000n),
      payload: {
        artifactId: artifact.id,
        sha256: frameHash,
        width: image.getSize().width,
        height: image.getSize().height,
        trigger,
        action: action || null,
      },
    });

    this.activeSession.framesCount++;
    this._updateFloatingState();
    return event;
  }

  recordInputEvent(actionData) {
    if (!this.activeSession || this.activeSession.isPaused) return;

    this.activeSession.inputEventsCount++;
    this.activeSession.producer.emit({
      kind: "human_action",
      observedAtUnixNs: String(BigInt(Date.now()) * 1000000n),
      payload: {
        ...actionData,
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
    this._updateFloatingState();
  }

  resume() {
    if (!this.activeSession) return;
    this.activeSession.isPaused = false;
    this._updateFloatingState();
  }

  async stop() {
    if (!this.activeSession) {
      throw new Error("No active demonstration recording to stop.");
    }

    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }

    const session = this.activeSession;
    const producer = session.producer;

    // Emit session.closed
    producer.emit({
      kind: "session.closed",
      payload: {
        reason: "completed",
        total_frames: session.framesCount,
        total_actions: session.inputEventsCount,
      },
    });

    const sealResult = producer.seal({ complete: true });
    const records = producer.getRecords();

    // Close floating widget
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      this.floatingWindow.close();
      this.floatingWindow = null;
    }

    // Restore main window
    const mainWindow = this.getMainWindow?.();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (typeof mainWindow.isMinimized === "function" && mainWindow.isMinimized()) {
        mainWindow.restore?.();
      }
      mainWindow.show?.();
      mainWindow.focus?.();
    }

    // Post records to collector if connected
    let transmitted = false;
    if (this.postCollectorEvents) {
      try {
        await this.postCollectorEvents({
          project: session.projectId,
          sessionId: session.sessionId,
          traceId: session.traceId,
          records,
          artifacts: sealResult.artifacts,
        });
        transmitted = true;
      } catch (err) {
        console.warn("[DemonstrationRecorder] Failed to stream events to Haloop:", err);
      }
    }

    this.activeSession = null;
    this.lastFrameHash = null;

    return {
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
      receipt: sealResult.receipt,
    };
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
        nodeIntegration: false,
        contextIsolation: true,
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
            background: rgba(18, 18, 24, 0.92);
            backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 35px;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 16px;
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
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #fff;
            padding: 6px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          button:hover { background: rgba(255, 255, 255, 0.2); }
          button.finish { background: #ef4444; border-color: #dc2626; }
          button.finish:hover { background: #dc2626; }
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
            window.parentWidget?.onAction(isPaused ? 'pause' : 'resume');
          }

          function finish() {
            window.parentWidget?.onAction('finish');
          }
        </script>
      </body>
      </html>
    `;

    await this.floatingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

    // Listen for widget actions via an exposed handler
    this.floatingWindow.webContents.executeJavaScript(`
      window.parentWidget = {
        onAction: (act) => {
          console.log('Widget action:', act);
        }
      };
    `);
  }

  _updateFloatingState() {
    if (!this.floatingWindow || this.floatingWindow.isDestroyed() || !this.activeSession) return;
    const frames = this.activeSession.framesCount;
    this.floatingWindow.webContents.executeJavaScript(`
      if (document.getElementById('frames')) {
        document.getElementById('frames').textContent = '${frames} frames';
      }
    `).catch(() => {});
  }
}
