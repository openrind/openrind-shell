/**
 * Localized labels for sandbox status and agent profile.
 *
 * Split out of the panel because the command palette shows the same status text,
 * and two copies of this switch would inevitably drift — the palette would keep
 * saying "Ready" for a sandbox the sidebar had started calling "Agent not
 * responding".
 *
 * Kept separate from sandbox-status.ts so that module stays pure and testable
 * without pulling in the i18n runtime.
 */

import { t } from "../../../../i18n";
import type { SandboxStatus } from "./sandbox-status";
import type { SandboxProfile } from "../../../../app/lib/desktop";

export function sandboxStatusLabel(status: SandboxStatus): string {
  switch (status) {
    case "active":
      return t("sandbox.status_active");
    case "idle":
      return t("sandbox.status_idle");
    case "starting":
      return t("sandbox.status_starting");
    case "unhealthy":
      return t("sandbox.status_unhealthy");
    case "failed":
      return t("sandbox.status_failed");
    case "stopped":
      return t("sandbox.status_stopped");
    case "deleting":
      return t("sandbox.status_deleting");
    default:
      return t("sandbox.status_unknown");
  }
}

export function sandboxAgentLabel(profile: SandboxProfile): string {
  if (profile === "openrind-shell-codex") return t("sandbox.agent_codex") || "Codex CLI";
  if (profile === "openrind-shell-openhands") return "OpenHands CLI";
  if (profile === "openrind-shell-openhands-script") return "OpenHands Script";
  return profile === "openrind-shell-openclaw"
    ? t("sandbox.agent_openclaw")
    : t("sandbox.agent_claude");
}
