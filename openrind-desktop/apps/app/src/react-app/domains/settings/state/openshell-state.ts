/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";

import { isElectronRuntime } from "../../../../app/utils";

// Mirrors the OpenShellDoctorResult shape produced by
// apps/desktop/electron/openshell/doctor.mjs. JSDoc on the main-side
// can't flow into renderer TS, so we re-declare the contract here.
export type OpenShellComponentState = "ok" | "warn" | "missing" | "unknown";

export type OpenShellComponent = {
  id: string;
  label: string;
  state: OpenShellComponentState;
  version: string | null;
  detail: string | null;
  actionable?: string | null;
};

export type OpenShellDoctorStatus = "ready" | "degraded" | "missing" | "unsupported";

export type OpenShellDoctorResult = {
  status: OpenShellDoctorStatus;
  components: OpenShellComponent[];
  actionable: string[];
  fatal: string[];
};

export type OpenShellInstallProgress = {
  phase: string;
  status?: string;
  message?: string | null;
  percent?: number;
  error?: string | null;
};

export type OpenShellInstallStatus = {
  status: "idle" | "running" | "ready" | "reboot_required" | "cancelled" | "cancelling" | "failed";
  lastEvent?: OpenShellInstallProgress | null;
  state?: {
    completed: string[];
    rebootRequired: boolean;
    lastError: string | null;
    startedAt: number | null;
    updatedAt: number | null;
  };
};

export type OpenrindShellCredentialKey =
  | "databaseUrl"
  | "anthropicApiKey"
  | "openRouterApiKey"
  | "codexApiKey"
  | "openaiApiKey"
  | "openrindGatewayApiKey"
  | "elevenLabsApiKey";

export type OpenrindShellCredentialStatus = {
  databaseUrl: "set" | "unset";
  anthropicApiKey: "set" | "unset";
  openRouterApiKey?: "set" | "unset";
  codexApiKey?: "set" | "unset";
  openaiApiKey?: "set" | "unset";
  openrindGatewayApiKey: "set" | "unset";
  elevenLabsApiKey: "set" | "unset";
  encryptionAvailable: boolean;
  databaseUrl_masked?: string;
  databaseUrl_updatedAt?: number;
  anthropicApiKey_masked?: string;
  anthropicApiKey_updatedAt?: number;
  openRouterApiKey_masked?: string;
  openRouterApiKey_updatedAt?: number;
  codexApiKey_masked?: string;
  codexApiKey_updatedAt?: number;
  openaiApiKey_masked?: string;
  openaiApiKey_updatedAt?: number;
  openrindGatewayApiKey_masked?: string;
  openrindGatewayApiKey_updatedAt?: number;
  elevenLabsApiKey_masked?: string;
  elevenLabsApiKey_updatedAt?: number;
};

export type HaloopRuntimeState =
  | "ready"
  | "starting"
  | "stopped"
  | "degraded"
  | "blocked"
  | "unavailable";

export type HaloopRuntimeStatus = {
  required: true;
  routePolicy: "incumbent-only";
  upstreamMode: "anthropic" | "openrouter-test";
  state: HaloopRuntimeState;
  endpoint: string;
  version: string | null;
  health: string | null;
  collectorHealth: string | null;
  activeRoute: {
    profileId: string;
    providerName: string;
    sandboxName: string;
    agentId: "claude" | "openclaw" | "codex" | "openhands";
  } | null;
  detail: string;
  lastConnectionError: string | null;
  spanCapture: {
    written: number;
    duplicates: number;
    dropped: number;
    redacted: number;
    incomplete: number;
    lastError: string | null;
    lastAttemptAt: number | null;
  };
  checkedAt: number;
};

export type HaloopTokenRotationResult = {
  status: HaloopRuntimeStatus;
  affectedSessions: number;
  relaunchRequired: true;
};

export type HaloopIncumbentRollbackResult = {
  status: HaloopRuntimeStatus;
  routePolicy: "incumbent-only";
  sessionsPreserved: true;
};

export type HaloopAnalysisState =
  | "unavailable"
  | "no-traces"
  | "ready"
  | "queued"
  | "running"
  | "done"
  | "error";

export type HaloopAnalysisStatus = {
  state: HaloopAnalysisState;
  project: string | null;
  detail: string;
  stats: {
    spans: number;
    errors: number;
    byObservationKind: Record<string, number>;
    byModel: Record<
      string,
      {
        count?: number;
        latency_ms?: { p50?: number; p95?: number; p99?: number; n?: number };
      }
    >;
  } | null;
  run: {
    runId: string;
    status: string;
    provider: string;
    model: string;
    startedAt: number | null;
    finishedAt: number | null;
    reportAvailable: boolean;
    citations: {
      valid: boolean;
      traceCitations: number;
      spanCitations: number;
      missing: number;
    } | null;
    error: string | null;
  } | null;
  evalArtifact: HaloopEvalArtifact | null;
  retention: { days: number; reports: number };
};

