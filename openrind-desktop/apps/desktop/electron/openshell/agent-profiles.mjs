// Canonical Agent Profile Registry (Section 8 - WP2)

export const AGENT_PROFILES = {
  "openrind-shell-claude": {
    id: "claude",
    label: "Claude Code",
    homeMount: "/sandbox/claude-home",
    volumePrefix: "openrind-claude-home-",
    mode: "cli",
    binary: "/usr/local/bin/claude",
    description: "Anthropic Claude Code CLI with native bash and FUSE workspace integration",
  },
  "openrind-shell-openclaw": {
    id: "openclaw",
    label: "OpenClaw",
    homeMount: "/sandbox/openclaw-home",
    volumePrefix: "openrind-openclaw-home-",
    mode: "cli",
    binary: "/usr/local/bin/openrind-openclaw",
    description: "OpenClaw multi-channel agent with embedded local TUI and Haloop proxy routing",
  },
  "openrind-shell-codex": {
    id: "codex",
    label: "Codex CLI",
    homeMount: "/sandbox/codex-home",
    volumePrefix: "openrind-codex-home-",
    mode: "cli",
    binary: "codex",
    description: "OpenAI Codex CLI with OpenAI Responses wire API and danger-full-access sandbox",
  },
  "openrind-shell-openhands": {
    id: "openhands",
    label: "OpenHands CLI",
    homeMount: "/sandbox/openhands-home",
    volumePrefix: "openrind-openhands-home-",
    mode: "cli",
    binary: "/usr/local/bin/openrind-openhands",
    description: "OpenHands CLI with Python environment and Haloop edge integration",
  },
  "openrind-shell-openhands-script": {
    id: "openhands",
    label: "OpenHands Script",
    homeMount: "/sandbox/openhands-home",
    volumePrefix: "openrind-openhands-home-",
    mode: "script",
    binary: "/usr/local/bin/openrind-openhands",
    description: "OpenHands batch script runner for headless evaluations",
  },
};

export function getAgentProfile(profileKey) {
  const profile = AGENT_PROFILES[profileKey];
  if (!profile) {
    throw new Error(`Unsupported Openrind Shell profile: ${profileKey}`);
  }
  return profile;
}

export function isValidProfile(profileKey) {
  return Boolean(AGENT_PROFILES[profileKey]);
}

export function getAllSupportedProfiles() {
  return Object.keys(AGENT_PROFILES);
}
