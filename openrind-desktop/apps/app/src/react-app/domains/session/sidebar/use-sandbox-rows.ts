/**
 * Single source of truth for the sandbox list.
 *
 * Three surfaces need the same rows — the sidebar panel, the command palette,
 * and the "jump to the next sandbox that needs me" keybinding — so the fetch
 * lives here rather than inside the panel. Duplicating it would mean duplicate
 * polling against the OpenShell gateway, and the two copies would disagree
 * about status for up to a minute.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  resolveSandboxStatus,
  sortByStatus,
  needsUserAttention,
  type SandboxStatus,
} from "./sandbox-status";
import { readSandboxProfile, sandboxDisplayName, writeSandboxDisplayName } from "./sandbox-prefs";
import type { SandboxProfile } from "../../../../app/lib/desktop";

type ElectronBridge = NonNullable<Window["__OPENRIND_DESKTOP_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__ ?? null;
}

type RawSandboxRow = { name: string; created?: string; phase?: string };

function userFacingDesktopError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

export type SandboxListRow = {
  /** OpenShell sandbox name — the stable identity. */
  name: string;
  /** User-facing label (rename is cosmetic; the sandbox name never changes). */
  displayName: string;
  created?: string | undefined;
  phase?: string | undefined;
  status: SandboxStatus;
  profile: SandboxProfile;
  /** A PTY session for this sandbox is open in the app. */
  hasLiveSession: boolean;
  /** True while a destructive action is in flight for this row. */
  busy: boolean;
};

export type SandboxRowsState = {
  rows: SandboxListRow[];
  loaded: boolean;
  error: string | null;
  warningCount: number;
  refresh: () => Promise<boolean>;
  rename: (name: string, displayName: string) => void;
  remove: (name: string) => Promise<void>;
  clearError: () => void;
};

/** Only Openrind Shell sandboxes belong in this list. */
const NAME_PREFIX = "openrind-shell-";
const SANDBOXES_STORAGE_KEY = "openrind.sandboxes.cache";

