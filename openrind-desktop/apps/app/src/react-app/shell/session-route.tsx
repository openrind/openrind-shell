/** @jsxImportSource react */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type {
  AgentPartInput,
  ConfigProvidersResponse,
  FilePartInput,
  ProviderListResponse,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import { createClient, unwrap } from "../../app/lib/opencode";
import { listCommands, shellInSession } from "../../app/lib/opencode-session";
import {
  buildOpenrindDesktopWorkspaceBaseUrl,
  createOpenrindDesktopServerClient,
  readOpenrindDesktopServerSettings,
  type OpenrindDesktopServerClient,
  type OpenrindDesktopWorkspaceInfo,
} from "../../app/lib/openrind-desktop-server";
import { buildOpenrindDesktopEnvRuntimeKey } from "../../app/lib/openrind-desktop-env-runtime";
import {
  engineInfo,
  revealDesktopItemInDir,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceExportConfig,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  workspaceUpdateDisplayName,
  type EngineInfo,
  type OpenrindDesktopServerInfo,
  type SandboxBackend,
  type SandboxProfile,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ModelOption,
  ModelRef,
  PendingPermission,
  SlashCommandOption,
  TodoItem,
  WorkspacePreset,
  WorkspaceConnectionState,
  ProviderListItem,
  WorkspaceSessionGroup,
} from "../../app/types";
import { isDesktopRuntime, isSandboxWorkspace, normalizeDirectoryPath, safeStringify } from "../../app/utils";
import { t } from "../../i18n";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { SessionPage } from "../domains/session/chat/session-page";
import { isDesktopProviderBlocked } from "../../app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "../domains/cloud/restriction-notice-provider";
import { ReactSessionRuntime } from "../domains/session/sync/runtime-sync";
import { buildOpenrindDesktopEnvSystemContext } from "../domains/session/sync/env-context";
import {
  permissionKey as reactPermissionKey,
  seedPermissionState,
} from "../domains/session/sync/session-sync";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { useRemoteAccessRestart } from "../domains/workspace/remote-access-restart";
import { RenameWorkspaceModal } from "../domains/workspace/rename-workspace-modal";
import { CreateSandboxModal } from "../domains/session/modals/create-sandbox-modal";
import { useShareWorkspaceState } from "../domains/workspace/share-workspace-state";
import { ModelPickerModal } from "../domains/session/modals/model-picker-modal";
import { ConfirmModal } from "../design-system/modals/confirm-modal";
import {
  CommandPalette,
  type SandboxOption as PaletteSandboxOption,
  type SessionOption as PaletteSessionOption,
} from "./command-palette";
import { getDisplaySessionTitle } from "../../app/lib/session-title";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readActiveWorkspaceId,
  readLastSessionFor,
  writeActiveWorkspaceId,
  writeLastSessionFor,
} from "./session-memory";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "./app-inspector";
import { useReactRenderWatchdog } from "./react-render-watchdog";
import { getModelBehaviorSummary } from "../../app/lib/model-behavior";
import { filterProviderList, mapConfigProvidersToList } from "../../app/utils/providers";
import { ensureDesktopLocalOpenrindDesktopConnection } from "./desktop-local-openrind-desktop";
import { resolveOpenrindDesktopConnection } from "./openrind-desktop-connection";
import { useReloadCoordinator } from "./reload-coordinator";
import { getReactQueryClient } from "../infra/query-client";
import { useStatusToasts } from "../domains/shell-feedback/status-toasts";
import { OpenrindShellTerminal } from "../domains/session/surface/openrind-shell-terminal";
import { SandboxPanel } from "../domains/session/sidebar/sandbox-panel";
import { useSandboxRows } from "../domains/session/sidebar/use-sandbox-rows";
import { needsUserAttention } from "../domains/session/sidebar/sandbox-status";
import { sandboxStatusLabel } from "../domains/session/sidebar/sandbox-status-labels";
import type { SidebarTab } from "../domains/session/sidebar/sidebar-tabs";
import { CtfTaskSidebar, type CtfTask } from "../domains/ctf/ctf-task-sidebar";
import { CtfSurface } from "../domains/ctf/ctf-surface";
import { ImportTaskModal } from "../domains/ctf/import-task-modal";

type SelectedSandbox = {
  name: string;
  profile: SandboxProfile;
};

// Route navigation unmounts SessionRoute, but it must not turn a settings visit
// into a new sandbox launch. Keep the selection for this renderer lifetime only
// (a full app launch still starts on the normal chat interface).
let retainedSandboxSelection: SelectedSandbox | null = null;

type RouteWorkspace = OpenrindDesktopWorkspaceInfo & {
  displayNameResolved: string;
};

function mapDesktopWorkspace(workspace: WorkspaceInfo): RouteWorkspace {
  return {
    ...workspace,
    displayNameResolved:
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback"),
  };
}

/**
 * Serialize an SDK error value into a string that parseSessionError can parse.
 * Preserves the original shape (name, data, message) as JSON when possible,
 * so the session surface can detect ProviderModelNotFoundError and offer
 * recovery actions like "Change model".
 */
function serializeSDKError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      const msg = (error as Record<string, unknown>).message;
      return typeof msg === "string" ? msg : String(error);
    }
  }
  return String(error);
}

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function isTransientStartupError(message: string | null | undefined) {
  const value = (message ?? "").toLowerCase();
  return (
    value.includes("timed out") ||
    value.includes("failed to fetch") ||
    value.includes("connection") ||
    value.includes("not ready")
  );
}

function workspaceLabel(workspace: OpenrindDesktopWorkspaceInfo) {
  return (
    workspace.displayName?.trim() ||
    workspace.openrindDesktopWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("session.workspace_fallback")
  );
}

function describeRouteError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
}

function describeWorkspaceCreateError(error: unknown) {
  const message = describeRouteError(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("operation timed out") ||
    lower.includes("os error 60") ||
    lower.includes("etimedout")
  ) {
    return `${message}\n\nOpenrindDesktop could not read the workspace config before the filesystem timed out. This often happens when the folder is still syncing from iCloud Drive or another remote folder. Wait for the folder to finish downloading, move the workspace to a local folder, or try again.`;
  }
  return message;
}

const emptyPendingPermissions: PendingPermission[] = [];

function useQueryCacheState<T>(queryKey: readonly unknown[] | null, fallback: T): T {
  const queryClient = getReactQueryClient();
  return useSyncExternalStore(
    (callback) => (queryKey ? queryClient.getQueryCache().subscribe(callback) : () => {}),
    () => (queryKey ? queryClient.getQueryData<T>(queryKey) ?? fallback : fallback),
    () => fallback,
  );
}

function mergeRouteWorkspaces(
  serverWorkspaces: OpenrindDesktopWorkspaceInfo[],
  desktopWorkspaces: RouteWorkspace[],
): RouteWorkspace[] {
  const desktopById = new Map(desktopWorkspaces.map((workspace) => [workspace.id, workspace]));
  const desktopByPath = new Map(
    desktopWorkspaces
      .map((workspace) => [normalizeDirectoryPath(workspace.path ?? ""), workspace] as const)
      .filter(([path]) => path.length > 0),
  );

  const mergedServer = serverWorkspaces.map((workspace) => {
    const match =
      desktopById.get(workspace.id) ??
      desktopByPath.get(normalizeDirectoryPath(workspace.path ?? ""));
    const merged = match
      ? {
          ...workspace,
          displayName: workspace.displayName?.trim()
            ? workspace.displayName
            : match.displayName,
          name: match.name?.trim() ? match.name : workspace.name,
          // The server-v2 database does not store sandboxProfile/sandboxBackend
          // (these are desktop-only fields). Always prefer the desktop value so
          // that Openrind Shell workspaces show the terminal instead of the chat UI.
          sandboxProfile: workspace.sandboxProfile ?? match.sandboxProfile ?? null,
          sandboxBackend: workspace.sandboxBackend ?? match.sandboxBackend ?? null,
        }
      : workspace;
    return {
      ...merged,
      displayNameResolved: workspaceLabel(merged),
    };
  });

  const mergedIds = new Set(mergedServer.map((workspace) => workspace.id));
  const mergedPaths = new Set(
    mergedServer
      .map((workspace) => normalizeDirectoryPath(workspace.path ?? ""))
      .filter((path) => path.length > 0),
  );

  const missingDesktop = desktopWorkspaces.filter((workspace) => {
    if (mergedIds.has(workspace.id)) return false;
    const normalizedPath = normalizeDirectoryPath(workspace.path ?? "");
    if (normalizedPath && mergedPaths.has(normalizedPath)) return false;
    return true;
  });

  return [...mergedServer, ...missingDesktop];
}

function toSessionGroups(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, any[]>,
  errorsByWorkspaceId: Record<string, string | null>,
  loadingWorkspaceIds: Set<string>,
): WorkspaceSessionGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    sessions: (sessionsByWorkspaceId[workspace.id] ?? []) as WorkspaceSessionGroup["sessions"],
    status: loadingWorkspaceIds.has(workspace.id)
      ? "loading"
      : errorsByWorkspaceId[workspace.id]
        ? "error"
        : "ready",
    error: errorsByWorkspaceId[workspace.id],
  }));
}

