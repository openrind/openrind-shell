/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, MoreHorizontal, Plus, Search, TriangleAlert } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { formatSandboxAge, needsUserAttention, type SandboxStatus } from "./sandbox-status";
import { sandboxAgentLabel, sandboxStatusLabel } from "./sandbox-status-labels";
import type { SandboxListRow, SandboxRowsState } from "./use-sandbox-rows";

/**
 * Full-height sidebar panel for sandboxes.
 *
 * Replaces the collapsed strip that used to be wedged into the bottom of the
 * session list. That strip rendered a name and nothing else, even though the
 * gateway already returns a phase and a creation time, so a booting sandbox, a
 * healthy one, and one whose agent had died all looked identical.
 *
 * Presentational on purpose: rows and mutations come from useSandboxRows() so
 * the command palette and the "next sandbox needing attention" shortcut read
 * the same state instead of polling the gateway again.
 */

/** Row is only shown as searchable once the list is long enough to need it. */
const SEARCH_THRESHOLD = 6;

/**
 * One distinct hue per state, chosen so the meaning is readable at a 6px dot:
 *
 *   green  = the agent is actually running (a live PTY proves it)
 *   blue   = work in progress, nothing wrong — NOT amber, because provisioning
 *            is not a warning and amber trains the eye to ignore real ones
 *   gray   = a container exists and nothing is attached; no claim either way
 *   orange = degraded: container up, agent not answering
 *   red    = failed outright
 */
function statusDotClass(status: SandboxStatus): string {
  switch (status) {
    case "active":
      return "bg-green-9";
    case "starting":
      return "bg-blue-9";
    case "idle":
      return "bg-gray-8";
    case "unhealthy":
      return "bg-orange-9";
    case "failed":
      return "bg-red-9";
    case "stopped":
      return "bg-gray-7";
    case "deleting":
      return "bg-gray-6";
    default:
      return "bg-gray-6";
  }
}



export type SandboxPanelProps = {
  state: SandboxRowsState;
  selectedSandboxName: string | null;
  onSelectSandbox: (row: SandboxListRow) => void;
  onOpenManager: () => void;
  onOpenSettings: () => void;
  /** Set by the route's attention-nav shortcut so the row can be scrolled to. */
  focusedSandboxName?: string | null;
};