export type HaloopEvalArtifact = {
  artifactId: string;
  haloRunId: string;
  createdAt: number | null;
  cases: number;
  byTag: Record<string, number>;
  sourceProviders: string[];
  sourceModels: string[];
  sourceSurfaces: string[];
  replaySurface: "chat-completions";
  containsSensitiveContent: true;
};

export type HaloopEvalPreview = {
  artifactId: string;
  haloRunId: string;
  totalCases: number;
  shownCases: number;
  truncated: boolean;
  containsSensitiveContent: true;
  cases: Record<string, unknown>[];
};

export type HaloopDownloadResult = {
  canceled: boolean;
  path?: string;
};

export type HaloopAnalysisReport = {
  runId: string;
  report: string;
  citations: {
    valid: true;
    traceCitations: number;
    spanCitations: number;
    missing: 0;
  };
};

// SettingsRoute unmounts when the user returns to a sandbox. Retain only the
// already-rendered private Haloop view model in renderer memory so coming back
// does not replace it with a blank screen while the collector refreshes.
let retainedHaloopStatus: HaloopRuntimeStatus | null = null;
let retainedHaloopAnalysisStatus: HaloopAnalysisStatus | null = null;
let retainedHaloopAnalysisReport: HaloopAnalysisReport | null = null;
let retainedHaloopEvalPreview: HaloopEvalPreview | null = null;

function mergeHaloopAnalysisSnapshot(
  previous: HaloopAnalysisStatus | null,
  incoming: HaloopAnalysisStatus,
): HaloopAnalysisStatus {
  if (!previous || (incoming.project !== null && incoming.project !== previous.project)) return incoming;
  // A temporary unavailable read or lower count must not erase captured evidence.
  const stats = previous.stats && (!incoming.stats || incoming.stats.spans < previous.stats.spans)
    ? previous.stats : incoming.stats;
  return { ...incoming, project: incoming.project ?? previous.project, stats, run: null, evalArtifact: null };
}

export type OpenrindShellSessionProgress = {
  sandboxName?: string;
  phase: string;
  message?: string;
};

export type OpenrindShellSessionResult = {
  sandboxName: string;
  profile?: string;
  existed?: boolean;
  terminal?: { launched: string } | null;
  terminalError?: string;
};

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

const DOCTOR_POLL_INTERVAL_MS = 5_000;
const PROGRESS_LOG_MAX = 200;

