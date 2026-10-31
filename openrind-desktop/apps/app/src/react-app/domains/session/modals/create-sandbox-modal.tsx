/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Boxes, Settings, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { t } from "../../../../i18n";
import type { SandboxProfile } from "../../../../app/lib/desktop";
import {
  modalBodyClass,
  modalHeaderButtonClass,
  modalHeaderClass,
  modalOverlayClass,
  modalShellClass,
  modalTitleClass,
  inputClass,
  inputLabelClass,
  pillPrimaryClass,
  pillGhostClass,
} from "../../workspace/modal-styles";
import { writeSandboxProfile } from "../../session/sidebar/sandbox-prefs";
import { deriveSandboxName } from "../../session/sidebar/use-sandbox-rows";

type CredentialStatus = {
  databaseUrl: "set" | "unset" | "unknown";
  anthropicApiKey: "set" | "unset" | "unknown";
  openRouterApiKey?: "set" | "unset" | "unknown";
  codexApiKey?: "set" | "unset" | "unknown";
  openaiApiKey?: "set" | "unset" | "unknown";
  openrindShellAgent: string | null;
  openrindGatewayApiBase: string | null;
};

export type CreateSandboxModalProps = {
  open: boolean;
  onClose: () => void;
  existingNames: string[];
};

export function CreateSandboxModal(props: CreateSandboxModalProps) {
  const navigate = useNavigate();

  const [profile, setProfile] = useState<SandboxProfile>("openrind-shell-claude");
  const [newName, setNewName] = useState("");
  const [creds, setCreds] = useState<CredentialStatus | null>(null);

  // Reset form when modal opens
  useEffect(() => {
    if (props.open) {
      setNewName("");
      setProfile("openrind-shell-claude");

      const bridge = window.__OPENRIND_DESKTOP_ELECTRON__;
      if (bridge?.invokeDesktop) {
        bridge.invokeDesktop("openrindCredentialStatus")
          .then((status) => setCreds(status as CredentialStatus))
          .catch(() => setCreds(null));
      }
    }
  }, [props.open]);

  const dbReady = creds?.databaseUrl === "set";
  const apiReady = creds?.anthropicApiKey === "set" || creds?.openRouterApiKey === "set" || creds?.codexApiKey === "set" || creds?.openaiApiKey === "set";
  const dbBlocked = !dbReady;
  const authBlocked = !apiReady;
  
  const isBlocked = dbBlocked || authBlocked;

  const previewName = useMemo(() => deriveSandboxName(newName), [newName]);
  const nameTaken = useMemo(
    () => Boolean(previewName) && props.existingNames.includes(previewName),
    [previewName, props.existingNames]
  );

  const canCreate = Boolean(previewName) && !nameTaken && creds !== null && !isBlocked;

  const handleCreate = () => {
    if (!canCreate) return;
    writeSandboxProfile(previewName, profile);
    props.onClose();
    navigate("/session", {
      state: { openrindSandbox: { name: previewName, profile } },
    });
  };

  if (!props.open) return null;

  return (
    <div className={modalOverlayClass} onClick={props.onClose}>
      <div
        className={`${modalShellClass} max-w-[560px]`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className={modalHeaderClass}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-accent">
              <Boxes size={20} />
            </div>
            <div>
              <h2 className={modalTitleClass}>{t("sandbox.new_sandbox")}</h2>
              <div className="mt-1 text-[13px] text-dls-secondary">
                {t("sandbox.new_sandbox_desc")}
              </div>
            </div>
          </div>
          <button
            type="button"
            className={modalHeaderButtonClass}
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className={modalBodyClass}>
          {creds !== null && dbBlocked ? (
            <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-7/40 bg-amber-2/20 p-4 text-amber-12">
              <Settings size={16} className="mt-0.5 shrink-0" />
              <div className="flex-1 text-[13px]">
                <div className="font-medium">{t("sandbox.db_missing_title")}</div>
                <div className="opacity-90 mt-1">
                  {t("sandbox.db_missing_desc")}
                </div>
              </div>
              <button
                type="button"
                className={`${pillGhostClass} border-amber-7/50 text-amber-12 hover:bg-amber-2/40`}
                onClick={() => {
                  props.onClose();
                  navigate("/settings/environment");
                }}
              >
                {t("settings.configure")}
              </button>
            </div>
          ) : creds !== null && authBlocked ? (
            <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-7/40 bg-amber-2/20 p-4 text-amber-12">
              <Settings size={16} className="mt-0.5 shrink-0" />
              <div className="flex-1 text-[13px]">
                <div className="font-medium">{t("sandbox.auth_missing_title")}</div>
                <div className="opacity-90 mt-1">
                  {t("sandbox.auth_missing_desc")}
                </div>
              </div>
              <button
                type="button"
                className={`${pillGhostClass} border-amber-7/50 text-amber-12 hover:bg-amber-2/40`}
                onClick={() => {
                  props.onClose();
                  navigate("/settings/environment");
                }}
              >
                {t("settings.configure")}
              </button>
            </div>
          ) : null}

          <div className="space-y-4">
            <div>
              <label className={`mb-1.5 block ${inputLabelClass}`}>{t("sandbox.name_label")}</label>
              <input
                className={inputClass}
                placeholder="my-project"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canCreate) handleCreate();
                }}
              />
              {nameTaken ? (
                <div className="mt-2 text-[13px] text-amber-11">
                  {t("sandbox.name_taken")}
                </div>
              ) : previewName ? (
                <div className="mt-2 text-[13px] text-dls-secondary">
                  {t("sandbox.creates_name")} <code className="rounded bg-gray-2/40 px-1 py-0.5 text-[11px]">{previewName}</code>
                </div>
              ) : null}
            </div>
            <div>
              <label className={`mb-1.5 block ${inputLabelClass}`}>{t("sandbox.agent_label")}</label>
              <select
                className={inputClass}
                value={profile}
                onChange={(e) => setProfile(e.target.value as SandboxProfile)}
              >
                <option value="openrind-shell-claude">{t("sandbox.agent_claude")}</option>
                <option value="openrind-shell-openclaw">{t("sandbox.agent_openclaw")}</option>
                <option value="openrind-shell-codex">{t("sandbox.agent_codex") || "Codex CLI"}</option>
                <option value="openrind-shell-openhands">OpenHands CLI</option>
              </select>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 border-t border-dls-border px-6 py-5">
          <button
            type="button"
            className="rounded-full px-4 py-2 text-[13px] font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            onClick={props.onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={pillPrimaryClass}
            onClick={handleCreate}
            disabled={!canCreate}
          >
            {t("sandbox.create_launch")}
          </button>
        </div>
      </div>
    </div>
  );
}