export function SandboxPanel(props: SandboxPanelProps) {
  const { rows, loaded, error, warningCount } = props.state;
  const [query, setQuery] = useState("");
  const [rowMenuFor, setRowMenuFor] = useState<string | null>(null);
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const showSearch = rows.length >= SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !showSearch) return rows;
    return rows.filter(
      (row) =>
        row.displayName.toLowerCase().includes(needle) ||
        row.name.toLowerCase().includes(needle),
    );
  }, [rows, query, showSearch]);

  // Agent grouping and collapse states
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({
    claude: true,
    openclaw: true,
    codex: true,
    openhands: true,
  });

  const toggleAgentExpanded = (agentId: string) => {
    setExpandedAgents((prev) => ({
      ...prev,
      [agentId]: !prev[agentId],
    }));
  };

  const { claudeRows, openclawRows, codexRows, openhandsRows } = useMemo(() => {
    const claude: SandboxListRow[] = [];
    const openclaw: SandboxListRow[] = [];
    const codex: SandboxListRow[] = [];
    const openhands: SandboxListRow[] = [];
    for (const row of filtered) {
      if (row.profile === "openrind-shell-openclaw") {
        openclaw.push(row);
      } else if (row.profile === "openrind-shell-codex") {
        codex.push(row);
      } else if (row.profile === "openrind-shell-openhands" || row.profile === "openrind-shell-openhands-script") {
        openhands.push(row);
      } else {
        claude.push(row);
      }
    }
    return { claudeRows: claude, openclawRows: openclaw, codexRows: codex, openhandsRows: openhands };
  }, [filtered]);

  const renderSandboxRow = (row: SandboxListRow) => {
    const selected = props.selectedSandboxName === row.name;
    const attention = needsUserAttention(row.status);
    return (
      <div key={row.name} className="relative" data-sandbox={row.name}>
        <div
          role="button"
          tabIndex={0}
          aria-current={selected ? "true" : undefined}
          title={row.name}
          className={`group/row flex min-h-9 w-full items-center gap-2 rounded-xl px-3 py-1.5 text-left transition-colors ${
            selected
              ? "bg-gray-3 text-gray-12"
              : "text-gray-10 hover:bg-gray-1/70 hover:text-gray-11"
          } ${row.busy ? "opacity-60" : ""}`}
          onClick={() => {
            if (row.busy || renamingFor === row.name) return;
            props.onSelectSandbox(row);
          }}
          onKeyDown={(event) => {
            if (row.busy || renamingFor === row.name) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            props.onSelectSandbox(row);
          }}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={`block min-w-0 flex-1 truncate text-[13px] ${
                  selected ? "font-medium text-gray-12" : "font-normal text-current"
                }`}
              >
                {row.displayName}
              </span>
              {row.busy ? (
                <Loader2 size={12} className="shrink-0 animate-spin text-gray-9" />
              ) : null}
            </div>
            <div className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${attention ? (row.status === "failed" ? "text-red-11" : "text-orange-11") : "text-gray-9"}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(row.status)}`} />
              <span className="truncate">
                {sandboxStatusLabel(row.status)}
                {row.created ? ` • ${formatSandboxAge(row.created)}` : ""}
              </span>
            </div>
          </div>

          <button
            type="button"
            className={`-mr-1 mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-9 transition hover:bg-gray-3/80 hover:text-gray-11 ${
              selected || rowMenuFor === row.name
                ? "opacity-100"
                : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
            }`}
            aria-label={t("sandbox.row_actions")}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setRowMenuFor((current) => (current === row.name ? null : row.name));
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>

        {rowMenuFor === row.name ? (
          <div
            ref={menuRef}
            className="absolute right-1 top-[calc(100%-2px)] z-20 w-44 rounded-[18px] border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
          >
            <button
              type="button"
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2 disabled:opacity-50"
              disabled={row.busy || renamingFor === row.name}
              onClick={() => {
                if (row.busy || renamingFor === row.name) return;
                setRowMenuFor(null);
                props.onSelectSandbox(row);
              }}
            >
              {t("sandbox.open")}
            </button>
            <button
              type="button"
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-gray-11 transition-colors hover:bg-gray-2"
              onClick={() => {
                setRowMenuFor(null);
                setRenameValue(row.displayName);
                setRenamingFor(row.name);
              }}
            >
              {t("sandbox.rename")}
            </button>
            <button
              type="button"
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-red-11 transition-colors hover:bg-red-1/40"
              onClick={() => {
                setRowMenuFor(null);
                props.state.clearError();
                setDeleteTarget(row.name);
              }}
            >
              {t("sandbox.delete")}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderAgentSection = (agentId: "claude" | "openclaw" | "codex" | "openhands", title: string, color: string, sectionRows: SandboxListRow[]) => {
    if (sectionRows.length === 0) return null;
    const isExpanded = expandedAgents[agentId];
    return (
      <div className="space-y-1 pb-3">
        {/* Section Header */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => toggleAgentExpanded(agentId)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleAgentExpanded(agentId);
            }
          }}
          className="group flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left transition-colors text-gray-11 hover:bg-gray-2/50 outline-none"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: color }}
            />
            <div className="min-w-0 flex-1">
              <div className="min-w-0 truncate text-[14px] font-normal text-dls-text">
                {title}
              </div>
            </div>
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="rounded-md p-1 text-gray-9 hover:bg-gray-3/80 hover:text-gray-11"
              onClick={(event) => {
                event.stopPropagation();
                toggleAgentExpanded(agentId);
              }}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>
        </div>

        {/* Section Rows */}
        {isExpanded ? (
          <div className="mt-3 px-1 pb-1">
            <div className="relative flex flex-col gap-1 pl-2.5 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-[2px] before:bg-gray-3 before:content-['']">
              {sectionRows.length === 0 ? (
                <div className="px-3 py-2 text-left text-[11px] text-gray-10">No sandboxes yet.</div>
              ) : (
                sectionRows.map((row) => renderSandboxRow(row))
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const anyMenuOpen = rowMenuFor !== null;

  useEffect(() => {
    if (!anyMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setRowMenuFor(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRowMenuFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anyMenuOpen]);

  // Scroll the row the attention shortcut jumped to into view.
  useEffect(() => {
    const name = props.focusedSandboxName;
    if (!name || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-sandbox="${CSS.escape(name)}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [props.focusedSandboxName]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showSearch ? (
        <div className="shrink-0 px-3.5 pb-2 pt-3">
          <div className="flex items-center gap-2 rounded-xl border border-dls-border bg-dls-hover/40 px-2.5 py-1.5">
            <Search size={12} className="shrink-0 text-gray-9" />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("sandbox.search_placeholder")}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-gray-11 outline-none placeholder:text-gray-9"
              spellCheck={false}
            />
          </div>
        </div>
      ) : null}

      <div ref={listRef} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
        {warningCount > 0 ? (
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-red-11">
            <TriangleAlert size={11} className="shrink-0" />
            <span className="truncate">
              {warningCount === 1
                ? t("sandbox.failed_count_one")
                : t("sandbox.failed_count_many", undefined, { count: warningCount })}
            </span>
          </div>
        ) : null}

        {!loaded ? (
          <div className="space-y-1.5 px-1">
            {[0, 1, 2].map((idx) => (
              <div
                key={`sandbox:skeleton:${idx}`}
                className="rounded-[15px] border border-dls-border/70 bg-dls-hover/30 px-3 py-2.5"
              >
                <div
                  className="h-2.5 rounded-full bg-dls-hover/80 animate-pulse"
                  style={{ width: idx === 0 ? "62%" : idx === 1 ? "78%" : "54%" }}
                />
                <div className="mt-1.5 h-2 w-1/3 rounded-full bg-dls-hover/60 animate-pulse" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-1 pt-1">
            <p className="px-2 text-[11px] leading-relaxed text-gray-10">
              {t("sandbox.empty_body")}
            </p>
            <Button
              variant="outline"
              className="mt-2.5 w-full justify-center rounded-xl text-xs"
              onClick={props.onOpenManager}
            >
              {t("sandbox.empty_cta")}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-3 pt-2 text-[11px] text-gray-10">
            {t("sandbox.no_search_results")}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {renderAgentSection("claude", "Claude Code", "#f97316", claudeRows)}
            {renderAgentSection("openclaw", "OpenClaw", "#2563eb", openclawRows)}
            {renderAgentSection("codex", "Codex CLI", "#10b981", codexRows)}
            {renderAgentSection("openhands", "OpenHands", "#a855f7", openhandsRows)}
          </div>
        )}
      </div>

      <div className="relative mt-auto border-t border-dls-border/80 bg-dls-sidebar px-3 pt-3 pb-4">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-[18px] border border-dls-border bg-dls-surface px-3.5 py-2.5 text-[12px] font-medium text-gray-11 shadow-[var(--dls-card-shadow)] transition-colors hover:bg-gray-2"
          onClick={props.onOpenManager}
        >
          <Plus size={14} />
          {t("sandbox.new_sandbox")}
        </button>
      </div>

      {renamingFor ? (
        <RenameDialog
          value={renameValue}
          onChange={setRenameValue}
          onCancel={() => {
            setRenamingFor(null);
            setRenameValue("");
          }}
          onConfirm={() => {
            props.state.rename(renamingFor, renameValue);
            setRenamingFor(null);
            setRenameValue("");
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteDialog
          name={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const name = deleteTarget;
            setDeleteTarget(null);
            void props.state.remove(name);
          }}
        />
      ) : null}

      {error ? (
        <ErrorDialog message={error} onDismiss={props.state.clearError} />
      ) : null}
    </div>
  );
}

function ErrorDialog(props: { message: string; onDismiss: () => void }) {
  return (
    <DialogShell>
      <div role="alertdialog" aria-modal="true" aria-labelledby="sandbox-error-title">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-3/50 text-red-11">
            <TriangleAlert size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="sandbox-error-title" className="text-base font-semibold text-gray-12">
              Sandbox action failed
            </h3>
            <p className="mt-2 max-h-[45vh] overflow-y-auto whitespace-pre-wrap break-words text-sm text-gray-11">
              {props.message}
            </p>
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <Button autoFocus onClick={props.onDismiss}>
            {t("common.dismiss")}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

function DialogShell(props: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-1/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-6/70 bg-gray-2 shadow-2xl">
        <div className="p-6">{props.children}</div>
      </div>
    </div>
  );
}

function RenameDialog(props: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell>
      <h3 className="text-lg font-semibold text-gray-12">{t("sandbox.rename_title")}</h3>
      <p className="mt-1 text-sm text-gray-11">{t("sandbox.rename_body")}</p>
      <input
        autoFocus
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onConfirm();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          }
        }}
        className="mt-4 w-full rounded-xl border border-gray-6 bg-gray-1 px-3 py-2 text-sm text-gray-12 outline-none focus:border-gray-8"
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={props.onCancel}>
          {t("common.cancel")}
        </Button>
        <Button onClick={props.onConfirm}>{t("common.save")}</Button>
      </div>
    </DialogShell>
  );
}

/**
 * Delete confirmation.
 *
 * Spells out what is and is not destroyed, because the honest answer is
 * surprising: sandboxes share one Postgres workspace, so the agent's files and
 * memory survive and are restored into the next sandbox. Without saying so, a
 * user reasonably assumes Delete throws their work away.
 */
function DeleteDialog(props: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <DialogShell>
      <h3 className="text-lg font-semibold text-gray-12">{t("sandbox.delete_title")}</h3>
      <p className="mt-1 text-sm text-gray-11">
        {t("sandbox.delete_body", undefined, { name: props.name })}
      </p>
      <ul className="mt-3 space-y-1.5 text-[12px] text-gray-10">
        <li className="flex gap-2">
          <span className="text-gray-8">—</span>
          <span>{t("sandbox.delete_removes")}</span>
        </li>
        <li className="flex gap-2">
          <span className="text-gray-8">—</span>
          <span>{t("sandbox.delete_keeps")}</span>
        </li>
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" onClick={props.onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={props.onConfirm}>
          {t("sandbox.delete_confirm")}
        </Button>
      </div>
    </DialogShell>
  );
}