export function useOpenShellState(
  options: { active: boolean; haloopActive?: boolean } = { active: false },
) {
  const { active, haloopActive = false } = options;
  const [doctor, setDoctor] = useState<OpenShellDoctorResult | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<OpenShellInstallStatus | null>(null);
  const [progressLog, setProgressLog] = useState<OpenShellInstallProgress[]>([]);
  const [policies, setPolicies] = useState<string[]>([]);
  const [credentialStatus, setCredentialStatus] = useState<OpenrindShellCredentialStatus | null>(null);
  const [haloopStatus, setHaloopStatus] = useState<HaloopRuntimeStatus | null>(
    () => retainedHaloopStatus,
  );
  const [haloopAnalysisStatus, setHaloopAnalysisStatus] = useState<HaloopAnalysisStatus | null>(
    () => retainedHaloopAnalysisStatus,
  );
  const [haloopAnalysisReport, setHaloopAnalysisReport] = useState<HaloopAnalysisReport | null>(
    () => retainedHaloopAnalysisReport,
  );
  const [haloopEvalPreview, setHaloopEvalPreview] = useState<HaloopEvalPreview | null>(
    () => retainedHaloopEvalPreview,
  );
  const [sessionProgress, setSessionProgress] = useState<OpenrindShellSessionProgress[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const rememberHaloopStatus = useCallback((status: HaloopRuntimeStatus | null) => {
    retainedHaloopStatus = status;
    if (isMountedRef.current) setHaloopStatus(status);
  }, []);

  const rememberHaloopAnalysisStatus = useCallback((status: HaloopAnalysisStatus | null) => {
    retainedHaloopAnalysisStatus = status;
    if (isMountedRef.current) setHaloopAnalysisStatus(status);
  }, []);

  const rememberHaloopAnalysisReport = useCallback((report: HaloopAnalysisReport | null) => {
    retainedHaloopAnalysisReport = report;
    if (isMountedRef.current) setHaloopAnalysisReport(report);
  }, []);

  const rememberHaloopEvalPreview = useCallback((preview: HaloopEvalPreview | null) => {
    retainedHaloopEvalPreview = preview;
    if (isMountedRef.current) setHaloopEvalPreview(preview);
  }, []);

  const refreshDoctor = useCallback(async () => {
    if (!isElectronRuntime()) return;
    setDoctorLoading(true);
    setDoctorError(null);
    try {
      const result = await invoke<OpenShellDoctorResult>("openshellDoctor");
      if (isMountedRef.current) setDoctor(result);
    } catch (err) {
      if (isMountedRef.current) {
        setDoctorError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) setDoctorLoading(false);
    }
  }, []);

  const refreshInstallStatus = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const status = await invoke<OpenShellInstallStatus>("openshellInstallStatus");
      if (isMountedRef.current) setInstallStatus(status);
    } catch (err) {
      // Stale state is fine; surface only if it happens during a user action.
      if (isMountedRef.current && actionBusy) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [actionBusy]);

  const refreshPolicies = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const list = await invoke<string[]>("openshellListPolicies");
      if (isMountedRef.current) setPolicies(Array.isArray(list) ? list : []);
    } catch {
      if (isMountedRef.current) setPolicies([]);
    }
  }, []);

  const refreshCredentialStatus = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const status = await invoke<OpenrindShellCredentialStatus>("openrindCredentialStatus");
      if (isMountedRef.current) setCredentialStatus(status);
    } catch (err) {
      // Failed to refresh credential status, ignored silently in UI
    }
  }, []);

  const refreshHaloopStatus = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const status = await invoke<HaloopRuntimeStatus>("openrindHaloopStatus");
      rememberHaloopStatus(status);
    } catch {
      // Keep the last known snapshot; launch failures surface through the
      // session flow and the runtime status itself carries sanitized details.
    }
  }, [rememberHaloopStatus]);

  const refreshHaloopAnalysisStatus = useCallback(async () => {
    if (!isElectronRuntime()) return;
    try {
      const status = await invoke<HaloopAnalysisStatus>("openrindHaloopCaptureStatus");
      const previous = retainedHaloopAnalysisStatus;
      const projectReplaced = Boolean(
        status.project !== null && previous !== null && status.project !== previous.project,
      );
      rememberHaloopAnalysisStatus(mergeHaloopAnalysisSnapshot(previous, status));

      // Only positive replacement evidence invalidates rendered artifacts.
      // A transient null from the collector must not erase them on navigation.
      if (
        retainedHaloopAnalysisReport &&
        (projectReplaced ||
          (status.run !== null && status.run.runId !== retainedHaloopAnalysisReport.runId))
      ) {
        rememberHaloopAnalysisReport(null);
      }
      if (
        retainedHaloopEvalPreview &&
        (projectReplaced ||
          (status.evalArtifact !== null &&
            status.evalArtifact.haloRunId !== retainedHaloopEvalPreview.haloRunId) ||
          (status.run !== null &&
            status.run.runId !== retainedHaloopEvalPreview.haloRunId))
      ) {
        rememberHaloopEvalPreview(null);
      }
    } catch (err) {
      if (isMountedRef.current && actionBusy) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [
    actionBusy,
    rememberHaloopAnalysisReport,
    rememberHaloopAnalysisStatus,
    rememberHaloopEvalPreview,
  ]);

  // Listen for external credential changes (e.g., from gateway billing deep link)
  useEffect(() => {
    const handler = () => {
      void refreshCredentialStatus();
    };
    window.addEventListener("openrind-shell-credentials-changed", handler);
    return () => window.removeEventListener("openrind-shell-credentials-changed", handler);
  }, [refreshCredentialStatus]);

  // Subscribe to streaming install progress whenever the bridge exposes
  // the openshell namespace (post-Phase-5 builds). One subscription per
  // mount; unsubscribe on unmount.
  useEffect(() => {
    if (!isElectronRuntime()) return;
    const bridge = getBridge();
    const sub = bridge?.openshell?.onInstallProgress;
    if (!sub) return;
    const unsubscribe = sub((evt: OpenShellInstallProgress) => {
      if (!isMountedRef.current) return;
      setProgressLog((prev) => {
        const next = prev.concat(evt);
        return next.length > PROGRESS_LOG_MAX ? next.slice(-PROGRESS_LOG_MAX) : next;
      });
      // A "done" or "error" terminal event triggers a status refresh so
      // the snapshot is consistent with what was streamed.
      if (evt.phase === "done" || evt.phase === "error") {
        void refreshInstallStatus();
        void refreshDoctor();
      }
    });
    return () => unsubscribe();
  }, [refreshInstallStatus, refreshDoctor]);

  // Subscribe to Openrind Shell session progress (pull + create + terminal-launch).
  useEffect(() => {
    if (!isElectronRuntime()) return;
    const bridge = getBridge();
    const sub = bridge?.openrindShell?.onSessionProgress;
    if (!sub) return;
    const unsubscribe = sub((evt: OpenrindShellSessionProgress) => {
      if (!isMountedRef.current) return;
      setSessionProgress((prev) => {
        const next = prev.concat(evt);
        return next.length > PROGRESS_LOG_MAX ? next.slice(-PROGRESS_LOG_MAX) : next;
      });
    });
    return () => unsubscribe();
  }, []);

  // Credential status backs the Sandbox credentials panel on the Environment
  // tab, which renders even when the Sandbox tab is not `active`. Fetch it once
  // on mount (a cheap, tab-independent read of the on-disk credential blob) so a
  // fresh restart shows the persisted "set" state immediately. Previously this
  // was gated behind `active` (sandbox tab only), so opening Settings on the
  // Environment tab showed every credential as "unset" until the user changed
  // one — whose set/clear IPC response then filled in the whole status.
  useEffect(() => {
    if (!isElectronRuntime()) return;
    void refreshCredentialStatus();
  }, [refreshCredentialStatus]);

  useEffect(() => {
    if (!haloopActive || !isElectronRuntime()) return;
    void refreshHaloopStatus();
    void refreshHaloopAnalysisStatus();
    const id = setInterval(() => {
      void refreshHaloopStatus();
      void refreshHaloopAnalysisStatus();
    }, DOCTOR_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [haloopActive, refreshHaloopAnalysisStatus, refreshHaloopStatus]);

  // Poll doctor + install status on a steady cadence while the user is
  // looking at the sandbox tab. Outside the tab we don't waste cycles.
  useEffect(() => {
    if (!active || !isElectronRuntime()) return;
    void refreshDoctor();
    void refreshInstallStatus();
    void refreshPolicies();
    void refreshCredentialStatus();
    const id = setInterval(() => {
      void refreshDoctor();
      void refreshInstallStatus();
    }, DOCTOR_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, refreshDoctor, refreshInstallStatus, refreshPolicies, refreshCredentialStatus]);

  const startInstall = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    setProgressLog([]);
    try {
      await invoke<OpenShellInstallStatus>("openshellInstallStart");
      await refreshInstallStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [refreshInstallStatus]);

  const cancelInstall = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("openshellInstallCancel");
      await refreshInstallStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshInstallStatus]);

  const restartGateway = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await invoke("openshellGatewayRestart");
      await refreshDoctor();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [refreshDoctor]);

  const restartHaloop = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const status = await invoke<HaloopRuntimeStatus>("openrindHaloopRestart");
      rememberHaloopStatus(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMountedRef.current) setActionError(message);
      throw err;
    } finally {
      if (isMountedRef.current) setActionBusy(false);
    }
  }, [rememberHaloopStatus]);

  const restoreHaloopIncumbent = useCallback(
    async (): Promise<HaloopIncumbentRollbackResult> => {
      const route = haloopStatus?.activeRoute;
      if (!route) {
        throw new Error("Haloop has no active sandbox route to restore.");
      }
      setActionBusy(true);
      setActionError(null);
      try {
        const result = await invoke<HaloopIncumbentRollbackResult>(
          "openrindHaloopRollbackIncumbent",
          {
            expectedProfileId: route.profileId,
            expectedSandboxName: route.sandboxName,
          },
        );
        rememberHaloopStatus(result.status);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isMountedRef.current) setActionError(message);
        throw err;
      } finally {
        if (isMountedRef.current) setActionBusy(false);
      }
    },
    [haloopStatus, rememberHaloopStatus],
  );

  const rotateHaloopToken = useCallback(async (): Promise<HaloopTokenRotationResult> => {
    const route = haloopStatus?.activeRoute;
    if (!route) {
      throw new Error("Haloop has no active sandbox route to rotate.");
    }
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await invoke<HaloopTokenRotationResult>("openrindHaloopRotateToken", {
        expectedProfileId: route.profileId,
        expectedSandboxName: route.sandboxName,
      });
      rememberHaloopStatus(result.status);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMountedRef.current) setActionError(message);
      throw err;
    } finally {
      if (isMountedRef.current) setActionBusy(false);
    }
  }, [haloopStatus, rememberHaloopStatus]);

  const downloadHaloopTraces = useCallback(async (): Promise<HaloopDownloadResult> => {
    setActionBusy(true);
    try {
      return await invoke<HaloopDownloadResult>("openrindHaloopTracesDownload");
    } finally {
      setActionBusy(false);
    }
  }, []);

  const openPoliciesFolder = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("openshellOpenPoliciesFolder");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const setCredential = useCallback(
    async (key: OpenrindShellCredentialKey, value: string) => {
      setActionBusy(true);
      setActionError(null);
      try {
        const status = await invoke<OpenrindShellCredentialStatus>("openrindSetCredential", {
          key,
          value,
        });
        if (key === "openrindGatewayApiKey") {
          if (typeof window !== "undefined") {
            localStorage.setItem("openrind_gateway_billing_status", "custom");
            localStorage.setItem("openrind_gateway_email", "Custom API Key");
            localStorage.setItem("openrind_gateway_name", "Individual User");
          }
        }
        if (isMountedRef.current) setCredentialStatus(status);
        await refreshHaloopStatus();
        if (key === "openrindGatewayApiKey") {
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("openrind-shell-credentials-changed"));
          }
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [refreshHaloopStatus],
  );

  const clearCredential = useCallback(
    async (key: OpenrindShellCredentialKey) => {
      setActionBusy(true);
      setActionError(null);
      try {
        const status = await invoke<OpenrindShellCredentialStatus>("openrindClearCredential", key);
        if (key === "openrindGatewayApiKey") {
          if (typeof window !== "undefined") {
            localStorage.removeItem("openrind_gateway_billing_status");
            localStorage.removeItem("openrind_gateway_email");
            localStorage.removeItem("openrind_gateway_name");
          }
        }
        if (isMountedRef.current) setCredentialStatus(status);
        await refreshHaloopStatus();
        if (key === "openrindGatewayApiKey") {
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("openrind-shell-credentials-changed"));
          }
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [refreshHaloopStatus],
  );

  const startOpenrindShellSession = useCallback(
    async (
      workspaceId: string,
      profile: "openrind-shell-claude" | "openrind-shell-openclaw" | "openrind-shell-codex" | "openrind-shell-openhands" | "openrind-shell-openhands-script",
    ): Promise<OpenrindShellSessionResult> => {
      setActionBusy(true);
      setActionError(null);
      setSessionProgress([]);
      try {
        const result = await invoke<OpenrindShellSessionResult>("openrindStartSession", {
          workspaceId,
          profile,
        });
        await refreshHaloopStatus();
        return result;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        setActionBusy(false);
      }
    },
    [refreshHaloopStatus],
  );

  const deleteOpenrindShellSandbox = useCallback(async (sandboxName: string) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await invoke("openrindDeleteSandbox", sandboxName);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }, []);

  const testDatabaseUrl = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await invoke<{ status: string; probedReachable?: boolean }>(
        "openrindTestDatabase",
      );
      return result;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }, []);

  const resetDistro = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await invoke<{ status: string }>("openshellResetDistro");
      if (result?.status === "reset") {
        // Force a fresh doctor + installer-state read so the UI snaps to
        // "Install OpenShell" instead of showing a green checklist for a
        // distro that no longer exists.
        await refreshDoctor();
        await refreshInstallStatus();
        setProgressLog([]);
        setSessionProgress([]);
        rememberHaloopStatus(null);
        rememberHaloopAnalysisStatus(null);
        rememberHaloopAnalysisReport(null);
        rememberHaloopEvalPreview(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  }, [
    refreshDoctor,
    refreshInstallStatus,
    rememberHaloopAnalysisReport,
    rememberHaloopAnalysisStatus,
    rememberHaloopEvalPreview,
    rememberHaloopStatus,
  ]);

  return {
    doctor,
    doctorLoading,
    doctorError,
    installStatus,
    progressLog,
    policies,
    actionBusy,
    actionError,
    credentialStatus,
    haloopStatus,
    haloopAnalysisStatus,
    haloopAnalysisReport,
    haloopEvalPreview,
    sessionProgress,
    startInstall,
    cancelInstall,
    restartGateway,
    restartHaloop,
    restoreHaloopIncumbent,
    rotateHaloopToken,
    downloadHaloopTraces,
    resetDistro,
    openPoliciesFolder,
    setCredential,
    clearCredential,
    testDatabaseUrl,
    startOpenrindShellSession,
    deleteOpenrindShellSandbox,
    refreshDoctor,
    refreshInstallStatus,
    refreshPolicies,
    refreshCredentialStatus,
    refreshHaloopStatus,
    refreshHaloopAnalysisStatus,
  };
}