function isActiveSessionStatus(status: unknown) {
  return status === "running" || status === "retry" || status === "busy";
}

function getSessionStatus(session: any) {
  return session?.status ?? session?.state ?? session?.runStatus ?? null;
}

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read attachment: ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

async function draftToParts(draft: ComposerDraft, workspaceRoot: string) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
    if (!root) return "";
    return `${root}/${trimmed}`.replace(/\/\/+/g, "/");
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  for (const part of draft.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "paste") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "agent") {
      parts.push({ type: "agent", name: part.name });
      continue;
    }
    if (part.type === "file") {
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      });
    }
  }

  for (const attachment of draft.attachments) {
    parts.push({
      type: "file",
      url: await fileToDataUrl(attachment.file),
      filename: attachment.name,
      mime: attachment.mimeType,
    });
  }

  return parts;
}

// Workspaces are always the regular chat experience. Legacy workspaces that
// were created with an Openrind Shell profile are hidden from this route entirely:
// mounting them auto-connected (and re-created) their derived sandbox, which
// is exactly the surprise this decoupling removes. Their terminals live in
// the sidebar Sandboxes section / the /sandboxes manager instead, and the
// Settings workspace list still shows them for cleanup or removal.
function isChatWorkspace(workspace: RouteWorkspace): boolean {
  return (
    workspace.sandboxProfile !== "openrind-shell-claude" &&
    workspace.sandboxProfile !== "openrind-shell-openclaw" &&
    workspace.sandboxProfile !== "openrind-shell-codex" &&
    workspace.sandboxProfile !== "openrind-shell-openhands" &&
    workspace.sandboxProfile !== "openrind-shell-openhands-script"
  );
}