function readCachedRaw(): RawSandboxRow[] {
  try {
    if (typeof window === "undefined") return [];
    const stored = localStorage.getItem(SANDBOXES_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCachedRaw(rows: RawSandboxRow[]) {
  try {
    if (typeof window === "undefined") return;
    localStorage.setItem(SANDBOXES_STORAGE_KEY, JSON.stringify(rows));
  } catch {}
}

let memoryCachedRaw: RawSandboxRow[] = [];
let memoryLoaded = false;

export function deriveSandboxName(workspaceId: string): string {
  const trimmed = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return trimmed ? `openrind-shell-${trimmed}` : "";
}

export function useSandboxRows(options?: {
  onDeleted?: (name: string) => void;
  workspaces?: any[];
}): SandboxRowsState {
  const bridge = getBridge();
  const [raw, setRaw] = useState<RawSandboxRow[]>(() => {
    if (memoryCachedRaw.length > 0) return memoryCachedRaw;
    const fromStorage = readCachedRaw();
    if (fromStorage.length > 0) {
      memoryCachedRaw = fromStorage;
      memoryLoaded = true;
      return fromStorage;
    }
    return [];
  });
  const [liveSessions, setLiveSessions] = useState<Set<string>>(() => new Set());
  const [loaded, setLoaded] = useState(() => memoryLoaded || memoryCachedRaw.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [busyNames, setBusyNames] = useState<Set<string>>(() => new Set());
  // Bumped on rename so the memo below recomputes; display names live in
  // localStorage rather than in this state.
  const [labelVersion, setLabelVersion] = useState(0);
  const refreshPromise = useRef<Promise<boolean> | null>(null);
  const onDeletedRef = useRef(options?.onDeleted);
  onDeletedRef.current = options?.onDeleted;

  const refresh = useCallback(async (): Promise<boolean> => {
    const currentBridge = getBridge();
    if (!currentBridge?.invokeDesktop) return false;
    if (refreshPromise.current) return refreshPromise.current;

    const doRefresh = async (): Promise<boolean> => {
      try {
        const list = (await currentBridge!.invokeDesktop!(
          "openrindListSandboxes",
        )) as RawSandboxRow[];
        if (Array.isArray(list)) {
          const filtered = list.filter(
            (row) =>
              typeof row?.name === "string" &&
              (row.name.startsWith(NAME_PREFIX) || row.name.startsWith("or-")),
          );
          if (filtered.length > 0 || memoryCachedRaw.length === 0) {
            setRaw(filtered);
            memoryCachedRaw = filtered;
            writeCachedRaw(filtered);
          }
        }
        // Best-effort: a failure here only costs the "live session" dot, so it
        // must never fail the whole refresh.
        try {
          const sessions = (await currentBridge!.invokeDesktop!("openrindPtyList")) as Array<{
            sandboxName?: string;
            exited?: boolean;
          }>;
          if (Array.isArray(sessions)) {
            setLiveSessions(
              new Set(
                sessions
                  .filter((entry) => entry && !entry.exited)
                  .map((entry) => entry.sandboxName)
                  .filter((name): name is string => typeof name === "string"),
              ),
            );
          }
        } catch {
          /* leave the previous set in place */
        }
        setLoaded(true);
        memoryLoaded = true;
        return true;
      } catch (err) {
        console.warn("[useSandboxRows] refresh error:", err);
        setLoaded(true);
        return false;
      } finally {
        refreshPromise.current = null;
      }
    };

    refreshPromise.current = doRefresh();
    return refreshPromise.current;
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    // The OpenShell gateway is started lazily and the WSL distro idles down, so
    // the first fetch after a cold app start routinely fails. Back off instead
    // of leaving the panel permanently empty.
    const retryDelays = [2_000, 4_000, 8_000, 15_000, 30_000];
    let attempt = 0;
    const kick = async () => {
      const ok = await refresh();
      if (cancelled || ok) return;
      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        attempt += 1;
        retryTimer = window.setTimeout(() => void kick(), delay);
      }
    };
    void kick();

    let debounce: number | null = null;
    const unsubscribe = bridge.openrindShell?.onSessionProgress?.(() => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void refresh();
      }, 1_200);
    });
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe?.();
      if (debounce !== null) window.clearTimeout(debounce);
      window.clearInterval(interval);
    };
  }, [bridge, refresh]);

  const rename = useCallback((name: string, displayName: string) => {
    writeSandboxDisplayName(name, displayName);
    setLabelVersion((value) => value + 1);
  }, []);

  const remove = useCallback(
    async (name: string) => {
      const currentBridge = getBridge();
      if (!currentBridge?.invokeDesktop) return;
      setBusyNames((prev) => new Set([...prev, name]));
      setError(null);
      try {
        onDeletedRef.current?.(name);
        await currentBridge.invokeDesktop("openrindDeleteSandbox", name);
        setRaw((prev) => {
          const updated = prev.filter((r) => r.name !== name);
          memoryCachedRaw = updated;
          writeCachedRaw(updated);
          return updated;
        });
        await refresh();
      } catch (err) {
        setError(userFacingDesktopError(err));
      } finally {
        setBusyNames((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [refresh],
  );

  const rows = useMemo<SandboxListRow[]>(() => {
    void labelVersion; // recompute when a display name changes
    const mapped = raw.map<SandboxListRow>((row) => {
      const hasLiveSession = liveSessions.has(row.name);
      
      let profile = readSandboxProfile(row.name);
      if (options?.workspaces) {
        const match = options.workspaces.find((w) => {
          if (!w?.name) return false;
          const derivedName = deriveSandboxName(w.name);
          if (derivedName === row.name) return true;
          const normalized = w.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/[_.]/g, "-");
          const prefix = `or-${normalized.slice(0, 7)}-`;
          return row.name.startsWith(prefix);
        });
        if (match?.sandboxProfile) {
          profile = match.sandboxProfile;
        }
      }

      return {
        name: row.name,
        displayName: sandboxDisplayName(row.name),
        created: row.created,
        phase: row.phase,
        status: busyNames.has(row.name) ? "deleting" : resolveSandboxStatus({ phase: row.phase, hasLiveSession }),
        profile,
        hasLiveSession,
        busy: busyNames.has(row.name),
      };
    });
    return sortByStatus(mapped, (row) => row.status);
  }, [raw, liveSessions, busyNames, labelVersion, options?.workspaces]);

  const warningCount = useMemo(
    () => rows.filter((row) => needsUserAttention(row.status)).length,
    [rows],
  );

  return {
    rows,
    loaded,
    error,
    warningCount,
    refresh,
    rename,
    remove,
    clearError: useCallback(() => setError(null), []),
  };
}
