/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";

import type { OpenrindDesktopServerClient } from "../../../../app/lib/openrind-desktop-server";
import {
  readOpenrindDesktopEnvPendingChanges,
  writeOpenrindDesktopEnvPendingChanges,
} from "../../../../app/lib/openrind-desktop-env-runtime";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { TextInput } from "../../../design-system/text-input";
import { clearOpenrindDesktopEnvSystemContextCache } from "../../session/sync/env-context";
import type {
  OpenrindShellCredentialKey,
  OpenrindShellCredentialStatus,
} from "../state/openshell-state";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIXES = ["OPENRIND_DESKTOP_", "OPENCODE_"] as const;

type EnvItem = { key: string; value: string; updatedAt: number };
type ApplyEnvironmentChangesResult = { statusMessage?: string } | void;

export type EnvironmentViewProps = {
  client: OpenrindDesktopServerClient | null;
  isRemoteWorkspace: boolean;
  onStatusMessage: (message: string) => void;
  onApplyChanges?: () => Promise<ApplyEnvironmentChangesResult>;
  applyBlocked?: boolean;
  applyBlockedReason?: string | null;
  runtimeKey?: string | null;

  // Integrated Sandbox Credentials
  credentialStatus?: OpenrindShellCredentialStatus | null;
  credentialBusy?: boolean;
  onSetCredential?: (key: OpenrindShellCredentialKey, value: string) => Promise<void>;
  onClearCredential?: (key: OpenrindShellCredentialKey) => Promise<void>;
};

type PredefinedCredentialDef = {
  statusKey: OpenrindShellCredentialKey;
  envVarName: string;
  label: string;
  description: string;
  placeholder: string;
};

const PREDEFINED_CREDENTIALS: PredefinedCredentialDef[] = [
  {
    statusKey: "databaseUrl",
    envVarName: "DATABASE_URL",
    label: "DATABASE_URL",
    description:
      "PostgreSQL connection string (Supabase / Neon / firm-internal). Required for any Openrind Shell sandbox.",
    placeholder: "postgresql://user:password@host:5432/dbname",
  },
  {
    statusKey: "anthropicApiKey",
    envVarName: "ANTHROPIC_API_KEY",
    label: "ANTHROPIC_API_KEY",
    description:
      "Upstream Anthropic API key required by the host-managed Haloop edge. Desktop retains it outside the sandbox; Claude and OpenClaw receive neither this key nor a direct-provider route.",
    placeholder: "sk-ant-...",
  },
  {
    statusKey: "openRouterApiKey",
    envVarName: "OPENROUTER_API_KEY",
    label: "OPENROUTER_API_KEY",
    description:
      "OpenRouter API key used as the primary inference provider for Claude, OpenClaw, and Codex CLI.",
    placeholder: "sk-or-v1-...",
  },
  {
    statusKey: "codexApiKey",
    envVarName: "CODEX_API_KEY",
    label: "CODEX_API_KEY",
    description:
      "Codex / OpenAI API key for Codex CLI (or leave blank to route Codex through your OpenRouter key).",
    placeholder: "sk-...",
  },
  {
    statusKey: "openaiApiKey",
    envVarName: "OPENAI_API_KEY",
    label: "OPENAI_API_KEY",
    description:
      "OpenAI API key for OpenClaw, OpenHands, and Codex CLI.",
    placeholder: "sk-proj-...",
  },
  {
    statusKey: "openrindGatewayApiKey",
    envVarName: "OPENRIND_GATEWAY_API_KEY",
    label: "OPENRIND_GATEWAY_API_KEY",
    description:
      "Openrind account and billing credential. It is not an inference route; Claude and OpenClaw always use the required Haloop edge.",
    placeholder: "sk-st-...",
  },
  {
    statusKey: "elevenLabsApiKey",
    envVarName: "ELEVENLABS_API_KEY",
    label: "ELEVENLABS_API_KEY",
    description:
      "ElevenLabs API key used by voice dictation in the composer and sandbox terminal.",
    placeholder: "sk_...",
  },
];

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function formatUpdatedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

function validateKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return t("settings.environment.validation_empty");
  if (!KEY_PATTERN.test(trimmed)) return t("settings.environment.validation_shape");
  if (RESERVED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return t("settings.environment.validation_reserved");
  }
  return null;
}