export function SessionRoute() {
  const navigate = useNavigate();
  const platform = usePlatform();
  const local = useLocal();
  const reloadCoordinator = useReloadCoordinator();
  const { showToast } = useStatusToasts();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const params = useParams<{ sessionId?: string }>();
  const selectedSessionId = params.sessionId?.trim() || null;

  const { markRouteReady: markBootRouteReady } = useBootState();
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<OpenrindDesktopServerClient | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, any[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [routeError, setRouteError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() => readActiveWorkspaceId() ?? "");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [initialSessionDraft, setInitialSessionDraft] = useState<{ sessionId: string; text: string } | null>(null);
  const initialPromptHandoffRef = useRef(false);
  // One-way latch for "a refreshRouteState is currently running"; prevents
  // overlapping route refreshes from queueing up when the user clicks fast.
  const refreshInFlightRef = useRef(false);
  const reloadEventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const sessionsByWorkspaceIdRef = useRef<Record<string, any[]>>({});
  const startupRetryTimerRef = useRef<number | null>(null);
  const [retryingWorkspaceIds, setRetryingWorkspaceIds] = useState<string[]>([]);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createSandboxOpen, setCreateSandboxOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [forgetWorkspaceId, setForgetWorkspaceId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Model picker modal state (ported from settings-route; previously the
  // session "Pick a model" button navigated to /settings/general, which is a
  // dead-end). Loads providers lazily when the modal opens.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  // Provider catalog cache. Used to compute the reasoning/thinking variant
  // options for whichever model is currently selected so the composer's
  // behavior pill actually shows its options (bug: was empty before).
  const [providerCatalog, setProviderCatalog] = useState<Record<string, Record<string, any>>>({});
  const [openrindDesktopServerHostInfoState, setOpenrindDesktopServerHostInfoState] = useState<OpenrindDesktopServerInfo | null>(null);
  useReactRenderWatchdog("SessionRoute", {
    selectedSessionId,
    selectedWorkspaceId,
    loading,
    workspaceCount: workspaces.length,
    sessionGroupCount: Object.keys(sessionsByWorkspaceId).length,
    commandPaletteOpen,
    modelPickerOpen,
  });
  const [openrindDesktopServerSettingsVersion, setOpenrindDesktopServerSettingsVersion] = useState(0);
  const [engineReloadVersion, setEngineReloadVersion] = useState(0);
  const [routeEngineInfo, setRouteEngineInfo] = useState<EngineInfo | null>(null);
  const reconnectAttemptedWorkspaceIdRef = useRef("");

  const openrindDesktopServerSettings = useMemo(
    () => readOpenrindDesktopServerSettings(),
    [openrindDesktopServerSettingsVersion],
  );

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    openrindDesktopServerHostInfo: openrindDesktopServerHostInfoState,
    openrindDesktopServerSettings,
    engineInfo: routeEngineInfo,
    exportWorkspaceBusy: false,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .filter((session) => isActiveSessionStatus(getSessionStatus(session)))
        .map((session: any) => ({
          id: String(session?.id ?? ""),
          title:
            String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
            t("session.untitled"),
        }))
        .filter((session) => session.id.length > 0),
    [sessionsByWorkspaceId],
  );

  const backgroundSessionLoadInFlight = useRef<Map<string, number>>(new Map());
  const loadWorkspaceSessionsInBackground = useCallback(
    async (openrindDesktopClient: OpenrindDesktopServerClient, workspaces: RouteWorkspace[]) => {
      const MAX_ATTEMPTS = 6;
      const backoffMs = (attempt: number) => Math.min(500 * Math.pow(2, attempt), 4_000);

      const fetchOnce = async (workspace: RouteWorkspace, attempt: number): Promise<void> => {
        const startedAt = backgroundSessionLoadInFlight.current.get(workspace.id) ?? 0;
        if (startedAt && Date.now() - startedAt < 5_000) return;
        const requestStartedAt = Date.now();
        backgroundSessionLoadInFlight.current.set(workspace.id, requestStartedAt);
        try {
          const response = await openrindDesktopClient.listSessions(workspace.id, { limit: 200 });
          const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
          const items = workspaceRoot
            ? (response.items ?? []).filter((session: any) =>
                normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
              )
            : (response.items ?? []);
          setSessionsByWorkspaceId((current) => ({ ...current, [workspace.id]: items }));
          setErrorsByWorkspaceId((current) => ({ ...current, [workspace.id]: null }));
          setRetryingWorkspaceIds((current) =>
            current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : t("app.unknown_error");
          // The first cold call to OpenCode's /session endpoint often hits
          // the 12s server timeout while the daemon finishes warming up
          // its index. Retry silently with backoff until we get a response
          // or run out of attempts — the sidebar keeps its "loading" state
          // in the meantime instead of flashing "error" next to the
          // workspace name.
          if (attempt + 1 < MAX_ATTEMPTS && isTransientStartupError(message)) {
            if (backgroundSessionLoadInFlight.current.get(workspace.id) === requestStartedAt) {
              backgroundSessionLoadInFlight.current.delete(workspace.id);
            }
            await new Promise((r) => window.setTimeout(r, backoffMs(attempt)));
            await fetchOnce(workspace, attempt + 1);
            return;
          }
          // Final failure: clear loading but still don't surface the raw
          // transport error in the sidebar header. If we truly can't reach
          // the server, the status bar already says so, and other UI paths
          // (refresh button, retry timer) will pick things up.
          setRetryingWorkspaceIds((current) =>
            current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
          );
        } finally {
          if (backgroundSessionLoadInFlight.current.get(workspace.id) === requestStartedAt) {
            backgroundSessionLoadInFlight.current.delete(workspace.id);
          }
        }
      };

      await Promise.all(workspaces.map((workspace) => fetchOnce(workspace, 0)));
    },
    [],
  );

  const refreshRouteState = useCallback(async () => {
    // Dedupe: if a refresh is already running, skip this call. Fast workspace
    // switches used to fire 5-6 overlapping refreshRouteState() calls which
    // each fetched workspaces + sessions for every workspace. That workload
    // multiplied quickly on the event loop and caused the UI to freeze.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    setRouteError(null);
    let desktopList = null as Awaited<ReturnType<typeof workspaceBootstrap>> | null;
    let desktopWorkspaces = workspacesRef.current;
    let routeReadyAfterRefresh = true;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap();
          desktopWorkspaces = (desktopList.workspaces ?? [])
            .map(mapDesktopWorkspace)
            .filter(isChatWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[session-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "session",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken, hostInfo } = await resolveOpenrindDesktopConnection();
      setOpenrindDesktopServerHostInfoState(hostInfo);
      if (!normalizedBaseUrl || !resolvedToken) {
        setClient(null);
        setBaseUrl("");
        setToken("");
        setWorkspaces(desktopWorkspaces);
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        {
          // The desktop-selected id may point at a hidden Openrind Shell-profile
          // workspace - only honor it when it survived the chat filter.
          const desktopSelectedId = resolveWorkspaceListSelectedId(desktopList);
          setSelectedWorkspaceId(
            (desktopSelectedId &&
            desktopWorkspaces.some((w) => w.id === desktopSelectedId)
              ? desktopSelectedId
              : "") ||
              desktopWorkspaces[0]?.id ||
              "",
          );
        }
        return;
      }

      const openrindDesktopClient = createOpenrindDesktopServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await openrindDesktopClient.listWorkspaces();
      const nextWorkspaces = mergeRouteWorkspaces(list.items, desktopWorkspaces).filter(isChatWorkspace);

      // Preserve any sessions we already have cached so switching routes
      // doesn't erase the sidebar while we refetch.
      const cachedEntries = nextWorkspaces.map((workspace) => ({
        workspaceId: workspace.id,
        sessions: sessionsByWorkspaceIdRef.current[workspace.id] ?? [],
      }));
      // Prefer, in order: the URL-selected workspace (if it owns the session),
      // the user's last-active workspace from localStorage, the desktop's
      // activeId, the server's activeId, then the first known workspace.
      const persistedActiveId = readActiveWorkspaceId();
      // Every candidate must exist in the FILTERED workspace list - the
      // persisted/desktop/server active id can point at a hidden
      // Openrind Shell-profile workspace, which must never become the selection.
      const selectionCandidates = [
        persistedActiveId,
        resolveWorkspaceListSelectedId(desktopList),
        list.activeId?.trim(),
      ];
      let nextWorkspaceId =
        selectionCandidates.find(
          (id) => id && nextWorkspaces.some((w) => w.id === id),
        ) ||
        nextWorkspaces[0]?.id ||
        "";
      if (selectedSessionId) {
        const match = cachedEntries.find((entry) =>
          entry.sessions.some((session: any) => session?.id === selectedSessionId),
        );
        if (match?.workspaceId) nextWorkspaceId = match.workspaceId;
      }

      setClient(openrindDesktopClient);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      setSessionsByWorkspaceId(Object.fromEntries(cachedEntries.map((entry) => [entry.workspaceId, entry.sessions])));
      setErrorsByWorkspaceId((previous) => {
        const next: Record<string, string | null> = {};
        for (const workspace of nextWorkspaces) {
          next[workspace.id] = previous[workspace.id] ?? null;
        }
        return next;
      });
      setRetryingWorkspaceIds(
        cachedEntries.find((entry) => entry.workspaceId === nextWorkspaceId)?.sessions.length === 0 && nextWorkspaceId
          ? [nextWorkspaceId]
          : [],
      );
      setSelectedWorkspaceId(nextWorkspaceId);
      writeActiveWorkspaceId(nextWorkspaceId || null);
      recordInspectorEvent("route.refresh.complete", {
        workspaces: nextWorkspaces.length,
        selectedWorkspaceId: nextWorkspaceId,
        errors: {},
      });

      // Session list comes from OpenCode's index and can be slow on cold
      // boot. Kick it off in the background instead of blocking the route
      // so the UI is interactive immediately; the sidebar shows a
      // loading state per-workspace until the list arrives.
      const selectedWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId);
      if (selectedWorkspace) {
        void loadWorkspaceSessionsInBackground(openrindDesktopClient, [selectedWorkspace]);
      }
    } catch (error) {
      const message = describeRouteError(error);
      console.error("[session-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "session",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      setRouteError(message);
      if (desktopWorkspaces.length > 0) {
        setWorkspaces(desktopWorkspaces);
        setSelectedWorkspaceId((current) => {
          const desktopSelectedId = resolveWorkspaceListSelectedId(desktopList);
          return (
            current ||
            (desktopSelectedId &&
            desktopWorkspaces.some((w) => w.id === desktopSelectedId)
              ? desktopSelectedId
              : "") ||
            desktopWorkspaces[0]?.id ||
            ""
          );
        });
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      // Tell the boot overlay the first route data load has completed so
      // the overlay dismisses after BOTH the desktop boot and the workspace
      // list/sessions are ready.
      if (routeReadyAfterRefresh) {
        markBootRouteReady();
      }
    }
  }, [loadWorkspaceSessionsInBackground, markBootRouteReady, selectedSessionId]);

  const remoteAccessRestart = useRemoteAccessRestart({
    isEnabled: () => openrindDesktopServerSettings.remoteAccessEnabled === true,
    onHostInfo: setOpenrindDesktopServerHostInfoState,
    onSettingsChanged: () => setOpenrindDesktopServerSettingsVersion((value) => value + 1),
  });

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    if (!client || !selectedWorkspaceId) {
      setRouteError(t("app.error_connect_first"));
      return false;
    }
    await client.reloadEngine(selectedWorkspaceId);
    setEngineReloadVersion((v) => v + 1);
    try {
      window.dispatchEvent(new CustomEvent("openrind-desktop-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }
    await refreshRouteState();
    return true;
  }, [client, refreshRouteState, selectedWorkspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(client && selectedWorkspaceId),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
    });
  }, [activeReloadBlockingSessions, client, reloadCoordinator, reloadWorkspaceEngineFromUi, selectedWorkspaceId]);

  useEffect(() => {
    if (!client || !selectedWorkspaceId) return;
    let cancelled = false;

    const pollReloadEvents = async () => {
      const currentCursor = reloadEventCursorByWorkspaceRef.current[selectedWorkspaceId];
      try {
        const response = await client.listReloadEvents(
          selectedWorkspaceId,
          typeof currentCursor === "number" ? { since: currentCursor } : undefined,
        );
        if (cancelled) return;
        reloadEventCursorByWorkspaceRef.current[selectedWorkspaceId] =
          typeof response.cursor === "number"
            ? response.cursor
            : Math.max(currentCursor ?? 0, ...((response.items ?? []).map((item: any) => Number(item.seq) || 0)));
        // The first poll establishes the server cursor so historical reload
        // events don't show a stale toast on route entry. Subsequent polls mark
        // new filesystem/server-side mutations, including skills created by an
        // agent while the session page is open.
        if (currentCursor === undefined || currentCursor === null) return;
        for (const event of response.items ?? []) {
          reloadCoordinator.markReloadRequired(event.reason, event.trigger);
        }
      } catch {
        // Reload-event polling is best-effort; normal route health checks still
        // surface connection failures.
      }
    };

    void pollReloadEvents();
    const interval = window.setInterval(() => void pollReloadEvents(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, reloadCoordinator, selectedWorkspaceId]);

  useEffect(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId) return;
    let cancelled = false;

    const refreshSelectedSessionTitle = async () => {
      try {
        const response = await client.getSession(selectedWorkspaceId, selectedSessionId);
        if (cancelled || !response.item) return;
        setSessionsByWorkspaceId((current) => {
          const list = current[selectedWorkspaceId] ?? [];
          const index = list.findIndex((session: any) => session?.id === selectedSessionId);
          if (index < 0) return current;
          const nextSession = { ...list[index], ...response.item };
          if (JSON.stringify(nextSession) === JSON.stringify(list[index])) return current;
          const nextList = [...list];
          nextList[index] = nextSession;
          return { ...current, [selectedWorkspaceId]: nextList };
        });
      } catch {
        // Best-effort title sync; the session surface still owns messages.
      }
    };

    void refreshSelectedSessionTitle();
    const interval = window.setInterval(() => void refreshSelectedSessionTitle(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, selectedSessionId, selectedWorkspaceId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    sessionsByWorkspaceIdRef.current = sessionsByWorkspaceId;
  }, [sessionsByWorkspaceId]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (cancelled) return;
        await refreshRouteState();
      } finally {
        if (cancelled) return;
      }
    })();

    const handleSettingsChange = () => {
      setOpenrindDesktopServerSettingsVersion((value) => value + 1);
      // Self-heal: if the previous refresh got stuck mid-flight (e.g. macOS
      // backgrounded the webview and never let a fetch resolve), clear the
      // guard so a re-entry after resume actually goes through.
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    window.addEventListener("openrind-desktop-server-settings-changed", handleSettingsChange);

    // Also retry on visibility flip independently — even when nobody else
    // dispatches the settings event.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      if (startupRetryTimerRef.current !== null) {
        window.clearTimeout(startupRetryTimerRef.current);
        startupRetryTimerRef.current = null;
      }
      window.removeEventListener("openrind-desktop-server-settings-changed", handleSettingsChange);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [refreshRouteState]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void engineInfo()
      .then((info) => {
        if (!cancelled) setRouteEngineInfo(info);
      })
      .catch(() => {
        if (!cancelled) setRouteEngineInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inspector wiring: publish the route's current state so an external
  // operator (or an AI driver like Chrome MCP) can call
  // `window.__openrindDesktop.snapshot()` or `window.__openrindDesktop.slice("route")` and
  // see workspaces / sessions / connection info without walking the DOM.
  useEffect(() => {
    const dispose = publishInspectorSlice("route", () => ({
      loading,
      retryingWorkspaceIds,
      baseUrl,
      tokenPresent: token.length > 0,
      connected: Boolean(client),
      routeError,
      selectedSessionId,
      selectedWorkspaceId,
      persistedActiveWorkspaceId: readActiveWorkspaceId(),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        displayNameResolved: workspace.displayNameResolved,
        workspaceType: workspace.workspaceType,
        path: workspace.path,
        sessionCount: (sessionsByWorkspaceId[workspace.id] ?? []).length,
        loading: retryingWorkspaceIds.includes(workspace.id),
        error: errorsByWorkspaceId[workspace.id] ?? null,
      })),
      sessionsByWorkspaceId: Object.fromEntries(
        Object.entries(sessionsByWorkspaceId).map(([wsId, items]) => [
          wsId,
          (items ?? []).map((session: any) => ({
            id: session?.id ?? null,
            title: session?.title ?? null,
            directory: session?.directory ?? null,
          })),
        ]),
      ),
    }));
    return dispose;
  }, [
    baseUrl,
    client,
    errorsByWorkspaceId,
    loading,
    retryingWorkspaceIds,
    selectedSessionId,
    selectedWorkspaceId,
    routeError,
    sessionsByWorkspaceId,
    token,
    workspaces,
  ]);

  // Openrind Shell sandbox sessions are first-class sidebar entries, fully
  // decoupled from workspaces (workspaces are always the regular chat UI).
  // Selecting one swaps the session surface for that sandbox's terminal.
  // The /sandboxes manager hands off a freshly created/opened sandbox via
  // location.state so it lands here already selected. Selection is retained
  // only while this renderer is alive; opening the app still starts on chat.
  // Which object type the sidebar is showing. Owned here rather than in the
  // page so a deep link, the palette, and the sandbox handoff below can all
  // reveal the sandbox they just selected.
  const [sidebarTab, setSidebarTab] = React.useState<SidebarTab>(() => {
    try {
      const saved = localStorage.getItem("openrind-shell-sidebar-tab");
      if (saved === "ctf" || saved === "sandboxes") return saved;
    } catch {}
    return "ctf";
  });

  const [ctfTasks, setCtfTasks] = React.useState<CtfTask[]>([]);
  const [selectedCtfTask, setSelectedCtfTask] = React.useState<CtfTask | null>(null);
  const [importCtfModalOpen, setImportCtfModalOpen] = React.useState(false);
  const [loadingCtfTasks, setLoadingCtfTasks] = React.useState(false);

  const loadCtfTasks = React.useCallback(async () => {
    try {
      setLoadingCtfTasks(true);
      const invoke = (window as any).__OPENRIND_DESKTOP_ELECTRON__?.invokeDesktop;
      if (!invoke) return;
      const tasks = await invoke("ctfListTasks");
      if (Array.isArray(tasks)) {
        setCtfTasks(tasks);
        setSelectedCtfTask((current) => {
          if (current) {
            const found = tasks.find((t: any) => t.id === current.id);
            if (found) return found;
          }
          return tasks[0] || null;
        });
      }
    } catch {} finally {
      setLoadingCtfTasks(false);
    }
  }, []);

  useEffect(() => {
    void loadCtfTasks();
  }, [loadCtfTasks]);

  const handleSetSidebarTab = React.useCallback((tab: SidebarTab) => {
    setSidebarTab(tab);
    if (tab === "ctf") {
      handleSetSelectedSandbox(null);
    }
    try {
      localStorage.setItem("openrind-shell-sidebar-tab", tab);
    } catch {}
  }, []);

  const pendingCreationRef = React.useRef<string | null>(null);

  // The /sandboxes manager hands off a freshly created/opened sandbox via
  // location.state so it lands here already selected.
  const [selectedSandbox, setSelectedSandbox] = React.useState<SelectedSandbox | null>(
    () => retainedSandboxSelection,
  );

  const handleSetSelectedSandbox = React.useCallback((
    sandbox: SelectedSandbox | null | ((current: SelectedSandbox | null) => SelectedSandbox | null)
  ) => {
    setSelectedSandbox((current) => {
      const next = typeof sandbox === "function" ? sandbox(current) : sandbox;
      retainedSandboxSelection = next;
      return next;
    });
  }, []);

  // One poller shared by the sidebar panel, the command palette and the
  // attention shortcut.
  const sandboxRows = useSandboxRows({
    onDeleted: (name) =>
      handleSetSelectedSandbox((current) => (current?.name === name ? null : current)),
    workspaces,
  });

  // Selecting a sandbox anywhere reveals it in the sidebar. Without this the
  // terminal would open while the sidebar still showed the session list, so
  // there was no visible indication of WHICH sandbox was attached.
  useEffect(() => {
    if (selectedSandbox) handleSetSidebarTab("sandboxes");
  }, [selectedSandbox, handleSetSidebarTab]);

  const location = useLocation();
  useEffect(() => {
    const handoff = (
      location.state as {
        openrindSandbox?: { name?: string; profile?: string };
        initialPrompt?: string;
      } | null
    )?.openrindSandbox;
    const openModal = (location.state as any)?.openCreateSandboxModal;
    if (openModal) {
      setCreateSandboxOpen(true);
      navigate(location.pathname, { replace: true, state: null });
      return;
    }

    if (!handoff?.name) return;
    pendingCreationRef.current = handoff.name;
    handleSetSelectedSandbox({
      name: handoff.name,
      profile:
        handoff.profile === "openrind-shell-openclaw" || handoff.profile === "openrind-shell-codex" || handoff.profile === "openrind-shell-openhands" || handoff.profile === "openrind-shell-openhands-script"
          ? handoff.profile
          : "openrind-shell-claude",
    });
    // Consume the handoff so refresh / back never re-selects the sandbox.
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate, handleSetSelectedSandbox]);

  useEffect(() => {
    if (pendingCreationRef.current && sandboxRows.rows.some((r) => r.name === pendingCreationRef.current)) {
      pendingCreationRef.current = null;
    }
  }, [sandboxRows.rows]);

  useEffect(() => {
    if (!sandboxRows.loaded) return;
    if (
      selectedSandbox &&
      selectedSandbox.name !== pendingCreationRef.current &&
      !sandboxRows.rows.some((r) => r.name === selectedSandbox.name)
    ) {
      handleSetSelectedSandbox(null);
    }
  }, [sandboxRows.loaded, sandboxRows.rows, selectedSandbox, handleSetSelectedSandbox]);

  // Once workspaces + sessions are loaded and the URL has no sessionId, try to
  // restore the last session the user opened in the active workspace.
  useEffect(() => {
    if (loading) return;
    // A sandbox terminal is showing (e.g. right after the manager handoff)
    // - restoring a chat session would remount the route and drop it.
    if (selectedSandbox) return;
    if (selectedSessionId) return;
    if (!selectedWorkspaceId) return;
    const remembered = readLastSessionFor(selectedWorkspaceId);
    if (!remembered) return;
    const sessions = sessionsByWorkspaceId[selectedWorkspaceId] ?? [];
    if (!sessions.some((session: any) => session?.id === remembered)) return;
    navigate(`/session/${remembered}`, { replace: true });
  }, [loading, navigate, selectedSandbox, selectedSessionId, selectedWorkspaceId, sessionsByWorkspaceId]);

  // Redirect to /welcome when no workspaces exist and the user hasn't
  // completed onboarding. This fires after the initial route refresh so
  // `loading` is false and we know for sure there are zero workspaces.
  useEffect(() => {
    if (loading) return;
    if (workspaces.length > 0) return;
    if (local.prefs.hasCompletedOnboarding) return;
    navigate("/welcome", { replace: true });
  }, [loading, local.prefs.hasCompletedOnboarding, navigate, workspaces.length]);

  // NOTE: Blueprint seeding was removed from the route.
  // It was firing `materializeBlueprintSessions` + a session re-fetch on every
  // workspace change, which cascaded setState updates and froze the UI after
  // a few rapid switches. Empty workspaces now simply show "No tasks yet." and
  // the user creates their first session explicitly via "New task". Seeding
  // can be reintroduced later as a one-shot triggered from a button or from
  // the onboarding flow, not from the route effect loop.

  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set(retryingWorkspaceIds)),
    [errorsByWorkspaceId, retryingWorkspaceIds, sessionsByWorkspaceId, workspaces],
  );

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );


  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (loading) return;
    if (client) {
      reconnectAttemptedWorkspaceIdRef.current = "";
      return;
    }
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "local") return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalOpenrindDesktopConnection({
      route: "session",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      setRouteError(message);
    });
  }, [client, loading, selectedWorkspace, workspaces]);

  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  const opencodeBaseUrl = useMemo(() => {
    if (!selectedWorkspaceId || !baseUrl) return "";
    const mounted = buildOpenrindDesktopWorkspaceBaseUrl(baseUrl, selectedWorkspaceId) ?? baseUrl;
    return `${mounted.replace(/\/+$|\/+$/g, "")}/opencode`;
  }, [baseUrl, selectedWorkspaceId]);
  const selectedWorkspaceIsLoading = retryingWorkspaceIds.includes(selectedWorkspaceId);
  const selectedWorkspaceError = errorsByWorkspaceId[selectedWorkspaceId] ?? null;
  // Boot-level loading blocks the whole UI. Session-list retries only fill the
  // sidebar; they must not gate the composer/New task.
  const effectiveLoading = loading;

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && token && !selectedWorkspaceError
        ? createClient(opencodeBaseUrl, selectedWorkspaceRoot || undefined, {
            token,
            mode: "openrind-desktop",
          })
        : null,
    [opencodeBaseUrl, selectedWorkspaceError, selectedWorkspaceRoot, token],
  );
  const canCreateTask = Boolean(
    opencodeClient && selectedWorkspaceId && !loading && !selectedWorkspaceError,
  );
  const permissionQueryKey = useMemo(
    () =>
      selectedWorkspaceId && selectedSessionId
        ? reactPermissionKey(selectedWorkspaceId, selectedSessionId)
        : null,
    [selectedSessionId, selectedWorkspaceId],
  );
  const pendingPermissions = useQueryCacheState<PendingPermission[]>(
    permissionQueryKey,
    emptyPendingPermissions,
  );
  useEffect(() => {
    if (!opencodeClient || !selectedWorkspaceId || !selectedSessionId) return;
    let cancelled = false;
    const directory = selectedWorkspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        const list = unwrap(await opencodeClient.permission.list({ directory }));
        if (!cancelled) {
          seedPermissionState(selectedWorkspaceId, selectedSessionId, list, { snapshotStartedAt });
        }
      } catch {
        // Keep event-synced permission state if the snapshot read fails.
        // Hiding a pending approval can block the running task.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opencodeClient, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot]);

  const activePermission = pendingPermissions[0] ?? null;
  const respondPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      if (!opencodeClient || !selectedWorkspaceId || !selectedSessionId) return;
      if (permissionReplyBusyRef.current) return;
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      try {
        unwrap(
          await opencodeClient.permission.reply({
            requestID,
            reply,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        getReactQueryClient().setQueryData<PendingPermission[]>(
          reactPermissionKey(selectedWorkspaceId, selectedSessionId),
          (current = []) => current.filter((permission) => permission.id !== requestID),
        );
      } catch (error) {
        showToast({
          title: t("app.error_request_failed"),
          description: describeRouteError(error),
          tone: "error",
        });
      } finally {
        permissionReplyBusyRef.current = false;
        setPermissionReplyBusy(false);
      }
    },
    [opencodeClient, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot, showToast],
  );
  const showPreparingStatus =
    effectiveLoading ||
    (!canCreateTask && !routeError && !selectedWorkspaceError);

  useEffect(() => {
    if (!opencodeClient) {
      setProviders([]);
      setProviderConnectedIds([]);
      return;
    }

    let cancelled = false;

    const applyProviderState = (value: ProviderListResponse) => {
      if (cancelled) return;
      setProviders((value.all ?? []) as ProviderListItem[]);
      setProviderConnectedIds(value.connected ?? []);
    };

    void (async () => {
      let disabledProviders: string[] = [];
      try {
        const config = unwrap(
          await opencodeClient.config.get({
            directory: selectedWorkspaceRoot || undefined,
          }),
        ) as { disabled_providers?: string[] };
        disabledProviders = Array.isArray(config.disabled_providers)
          ? config.disabled_providers
          : [];
      } catch {
        // ignore config read failures and continue with provider discovery
      }

      try {
        applyProviderState(
          filterProviderList(
            unwrap(await opencodeClient.provider.list()),
            disabledProviders,
          ),
        );
      } catch {
        try {
          const fallback = unwrap(
            await opencodeClient.config.providers({
              directory: selectedWorkspaceRoot || undefined,
            }),
          ) as ConfigProvidersResponse;
          applyProviderState(
            filterProviderList(
              {
                all: mapConfigProvidersToList(
                  fallback.providers,
                ) as ProviderListResponse["all"],
                connected: [],
                default: fallback.default,
              },
              disabledProviders,
            ),
          );
        } catch {
          if (cancelled) return;
          setProviders([]);
          setProviderConnectedIds([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opencodeClient, selectedWorkspaceRoot]);

  const modelLabel = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
    : t("session.default_model");

  // Prefetch the full provider catalog once so `getModelBehaviorSummary` has
  // everything it needs to expose the reasoning/thinking variants the active
  // model supports — without waiting for the model picker to open. Cached
  // as providerID → modelID → ProviderModel.
  useEffect(() => {
    if (!opencodeClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await opencodeClient.config.providers({
          directory: selectedWorkspaceRoot || undefined,
        });
        const data = (res as { data?: { providers?: Array<{ id: string; models: Record<string, any> }> } }).data;
        if (cancelled || !data?.providers) return;
        const next: Record<string, Record<string, any>> = {};
        for (const provider of data.providers) {
          next[provider.id] = { ...(provider.models ?? {}) };
        }
        setProviderCatalog(next);
      } catch {
        // best-effort cache; UI will fall back to empty variant options.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opencodeClient, selectedWorkspaceRoot]);

  // Compute behavior (reasoning/thinking variant) options for the current
  // default model. This is what the composer renders as its variant pill.
  const { modelVariantLabel, modelBehaviorOptions } = useMemo(() => {
    const ref = local.prefs.defaultModel;
    const variant = local.prefs.modelVariant ?? null;
    if (!ref) {
      return { modelVariantLabel: t("settings.default_label"), modelBehaviorOptions: [] as { value: string | null; label: string }[] };
    }
    const model = providerCatalog[ref.providerID]?.[ref.modelID];
    if (!model) {
      return { modelVariantLabel: variant ?? t("settings.default_label"), modelBehaviorOptions: [] as { value: string | null; label: string }[] };
    }
    const summary = getModelBehaviorSummary(ref.providerID, model, variant);
    return { modelVariantLabel: summary.label, modelBehaviorOptions: summary.options };
  }, [local.prefs.defaultModel, local.prefs.modelVariant, providerCatalog]);

  // Load the picker list lazily the first time the modal opens. Uses the
  // cached catalog when available, otherwise re-fetches.
  useEffect(() => {
    if (!modelPickerOpen || !opencodeClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await opencodeClient.config.providers({
          directory: selectedWorkspaceRoot || undefined,
        });
        const data = (res as {
          data?: {
            providers?: Array<{
              id: string;
              name: string;
              models: Record<string, { id: string; name: string }>;
            }>;
          };
        }).data;
        if (cancelled || !data?.providers) return;
        const options: ModelOption[] = [];
        for (const provider of data.providers) {
          const modelIds = Object.keys(provider.models);
          const hasModels = modelIds.length > 0;
          for (const id of modelIds) {
            const model = provider.models[id];
            options.push({
              providerID: provider.id,
              modelID: id,
              title: model.name || id,
              description: provider.name,
              behaviorTitle: "Reasoning",
              behaviorLabel: "Default",
              behaviorDescription: "",
              behaviorValue: null,
              isFree: false,
              isConnected: hasModels,
            });
          }
        }
        setModelOptions(options);
      } catch {
        // Silent: the picker surfaces an empty list rather than blocking the UI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelPickerOpen, opencodeClient, selectedWorkspaceRoot]);

  // Apply org-level restrictions (dev #1505) on top of the raw model list
  // so the picker never surfaces blocked options:
  //   - `blockZenModel` hides the built-in OpenCode provider entries
  //   - `disallowNonCloudModels` hides providers that aren't currently
  //     connected via cloud (a provider with models[] filled counts as
  //     connected in this list — see the loader above)
  const allowedModelOptions = useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "disallowNonCloudModels",
    });
    return modelOptions.filter((option) => {
      if (
        isDesktopProviderBlocked({
          providerId: option.providerID,
          checkRestriction: checkDesktopRestriction,
        })
      ) {
        return false;
      }
      if (restrictToCloud && !option.isConnected) {
        return false;
      }
      return true;
    });
  }, [checkDesktopRestriction, modelOptions]);

  const listSlashCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    // engineReloadVersion is included so the callback identity changes after
    // an engine reload, which invalidates the composer's command list cache
    // and causes it to re-fetch (picking up newly created skills).
    void engineReloadVersion;
    if (!opencodeClient) return [];
    return listCommands(opencodeClient, selectedWorkspaceRoot || undefined);
  }, [engineReloadVersion, opencodeClient, selectedWorkspaceRoot]);

  const surfaceProps = useMemo(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId || !opencodeBaseUrl || !token || !opencodeClient) {
      return null;
    }

    // Transient-safety: when the user switches workspaces the URL-driven
    // selectedSessionId may still point at a session from the old workspace
    // for one render tick. Only block rendering when we KNOW the session
    // belongs to a different workspace (i.e., it exists in another
    // workspace's list). A brand-new session that hasn't been refreshed
    // into any list yet must still render so "New task" feels instant.
    let sessionOwnedByOtherWorkspace = false;
    for (const [workspaceId, sessions] of Object.entries(sessionsByWorkspaceId)) {
      if (workspaceId === selectedWorkspaceId) continue;
      if ((sessions ?? []).some((session: any) => session?.id === selectedSessionId)) {
        sessionOwnedByOtherWorkspace = true;
        break;
      }
    }
    if (sessionOwnedByOtherWorkspace) {
      return null;
    }

    return {
      client,
      workspaceId: selectedWorkspaceId,
      workspaceRoot: selectedWorkspaceRoot,
      sessionId: selectedSessionId,
      opencodeBaseUrl,
      openrindDesktopToken: token,
      developerMode: false,
      modelLabel,
      initialDraft:
        initialSessionDraft?.sessionId === selectedSessionId
          ? initialSessionDraft.text
          : undefined,
      onModelClick: () => {
        setModelPickerQuery("");
        setModelPickerOpen(true);
      },
      onOpenSettingsSection: (section: "commands" | "skills" | "mcps" | "plugins") => {
        navigate(
          section === "skills"
            ? "/settings/skills"
            : section === "mcps"
              ? "/settings/extensions/mcp"
              : section === "plugins"
                ? "/settings/extensions/plugins"
                : "/settings/general",
        );
      },
      onSendDraft: async (draft: ComposerDraft) => {
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!text && draft.attachments.length === 0) return;

        if (draft.mode === "shell") {
          await shellInSession(opencodeClient, selectedSessionId, text);
          return;
        }

        if (draft.command) {
          const result = await opencodeClient.session.command({
            sessionID: selectedSessionId,
            command: draft.command.name,
            arguments: draft.command.arguments,
          });
          if (result.error) {
            throw new Error(serializeSDKError(result.error));
          }
          return;
        }

        const parts = await draftToParts(draft, selectedWorkspaceRoot);
        const envRuntimeKey = buildOpenrindDesktopEnvRuntimeKey({
          baseUrl: client?.baseUrl ?? null,
          pid: openrindDesktopServerHostInfoState?.pid ?? null,
          port: openrindDesktopServerHostInfoState?.port ?? null,
        });
        const envSystemContext = await buildOpenrindDesktopEnvSystemContext(client, {
          cacheKey: selectedSessionId,
          runtimeKey: envRuntimeKey,
        });
        const result = await opencodeClient.session.promptAsync({
          sessionID: selectedSessionId,
          parts,
          model: local.prefs.defaultModel ?? undefined,
          agent: selectedAgent ?? undefined,
          ...(local.prefs.modelVariant ? { variant: local.prefs.modelVariant } : {}),
          ...(envSystemContext ? { system: envSystemContext } : {}),
        });
        if (result.error) {
          throw new Error(serializeSDKError(result.error));
        }
      },
      onDraftChange: () => {
        // Draft persistence will be wired once the full React shell owns session state.
      },
      attachmentsEnabled: true,
      attachmentsDisabledReason: null,
      modelVariantLabel,
      modelVariant: local.prefs.modelVariant ?? null,
      modelBehaviorOptions,
      onModelVariantChange: (value: string | null) => {
        local.setPrefs((previous) => ({ ...previous, modelVariant: value }));
      },
      agentLabel: selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent"),
      selectedAgent,
      listAgents: async () => {
        const list = unwrap(await opencodeClient.app.agents());
        return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
      },
      onSelectAgent: (agent: string | null) => setSelectedAgent(agent),
      listCommands: listSlashCommands,
      recentFiles: [],
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const result = unwrap(
          await opencodeClient.find.files({
            query: trimmed,
            dirs: "true",
            limit: 50,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        return result;
      },
      isRemoteWorkspace: selectedWorkspace?.workspaceType === "remote",
      isSandboxWorkspace: selectedWorkspace ? isSandboxWorkspace(selectedWorkspace) : false,
      onChangeModel: (model: { providerID: string; modelID: string }) => {
        local.setPrefs((previous) => ({ ...previous, defaultModel: model }));
      },
    };
  }, [
    client,
    initialSessionDraft,
    local,
    listSlashCommands,
    modelLabel,
    navigate,
    opencodeBaseUrl,
    opencodeClient,
    selectedAgent,
    selectedSessionId,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    token,
  ]);

  const handleOpenCreateWorkspace = useCallback(() => {
    // Respect the org-level `blockMultipleWorkspaces` restriction (dev
    // #1505). If the checker returns true, the admin has disabled
    // adding further workspaces; surface a friendly notice instead of
    // opening the modal.
    if (
      workspaces.length > 0 &&
      checkDesktopRestriction({ restriction: "blockMultipleWorkspaces" })
    ) {
      restrictionNotice.show({
        title: "Additional workspaces are restricted",
        message:
          "Your organization administrator has restricted access to adding additional workspaces.",
      });
      return;
    }
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  }, [checkDesktopRestriction, restrictionNotice, workspaces.length]);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(
      workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        "",
    );
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      // Rename on both ends so the sidebar reflects the change regardless of
      // which list wins the next refresh (server-provided routeWorkspaces or
      // desktop-provided workspaceBootstrap results). Either call failing on
      // its own should NOT block the other — the user's intent was "rename
      // this workspace" and a soft failure in one store is recoverable.
      if (isDesktopRuntime()) {
        await workspaceUpdateDisplayName({
          workspaceId: renameWorkspaceId,
          displayName: trimmed,
        }).catch(() => undefined);
      }
      if (client) {
        await client
          .updateWorkspaceDisplayName(renameWorkspaceId, trimmed)
          .catch(() => undefined);
      }
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [client, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    try {
      await revealDesktopItemInDir(path);
    } catch {
      // ignore
    }
  }, [workspaces]);

  const handleShareWorkspace = useCallback((workspaceId: string) => {
    shareWorkspaceState.openShareWorkspace(workspaceId);
  }, [shareWorkspaceState]);

  const handleSaveShareRemoteAccess = useCallback(
    async (enabled: boolean) => {
      if (!isDesktopRuntime()) return;
      await remoteAccessRestart.save(enabled);
    },
    [remoteAccessRestart],
  );

  const handleExportWorkspaceConfig = useCallback(
    async (workspaceId: string) => {
      if (!isDesktopRuntime()) return;
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
      if (!workspace) return;
      const outputPath = await pickDirectory({
        title: `Choose where to export ${workspaceLabel(workspace)}`,
      });
      const targetPath = Array.isArray(outputPath) ? outputPath[0] : outputPath;
      if (!targetPath) return;
      await workspaceExportConfig({ workspaceId, outputPath: targetPath });
      try {
        await revealDesktopItemInDir(targetPath);
      } catch {
        // ignore reveal failures
      }
    },
    [workspaces],
  );

  const handleForgetWorkspace = useCallback((workspaceId: string) => {
    setForgetWorkspaceId(workspaceId);
  }, []);

  const confirmForgetWorkspace = useCallback(async () => {
    const workspaceId = forgetWorkspaceId;
    if (!workspaceId) return;
    setForgetWorkspaceId(null);
    // Remove from both stores so the next refresh can't resurrect the row
    // from whichever list wins the merge.
    if (isDesktopRuntime()) {
      await workspaceForget(workspaceId).catch(() => undefined);
    }
    if (client) {
      await client.deleteWorkspace(workspaceId).catch(() => undefined);
    }
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId("");
      writeActiveWorkspaceId(null);
      navigate("/session");
    }
    forgetWorkspaceMemory(workspaceId);
    await refreshRouteState();
  }, [client, forgetWorkspaceId, navigate, refreshRouteState, selectedWorkspaceId]);

  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string, initialPrompt?: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      !workspace ||
      !token ||
      !baseUrl ||
      loading ||
      retryingWorkspaceIds.includes(workspaceId) ||
      errorsByWorkspaceId[workspaceId]
    ) {
      return;
    }
    const workspaceOpencodeBaseUrl = `${(buildOpenrindDesktopWorkspaceBaseUrl(baseUrl, workspace.id) ?? baseUrl).replace(/\/+$|\/+$/g, "")}/opencode`;
    const workspaceClient = createClient(
      workspaceOpencodeBaseUrl,
      workspace.path?.trim() || undefined,
      { token, mode: "openrind-desktop" },
    );
    try {
      const session = unwrap(
        await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
      );
      setSelectedWorkspaceId(workspaceId);
      writeActiveWorkspaceId(workspaceId || null);
      writeLastSessionFor(workspaceId, session.id);
      setSessionsByWorkspaceId((current) => ({
        ...current,
        [workspaceId]: [session as any, ...(current[workspaceId] ?? [])],
      }));
      const prompt = initialPrompt?.trim();
      if (prompt) {
        setInitialSessionDraft({ sessionId: session.id, text: prompt });
      }
      navigate(`/session/${session.id}`);
      void refreshRouteState();
      return session.id;
    } catch (error) {
      const message = describeRouteError(error);
      setRouteError(message);
      if (isTransientStartupError(message)) {
        setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
        if (startupRetryTimerRef.current === null) {
          startupRetryTimerRef.current = window.setTimeout(() => {
            startupRetryTimerRef.current = null;
            refreshInFlightRef.current = false;
            void refreshRouteState();
          }, 1_000);
        }
      }
    }
  }, [baseUrl, errorsByWorkspaceId, loading, navigate, refreshRouteState, retryingWorkspaceIds, token, workspaces]);

  useEffect(() => {
    const initialPrompt = (
      location.state as { initialPrompt?: string } | null
    )?.initialPrompt?.trim();
    if (!initialPrompt || !selectedWorkspaceId || loading || initialPromptHandoffRef.current) return;
    initialPromptHandoffRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    void handleCreateTaskInWorkspace(selectedWorkspaceId, initialPrompt).finally(() => {
      initialPromptHandoffRef.current = false;
    });
  }, [handleCreateTaskInWorkspace, loading, location.pathname, location.state, navigate, selectedWorkspaceId]);

  // Global shortcuts:
  //   Cmd/Ctrl+N  -> new task in selected workspace
  //   Cmd/Ctrl+K  -> toggle command palette
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod) return;
      if (event.shiftKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);

      const key = event.key?.toLowerCase();
      if (key === "n" && !inEditable) {
        event.preventDefault();
        if (canCreateTask && selectedWorkspaceId) {
          void handleCreateTaskInWorkspace(selectedWorkspaceId);
        }
        return;
      }
      if (key === "k") {
        event.preventDefault();
        setCommandPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canCreateTask, handleCreateTaskInWorkspace, selectedWorkspaceId]);

  // Alt+Down / Alt+Up -> jump to the next/previous sandbox that wants a human.
  //
  // Once you run more than three or four sandboxes, "which one needs me" is the
  // only navigation question that matters, and scanning a list for an amber dot
  // does not scale. Falls back to cycling every sandbox when nothing is blocked,
  // so the key is never inert. Alt+Arrow is chosen over Conductor's Alt+L/H
  // because Alt+Left/Right are taken by history navigation, and Up/Down are not.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const blocked = sandboxRows.rows.filter((row) => needsUserAttention(row.status));
      const pool = blocked.length > 0 ? blocked : sandboxRows.rows;
      if (pool.length === 0) return;
      event.preventDefault();
      const currentIndex = pool.findIndex((row) => row.name === selectedSandbox?.name);
      const step = event.key === "ArrowDown" ? 1 : -1;
      // From "nothing selected", Down lands on the first entry and Up on the last.
      const nextIndex =
        currentIndex === -1
          ? step === 1
            ? 0
            : pool.length - 1
          : (currentIndex + step + pool.length) % pool.length;
      const next = pool[nextIndex];
      if (!next) return;
      handleSetSidebarTab("sandboxes");
      handleSetSelectedSandbox({ name: next.name, profile: next.profile });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [sandboxRows.rows, selectedSandbox?.name]);

  const paletteSandboxOptions = useMemo<PaletteSandboxOption[]>(
    () =>
      sandboxRows.rows.map((row) => ({
        name: row.name,
        title: row.displayName,
        statusLabel: sandboxStatusLabel(row.status),
        needsAttention: needsUserAttention(row.status),
        isActive: selectedSandbox?.name === row.name,
        // Match on both the label the user sees and the real sandbox name, since
        // renames are cosmetic and people search for either.
        searchText: `${row.displayName} ${row.name}`.toLowerCase(),
      })),
    [sandboxRows.rows, selectedSandbox?.name],
  );

  const paletteSessionOptions = useMemo<PaletteSessionOption[]>(() => {
    const out: PaletteSessionOption[] = [];
    for (const workspace of workspaces) {
      const workspaceTitle =
        workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        t("session.workspace_fallback");
      const list = sessionsByWorkspaceId[workspace.id] ?? [];
      for (const session of list) {
        const sessionId = (session as { id?: string }).id?.trim() ?? "";
        if (!sessionId) continue;
        const title = getDisplaySessionTitle(
          (session as { title?: string }).title ?? "",
        );
        const updatedAt =
          (session as { time?: { updated?: number; created?: number } }).time
            ?.updated ??
          (session as { time?: { updated?: number; created?: number } }).time
            ?.created ??
          0;
        out.push({
          workspaceId: workspace.id,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: `${title} ${workspaceTitle}`.toLowerCase(),
          isActive: workspace.id === selectedWorkspaceId,
        });
      }
    }
    out.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }, [sessionsByWorkspaceId, selectedWorkspaceId, workspaces]);

  const handleCreateWorkspace = useCallback(async (
    preset: WorkspacePreset,
    folder: string | null,
    sandboxBackend?: SandboxBackend,
    sandboxProfile?: SandboxProfile,
  ) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      const list = await workspaceCreate({
        folderPath: folder,
        name: workspaceName,
        preset,
        sandboxBackend: sandboxBackend ?? null,
        sandboxProfile: sandboxProfile ?? null,
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      // Register the workspace with the running openrind-desktop-server so
      // listWorkspaces() reflects it immediately. Without this the UI only
      // picks up the new workspace after an app restart (because the server
      // is launched with a fixed --workspace list at boot and the bridge
      // write only updates desktop-side state).
      if (client) {
        await client
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      if (createdId) {
        navigate("/settings/general");
      }
    } catch (error) {
      setCreateWorkspaceError(describeWorkspaceCreateError(error));
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [client, local, navigate, refreshRouteState]);

  const handleCreateRemoteWorkspace = useCallback(async (input: {
    openrindDesktopHostUrl?: string | null;
    openrindDesktopToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => {
    const baseUrlValue = input.openrindDesktopHostUrl?.trim() ?? "";
    if (!baseUrlValue) return false;
    setCreateWorkspaceRemoteBusy(true);
    setCreateWorkspaceRemoteError(null);
    try {
      const list = await workspaceCreateRemote({
        baseUrl: baseUrlValue,
        openrindDesktopHostUrl: baseUrlValue,
        openrindDesktopToken: input.openrindDesktopToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType: "openrind-desktop",
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      return true;
    } catch (error) {
      setCreateWorkspaceRemoteError(error instanceof Error ? error.message : t("app.unknown_error"));
      return false;
    } finally {
      setCreateWorkspaceRemoteBusy(false);
    }
  }, [local, refreshRouteState]);

  return (
    <>
    {opencodeClient && selectedWorkspaceId && opencodeBaseUrl && token ? (
      <ReactSessionRuntime
        workspaceId={selectedWorkspaceId}
        sessionId={selectedSessionId}
        opencodeBaseUrl={opencodeBaseUrl}
        openrindDesktopToken={token}
      />
    ) : null}
    <SessionPage
      selectedSessionId={selectedSessionId}
      selectedWorkspaceId={selectedWorkspaceId}
      sessionSurfaceOverride={
        selectedSandbox ? (
          // Keyed on the sandbox name so switching sidebar entries swaps
          // terminals cleanly. Every sandbox owns its own PTY in the main
          // process (sessions are concurrent): switching away detaches and
          // the agent keeps working; returning re-attaches losslessly.
          <OpenrindShellTerminal
            key={selectedSandbox.name}
            workspaceId={selectedSandbox.name.replace(/^openrind-shell-/, "")}
            profile={selectedSandbox.profile}
            onOpenSettings={(target) => navigate(`/settings/${target}`)}
            onSandboxDeleted={() => handleSetSelectedSandbox(null)}
          />
        ) : (
          sidebarTab === "ctf" ? (
            <CtfSurface
              task={selectedCtfTask}
              onRefreshTasks={loadCtfTasks}
            />
          ) : undefined
        )
      }
      sidebarTab={sidebarTab}
      onSidebarTabChange={handleSetSidebarTab}
      sandboxWarningCount={sandboxRows.warningCount}
      ctfSidebar={
        <CtfTaskSidebar
          tasks={ctfTasks}
          selectedTaskId={selectedCtfTask?.id ?? null}
          onSelectTask={setSelectedCtfTask}
          onOpenImport={() => setImportCtfModalOpen(true)}
          onRefresh={loadCtfTasks}
          loading={loadingCtfTasks}
        />
      }
      sandboxSidebar={
        typeof window !== "undefined" && Boolean((window as any).__OPENRIND_DESKTOP_ELECTRON__) ? (
          <SandboxPanel
            state={sandboxRows}
            selectedSandboxName={selectedSandbox?.name ?? null}
            focusedSandboxName={selectedSandbox?.name ?? null}
            onSelectSandbox={(row) =>
              handleSetSelectedSandbox({ name: row.name, profile: row.profile })
            }
            onOpenManager={() => setCreateSandboxOpen(true)}
            onOpenSettings={() => navigate("/settings/sandbox")}
          />
        ) : undefined
      }
      selectedWorkspaceDisplay={selectedWorkspace ? {
        id: selectedWorkspace.id,
        name: selectedWorkspace.name ?? undefined,
        displayName: selectedWorkspace.displayNameResolved,
        workspaceType: selectedWorkspace.workspaceType,
      } : { workspaceType: "local" }}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
      runtimeWorkspaceId={selectedWorkspaceId || null}
      workspaces={workspaces}
      clientConnected={canCreateTask}
      openrindDesktopServerStatus={client ? "connected" : "disconnected"}
      openrindDesktopServerClient={client}
      openrindDesktopServerToken={token}
      developerMode={false}
      headerStatus={canCreateTask ? t("status.connected") : t("session.loading_detail")}
      busyHint={effectiveLoading ? t("session.loading_detail") : null}
      startupPhase={effectiveLoading ? "nativeInit" : "ready"}
      providerConnectedIds={providerConnectedIds}
      providers={providers}
      mcpConnectedCount={0}
      onOpenSettings={() => navigate("/settings/general")}
      sidebar={{
        workspaceSessionGroups,
        selectedWorkspaceId,
        // While a sandbox terminal is showing, no chat session is "active"
        // even though the URL still carries the last session id.
        selectedSessionId: selectedSandbox ? null : selectedSessionId,
        developerMode: false,
        sessionStatusById: {},
        connectingWorkspaceId: null,
        workspaceConnectionStateById: {},
        newTaskDisabled: !canCreateTask,
        sidebarHydratedFromCache: Object.values(sessionsByWorkspaceId).some((list) => list.length > 0),
        startupPhase: effectiveLoading ? "nativeInit" : "ready",
        onSelectWorkspace: async (workspaceId) => {
          // Picking a workspace always returns to the chat experience.
          handleSetSelectedSandbox(null);
          if (workspaceId === selectedWorkspaceId) return true;
          setSelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          const workspace = workspaces.find((item) => item.id === workspaceId);
          if (client && workspace && !sessionsByWorkspaceId[workspaceId]?.length) {
            setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
            void loadWorkspaceSessionsInBackground(client, [workspace]);
          }
          // Fire Tauri updates but don't await them — they're bookkeeping and
          // awaiting 2 IPC roundtrips on every click used to stall rapid
          // workspace switches behind a queue.
          if (isDesktopRuntime()) {
            void workspaceSetSelected(workspaceId).catch(() => undefined);
            void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
          }
          // If we remember what the user last opened here and that session
          // still exists in our local list, navigate. Otherwise stay put.
          const remembered = readLastSessionFor(workspaceId);
          if (remembered && remembered !== selectedSessionId) {
            const known = sessionsByWorkspaceId[workspaceId];
            if (known?.some((session: any) => session?.id === remembered)) {
              navigate(`/session/${remembered}`);
            }
          }
          return true;
        },
        onOpenSession: (workspaceId, sessionId) => {
          handleSetSelectedSandbox(null);
          setSelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, sessionId);
          navigate(`/session/${sessionId}`);
        },
        onPrefetchSession: () => {},
        onCreateTaskInWorkspace: async (workspaceId) => {
          handleSetSelectedSandbox(null);
          void handleCreateTaskInWorkspace(workspaceId);
          return;
          const workspace = workspaces.find((item) => item.id === workspaceId)!;
          if (!workspace || !token || !baseUrl) return;
          const workspaceOpencodeBaseUrl = `${(buildOpenrindDesktopWorkspaceBaseUrl(baseUrl, workspace.id) ?? baseUrl).replace(/\/+$|\/+$/g, "")}/opencode`;
          const workspaceClient = createClient(
            workspaceOpencodeBaseUrl,
            workspace.path?.trim() || undefined,
            { token, mode: "openrind-desktop" },
          );
          const session = unwrap(
            await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
          );
          // Make sure the new session is the active pair before navigating
          // so the surface renders the new id immediately instead of going
          // through the "unknown session" render tick.
          setSelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, session.id);
          setSessionsByWorkspaceId((current) => ({
            ...current,
            [workspaceId]: [session as any, ...(current[workspaceId] ?? [])],
          }));
          navigate(`/session/${session.id}`);
          // Refresh in the background so the new session picks up its real
          // metadata (title, timestamps) as soon as the server knows them.
          void refreshRouteState();
        },
        onOpenRenameWorkspace: handleOpenRenameWorkspace,
        onShareWorkspace: handleShareWorkspace,
        onRevealWorkspace: (id) => void handleRevealWorkspace(id),
        onRecoverWorkspace: async () => false,
        onTestWorkspaceConnection: async () => true,
        onEditWorkspaceConnection: () => {},
        onForgetWorkspace: (id) => void handleForgetWorkspace(id),
        onOpenCreateWorkspace: handleOpenCreateWorkspace,
      }}
      surface={surfaceProps}
      history={{
        canUndo: false,
        canRedo: false,
        busyAction: null,
        onUndo: () => {},
        onRedo: () => {},
      }}
      todos={[] satisfies TodoItem[]}
      sessionLoadingById={(sessionId) => effectiveLoading && Boolean(sessionId && sessionId === selectedSessionId)}
      shareWorkspaceModal={
        shareWorkspaceState.shareWorkspaceOpen
          ? {
              open: true,
              onClose: shareWorkspaceState.closeShareWorkspace,
              workspaceName: shareWorkspaceState.shareWorkspaceName,
              workspaceDetail: shareWorkspaceState.shareWorkspaceDetail,
              fields: shareWorkspaceState.shareFields,
              remoteAccess:
                isDesktopRuntime() && shareWorkspaceState.shareWorkspace?.workspaceType === "local"
                  ? {
                      enabled: openrindDesktopServerSettings.remoteAccessEnabled === true,
                      busy: remoteAccessRestart.busy,
                      error: remoteAccessRestart.error,
                      status: remoteAccessRestart.status,
                      onSave: handleSaveShareRemoteAccess,
                    }
                  : undefined,
              note: shareWorkspaceState.shareNote,
              onExportConfig:
                shareWorkspaceState.exportDisabledReason === null
                  ? () => {
                      const id = shareWorkspaceState.shareWorkspaceId;
                      if (!id) return;
                      void handleExportWorkspaceConfig(id);
                    }
                  : undefined,
              exportDisabledReason: shareWorkspaceState.exportDisabledReason,
            }
          : null
      }
      activePermission={activePermission}
      permissionReplyBusy={permissionReplyBusy}
      respondPermission={respondPermission}
      safeStringify={safeStringify}
      onRenameSession={
        opencodeClient
          ? async (sessionId, nextTitle) => {
              const trimmed = nextTitle.trim();
              if (!trimmed) return;
              await opencodeClient.session.update({
                sessionID: sessionId,
                title: trimmed,
                directory: selectedWorkspaceRoot || undefined,
              });
              await refreshRouteState();
            }
          : undefined
      }
      onDeleteSession={
        client && selectedWorkspaceId
          ? async (sessionId) => {
              await client.deleteSession(selectedWorkspaceId, sessionId);
              if (selectedSessionId === sessionId) {
                navigate("/session");
              }
              await refreshRouteState();
            }
          : undefined
      }
      statusBar={showPreparingStatus ? {
        statusLabel: "Preparing workspace",
        statusDetail: t("session.loading_detail"),
        statusDotClass: "bg-amber-9",
        statusPingClass: "bg-amber-9/35 animate-ping",
        statusPulse: true,
      } : undefined}
    />
    <CreateWorkspaceModal
      open={createWorkspaceOpen}
      onClose={() => {
        setCreateWorkspaceOpen(false);
        setCreateWorkspaceError(null);
      }}
      onConfirm={handleCreateWorkspace}
      onConfirmRemote={handleCreateRemoteWorkspace}
      onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
      submitting={createWorkspaceBusy}
      localError={createWorkspaceError}
      remoteSubmitting={createWorkspaceRemoteBusy}
      remoteError={createWorkspaceRemoteError}
      defaultSandboxBackend={local.prefs.preferredSandboxBackend}
      defaultSandboxProfile={local.prefs.preferredSandboxProfile}
    />
    <RenameWorkspaceModal
      open={renameWorkspaceId !== null}
      title={renameWorkspaceTitle}
      busy={renameWorkspaceBusy}
      canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
      onClose={() => {
        if (renameWorkspaceBusy) return;
        setRenameWorkspaceId(null);
        setRenameWorkspaceTitle("");
      }}
      onSave={() => void handleSaveRenameWorkspace()}
      onTitleChange={setRenameWorkspaceTitle}
    />
    <ConfirmModal
      open={forgetWorkspaceId !== null}
      title={t("workspace_list.remove_title") || "Remove workspace?"}
      message={
        t("workspace_list.remove_confirm") ||
        "Remove this workspace from the sidebar? Sessions and files on disk are preserved."
      }
      confirmLabel={t("workspace_list.remove_workspace") || "Remove workspace"}
      cancelLabel={t("common.cancel")}
      variant="danger"
      onConfirm={() => void confirmForgetWorkspace()}
      onCancel={() => setForgetWorkspaceId(null)}
    />
    <CommandPalette
      open={commandPaletteOpen}
      onClose={() => setCommandPaletteOpen(false)}
      onCreateNewSession={() => {
        if (selectedWorkspaceId) {
          void handleCreateTaskInWorkspace(selectedWorkspaceId);
        }
      }}
      onOpenSession={(_workspaceId, sessionId) => navigate(`/session/${sessionId}`)}
      onOpenSettings={(route) => navigate(route ?? "/settings/general")}
      sessions={paletteSessionOptions}
      sandboxes={paletteSandboxOptions}
      onNewSandbox={() => setCreateSandboxOpen(true)}
      onOpenSandbox={(name) => {
        const row = sandboxRows.rows.find((item) => item.name === name);
        if (!row) return;
        handleSetSidebarTab("sandboxes");
        handleSetSelectedSandbox({ name: row.name, profile: row.profile });
      }}
    />
    <ModelPickerModal
      open={modelPickerOpen}
      options={allowedModelOptions}
      filteredOptions={allowedModelOptions.filter((opt) => {
        const q = modelPickerQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          opt.title.toLowerCase().includes(q) ||
          opt.providerID.toLowerCase().includes(q) ||
          opt.modelID.toLowerCase().includes(q)
        );
      })}
      query={modelPickerQuery}
      setQuery={setModelPickerQuery}
      target="default"
      current={local.prefs.defaultModel ?? ({ providerID: "", modelID: "" } satisfies ModelRef)}
      onSelect={(next: ModelRef) => {
        local.setPrefs((previous) => ({ ...previous, defaultModel: next }));
        setModelPickerOpen(false);
      }}
      onBehaviorChange={() => {}}
      onOpenSettings={() => {
        setModelPickerOpen(false);
        navigate("/settings/general");
      }}
      onClose={() => setModelPickerOpen(false)}
    />
      <CreateSandboxModal
        open={createSandboxOpen}
        onClose={() => setCreateSandboxOpen(false)}
        existingNames={sandboxRows.rows.map((r) => r.name)}
      />
      <ImportTaskModal
        open={importCtfModalOpen}
        onClose={() => setImportCtfModalOpen(false)}
        onSuccess={(task) => {
          void loadCtfTasks();
          setSelectedCtfTask(task);
        }}
      />
    </>
  );
}