export function EnvironmentView(props: EnvironmentViewProps) {
  const { client, isRemoteWorkspace, onStatusMessage } = props;
  const canEdit = !isRemoteWorkspace && client !== null;

  // Custom environment items from workspace server
  const [items, setItems] = useState<EnvItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEditCredentials = !!props.onSetCredential;

  // Predefined sandbox credentials state
  const [editingPredefinedKey, setEditingPredefinedKey] = useState<OpenrindShellCredentialKey | null>(null);
  const [predefinedValue, setPredefinedValue] = useState("");
  const [predefinedError, setPredefinedError] = useState<string | null>(null);
  const [predefinedSaving, setPredefinedSaving] = useState(false);

  // Custom variable inline edit state
  const [editingCustomKey, setEditingCustomKey] = useState<string | null>(null);
  const [customEditValue, setCustomEditValue] = useState("");
  const [customEditError, setCustomEditError] = useState<string | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);

  // Inline "Add variable" state
  const [isAddingInline, setIsAddingInline] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [savingAdd, setSavingAdd] = useState(false);

  // Deletion & Apply states
  const [deleteCandidate, setDeleteCandidate] = useState<EnvItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState(() =>
    readOpenrindDesktopEnvPendingChanges(props.runtimeKey),
  );
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const refreshRequestId = useRef(0);
  const applyBlockedReason = props.applyBlocked
    ? props.applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks")
    : null;

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestId.current;
    if (!client || isRemoteWorkspace) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await client.listUserEnv();
      if (requestId !== refreshRequestId.current) return;
      setItems(response.items);
    } catch (err) {
      if (requestId !== refreshRequestId.current) return;
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      if (requestId === refreshRequestId.current) setLoading(false);
    }
  }, [client, isRemoteWorkspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setPendingChanges(readOpenrindDesktopEnvPendingChanges(props.runtimeKey));
  }, [props.runtimeKey]);

  useEffect(() => {
    if (!canEdit) {
      setEditingCustomKey(null);
      setIsAddingInline(false);
      setDeleteCandidate(null);
      setDeletingKey(null);
      setApplyConfirmOpen(false);
      setApplyError(null);
    }
  }, [canEdit]);

  useEffect(() => {
    if (!canEditCredentials) {
      setEditingPredefinedKey(null);
    }
  }, [canEditCredentials]);

  const markChangesPending = () => {
    clearOpenrindDesktopEnvSystemContextCache();
    setPendingChanges(true);
    writeOpenrindDesktopEnvPendingChanges(true, props.runtimeKey);
    setApplyError(null);
    onStatusMessage(t("settings.environment.restart_required"));
  };

  // Predefined Sandbox Credentials handlers
  const startEditPredefined = (key: OpenrindShellCredentialKey) => {
    if (!canEditCredentials) return;
    setEditingPredefinedKey(key);
    setPredefinedValue("");
    setPredefinedError(null);
  };

  const cancelEditPredefined = () => {
    setEditingPredefinedKey(null);
    setPredefinedValue("");
    setPredefinedError(null);
  };

  const submitPredefined = async (key: OpenrindShellCredentialKey) => {
    if (!props.onSetCredential || !predefinedValue.trim()) return;
    setPredefinedSaving(true);
    setPredefinedError(null);
    try {
      await props.onSetCredential(key, predefinedValue.trim());
      markChangesPending();
      cancelEditPredefined();
    } catch (err) {
      setPredefinedError(err instanceof Error ? err.message : String(err));
    } finally {
      setPredefinedSaving(false);
    }
  };

  const handleClearPredefined = async (key: OpenrindShellCredentialKey) => {
    if (!props.onClearCredential) return;
    setPredefinedSaving(true);
    try {
      await props.onClearCredential(key);
      markChangesPending();
      cancelEditPredefined();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPredefinedSaving(false);
    }
  };

  // Custom environment variable edit handlers
  const startEditCustom = (item: EnvItem) => {
    if (!canEdit) return;
    setEditingCustomKey(item.key);
    setCustomEditValue(item.value);
    setCustomEditError(null);
  };

  const cancelCustomEdit = () => {
    setEditingCustomKey(null);
    setCustomEditValue("");
    setCustomEditError(null);
  };

  const submitCustomEdit = async (key: string) => {
    if (!client) return;
    setSavingCustom(true);
    setCustomEditError(null);
    try {
      await client.upsertUserEnv([{ key, value: customEditValue }]);
      markChangesPending();
      cancelCustomEdit();
      await refresh();
    } catch (err) {
      setCustomEditError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setSavingCustom(false);
    }
  };

  // Inline "Add variable" handlers
  const openAddInline = () => {
    if (!canEdit) return;
    setIsAddingInline(true);
    setNewKey("");
    setNewValue("");
    setAddError(null);
  };

  const closeAddInline = () => {
    if (savingAdd) return;
    setIsAddingInline(false);
    setNewKey("");
    setNewValue("");
    setAddError(null);
  };

  const submitInlineAdd = async () => {
    const trimmedKey = newKey.trim();
    if (!trimmedKey) {
      setAddError(t("settings.environment.validation_empty"));
      return;
    }

    // Check if key matches a predefined credential
    const matchedPredefined = PREDEFINED_CREDENTIALS.find(
      (p) => p.envVarName.toUpperCase() === trimmedKey.toUpperCase(),
    );

    if (matchedPredefined && props.onSetCredential) {
      setSavingAdd(true);
      setAddError(null);
      try {
        await props.onSetCredential(matchedPredefined.statusKey, newValue);
        markChangesPending();
        closeAddInline();
      } catch (err) {
        setAddError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingAdd(false);
      }
      return;
    }

    // Validate custom key
    const keyErr = validateKey(trimmedKey);
    if (keyErr) {
      setAddError(keyErr);
      return;
    }

    const existingKeys = new Set(items.map((i) => i.key));
    if (existingKeys.has(trimmedKey)) {
      setAddError(t("settings.environment.validation_duplicate"));
      return;
    }

    if (!client) return;
    setSavingAdd(true);
    setAddError(null);
    try {
      await client.upsertUserEnv([{ key: trimmedKey, value: newValue }]);
      markChangesPending();
      closeAddInline();
      await refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setSavingAdd(false);
    }
  };

  const confirmDeleteCustom = async () => {
    if (!client || !deleteCandidate || deletingKey) return;
    const key = deleteCandidate.key;
    setDeletingKey(key);
    try {
      await client.deleteUserEnv(key);
      markChangesPending();
      setDeleteCandidate(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("app.unknown_error"));
    } finally {
      setDeletingKey(null);
    }
  };

  const applyChanges = async () => {
    if (!props.onApplyChanges || applyBusy) return;
    if (props.applyBlocked) {
      const message = applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks");
      setApplyError(message);
      onStatusMessage(message);
      return;
    }
    setApplyBusy(true);
    setApplyError(null);
    try {
      const result = await props.onApplyChanges();
      clearOpenrindDesktopEnvSystemContextCache();
      setPendingChanges(false);
      writeOpenrindDesktopEnvPendingChanges(false);
      setApplyConfirmOpen(false);
      onStatusMessage(result?.statusMessage ?? t("settings.environment.apply_success"));
    } catch (err) {
      const message = err instanceof Error ? err.message : t("app.unknown_error");
      setApplyError(message);
      onStatusMessage(message);
    } finally {
      setApplyBusy(false);
    }
  };

  // Expose all items so stranded predefined keys in the old server store remain visible for deletion
  const customItems = items;

  return (
    <div className="space-y-6">
      <div className={`${settingsPanelClass} space-y-5`}>
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-12">
              {t("settings.environment.title")}
            </div>
            <p className="mt-1 max-w-[58ch] text-xs text-gray-10 leading-relaxed">
              Save API keys, credentials, and tokens for local agents, skills, sandboxes, and MCP servers. Secrets stay on this device.
            </p>
          </div>
          {canEdit ? (
            <Button
              variant="primary"
              className="h-8 shrink-0 px-3 py-0 text-xs"
              onClick={openAddInline}
            >
              <Plus size={13} className="mr-1.5" />
              {t("settings.environment.add_button")}
            </Button>
          ) : null}
        </div>

        {/* Remote workspace notice */}
        {isRemoteWorkspace ? (
          <div className="rounded-lg border border-dls-border/60 bg-dls-surface-muted/40 px-3 py-2 text-xs text-gray-10">
            {t("settings.environment.remote_workspace_hint")}
          </div>
        ) : null}

        {/* OS Keyring warning */}
        {props.credentialStatus && props.credentialStatus.encryptionAvailable === false ? (
          <div className="rounded-xl border border-amber-7/50 bg-amber-2/30 p-3 text-xs text-amber-12">
            The OS keyring isn&apos;t available in this session. Openrind Shell credentials cannot be stored securely until you launch from a graphical session (or install gnome-keyring / kwallet on Linux).
          </div>
        ) : null}

        {/* General error message */}
        {error ? (
          <div className="rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
            {error}
          </div>
        ) : null}

        {/* Pending restart banner */}
        {pendingChanges && !isRemoteWorkspace ? (
          <div className="rounded-xl border border-amber-7/50 bg-amber-3/30 px-3 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-4/70 text-amber-11">
                  <RefreshCw size={14} />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-gray-12">
                    {t("settings.environment.apply_pending_title")}
                  </div>
                  <p className="mt-0.5 max-w-[54ch] text-xs text-gray-10">
                    {props.onApplyChanges
                      ? t("settings.environment.apply_pending_body")
                      : t("settings.environment.apply_pending_body_manual")}
                  </p>
                  {applyBlockedReason ? (
                    <div className="mt-2 rounded-lg border border-amber-7/50 bg-amber-3/30 px-3 py-2 text-xs text-amber-11">
                      {applyBlockedReason}
                    </div>
                  ) : applyError ? (
                    <div className="mt-2 rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
                      {applyError}
                    </div>
                  ) : null}
                </div>
              </div>
              {props.onApplyChanges ? (
                <Button
                  variant="primary"
                  className="h-8 shrink-0 px-3 py-0 text-xs"
                  onClick={() => {
                    if (props.applyBlocked) {
                      const message = applyBlockedReason ?? t("settings.environment.apply_blocked_active_tasks");
                      setApplyError(message);
                      onStatusMessage(message);
                      return;
                    }
                    setApplyConfirmOpen(true);
                  }}
                  disabled={applyBusy || props.applyBlocked}
                  title={applyBlockedReason ?? undefined}
                >
                  <RefreshCw size={13} className={applyBusy ? "animate-spin" : ""} />
                  {applyBusy ? t("settings.environment.applying") : t("settings.environment.apply_button")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Unified Environment Variables List */}
        <div className="space-y-3">
          {/* Predefined Sandbox Credentials Rows */}
          {PREDEFINED_CREDENTIALS.map((cred) => {
            const isSet = props.credentialStatus?.[cred.statusKey] === "set";
            const isEditing = editingPredefinedKey === cred.statusKey;
            const isBusy = props.credentialBusy || predefinedSaving;

            return (
              <div key={cred.envVarName} className="rounded-2xl border border-dls-border bg-dls-surface p-3.5 sm:p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-semibold text-gray-12">{cred.label}</span>
                    </div>
                    {isSet ? (
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-8">
                        <span className="font-mono">
                          {props.credentialStatus?.[`${cred.statusKey}_masked`] || "••••••"}
                        </span>
                        {(() => {
                          const ts = props.credentialStatus?.[`${cred.statusKey}_updatedAt`];
                          if (!ts) return null;
                          return (
                            <>
                              <span>·</span>
                              <span>{formatUpdatedAt(ts)}</span>
                            </>
                          );
                        })()}
                      </div>
                    ) : null}
                    <div className="text-xs text-gray-9 max-w-[65ch] leading-relaxed">{cred.description}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!isEditing ? (
                      <>
                        <Button
                          variant="outline"
                          className="h-7 rounded-full px-3 text-xs"
                          onClick={() => startEditPredefined(cred.statusKey)}
                          disabled={!canEditCredentials || isBusy}
                        >
                          {isSet ? "Update" : "Configure"}
                        </Button>
                        {isSet && props.onClearCredential ? (
                          <Button
                            variant="outline"
                            className="h-7 rounded-full border-red-7/50 px-3 text-xs text-red-12 hover:bg-red-2/30"
                            onClick={() => void handleClearPredefined(cred.statusKey)}
                            disabled={!canEditCredentials || isBusy}
                          >
                            Clear
                          </Button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-3 space-y-2 pt-3 border-t border-dls-border/40">
                    <input
                      type="password"
                      className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]"
                      value={predefinedValue}
                      placeholder={cred.placeholder}
                      autoFocus
                      onChange={(e) => setPredefinedValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submitPredefined(cred.statusKey);
                        if (e.key === "Escape") cancelEditPredefined();
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        className="h-7 rounded-full px-3 text-xs"
                        onClick={() => void submitPredefined(cred.statusKey)}
                        disabled={isBusy || !predefinedValue.trim()}
                      >
                        Save
                      </Button>
                      <Button
                        variant="outline"
                        className="h-7 rounded-full px-3 text-xs"
                        onClick={cancelEditPredefined}
                        disabled={isBusy}
                      >
                        Cancel
                      </Button>
                    </div>
                    {predefinedError ? (
                      <div className="text-xs text-red-11 mt-1">{predefinedError}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Custom User Environment Variables Rows */}
          {customItems.map((item) => {
            const displayValue = maskValue(item.value);
            const isEditing = editingCustomKey === item.key;

            return (
              <div key={item.key} className="rounded-2xl border border-dls-border bg-dls-surface p-3.5 sm:p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-sm font-semibold text-gray-12">{item.key}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-8">
                      <span className="font-mono">{displayValue || t("settings.environment.empty_value")}</span>
                      {item.updatedAt ? (
                        <>
                          <span>·</span>
                          <span>{formatUpdatedAt(item.updatedAt)}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canEdit && !isEditing ? (
                      <>
                        <Button
                          variant="outline"
                          className="h-7 rounded-full px-3 text-xs"
                          onClick={() => startEditCustom(item)}
                          disabled={savingCustom}
                        >
                          Update
                        </Button>
                        <Button
                          variant="outline"
                          className="h-7 rounded-full border-red-7/50 px-3 text-xs text-red-12 hover:bg-red-2/30"
                          onClick={() => setDeleteCandidate(item)}
                          disabled={deletingKey === item.key || savingCustom}
                        >
                          Clear
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {isEditing ? (
                  <div className="mt-3 space-y-2 pt-3 border-t border-dls-border/40">
                    <textarea
                      value={customEditValue}
                      onChange={(e) => setCustomEditValue(e.target.value)}
                      disabled={savingCustom}
                      rows={2}
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        className="h-7 rounded-full px-3 text-xs"
                        onClick={() => void submitCustomEdit(item.key)}
                        disabled={savingCustom}
                      >
                        {savingCustom ? t("settings.environment.saving") : t("settings.environment.save")}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-7 rounded-full px-3 text-xs"
                        onClick={cancelCustomEdit}
                        disabled={savingCustom}
                      >
                        Cancel
                      </Button>
                    </div>
                    {customEditError ? (
                      <div className="text-xs text-red-11 mt-1">{customEditError}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}

          {/* Generated Inline Input Row for "+ Add variable" */}
          {isAddingInline ? (
            <div className="rounded-2xl border border-dls-accent/50 bg-dls-surface p-4 shadow-md space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-12">{t("settings.environment.add_title")}</span>
                <Button variant="ghost" className="h-6 w-6 p-0" onClick={closeAddInline} disabled={savingAdd}>
                  <X size={14} />
                </Button>
              </div>
              <div className="space-y-3">
                <TextInput
                  label={t("settings.environment.key_label")}
                  hint={t("settings.environment.key_hint")}
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  disabled={savingAdd}
                  autoFocus
                  placeholder="e.g. GOOGLE_API_KEY"
                />
                <label className="block">
                  <div className="mb-1 text-xs font-medium text-dls-secondary">
                    {t("settings.environment.value_label")}
                  </div>
                  <textarea
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    disabled={savingAdd}
                    rows={2}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Enter secret or key value..."
                    className="w-full rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs text-dls-text shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                  />
                </label>
                {addError ? (
                  <div className="rounded-lg border border-red-7 bg-red-3/40 px-3 py-2 text-xs text-red-11">
                    {addError}
                  </div>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" className="h-7 px-3 text-xs" onClick={closeAddInline} disabled={savingAdd}>
                  {t("settings.environment.cancel")}
                </Button>
                <Button
                  variant="primary"
                  className="h-7 px-3 text-xs"
                  onClick={() => void submitInlineAdd()}
                  disabled={savingAdd || !newKey.trim()}
                >
                  {savingAdd ? t("settings.environment.saving") : t("settings.environment.save")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer Hints */}
        {!isRemoteWorkspace ? (
          <div className="space-y-1 text-[11px] text-gray-8 pt-1">
            <div>{t("settings.environment.footer_hint")}</div>
            <div>{t("settings.environment.override_hint")}</div>
          </div>
        ) : null}
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        open={deleteCandidate !== null}
        title={t("settings.environment.delete_title")}
        message={deleteCandidate ? t("settings.environment.confirm_delete").replace("{key}", deleteCandidate.key) : ""}
        confirmLabel={deletingKey ? t("settings.environment.deleting") : t("settings.environment.delete")}
        cancelLabel={t("settings.environment.cancel")}
        variant="danger"
        confirmButtonVariant="danger"
        onConfirm={() => void confirmDeleteCustom()}
        onCancel={() => {
          if (!deletingKey) setDeleteCandidate(null);
        }}
      />

      {/* Apply Restart Confirmation Modal */}
      <ConfirmModal
        open={applyConfirmOpen}
        title={t("settings.environment.apply_title")}
        message={t("settings.environment.apply_confirm_body")}
        confirmLabel={applyBusy ? t("settings.environment.applying") : t("settings.environment.apply_button")}
        cancelLabel={t("settings.environment.cancel")}
        variant="warning"
        confirmButtonVariant="primary"
        onConfirm={() => void applyChanges()}
        onCancel={() => {
          if (!applyBusy) setApplyConfirmOpen(false);
        }}
      />
    </div>
  );
}
