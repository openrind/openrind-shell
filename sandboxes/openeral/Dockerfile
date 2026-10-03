    # Openrind Shell primary sandbox: OpenShell-mounted PostgreSQL FUSE workspace.
# Keep synchronized with sandboxes/openeral/Dockerfile. Dockerfile.openeral is
# retained as a legacy entry point.

FROM node:22.19.0-bookworm-slim AS browser-client-builder
WORKDIR /source/openrind-desktop/packaging/browser-client
COPY openrind-desktop/packaging/browser-client/package.json openrind-desktop/packaging/browser-client/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY openrind-desktop/packaging/browser-client/entry.mjs openrind-desktop/packaging/browser-client/build.mjs ./
COPY openrind-desktop/packaging/browser-client/preflight-entry.mjs openrind-desktop/packaging/browser-client/mcp.json ./
COPY openrind-desktop/packaging/browser-client/provision-entry.mjs ./
COPY openrind-desktop/packaging/browser-client/edge-entry.mjs ./
COPY openrind-desktop/packaging/browser-client/worker-entry.mjs ./
COPY openrind-desktop/packaging/browser-client/bridge/ ./bridge/
COPY openrind-desktop/packages/browser-client/src/ /source/openrind-desktop/packages/browser-client/src/
COPY openrind-desktop/packages/browser-contract/src/ /source/openrind-desktop/packages/browser-contract/src/
COPY openrind-desktop/packages/browser-core/src/ /source/openrind-desktop/packages/browser-core/src/
COPY openrind-desktop/packages/browser-providers/src/ /source/openrind-desktop/packages/browser-providers/src/
COPY openrind-desktop/packages/browser-service/src/ /source/openrind-desktop/packages/browser-service/src/
RUN npm run build

FROM rust:1.95-bookworm AS fused-builder

WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
COPY sandboxes/openeral/openclaw-agent-launcher.c sandboxes/openeral/openhands-agent-launcher.c ./
COPY openrind-desktop/packages/browser-client/native/launcher.c browser-client-launcher.c
RUN cargo build --locked --release -p openeral-fused \
    && cc -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra -Werror \
        -o openrind-openclaw-agent openclaw-agent-launcher.c \
    && cc -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra -Werror \
        -o openrind-openhands-agent openhands-agent-launcher.c \
    && cc -std=c11 -D_POSIX_C_SOURCE=200809L -O2 -Wall -Wextra -Werror \
        -o openrind-browser-client browser-client-launcher.c \
    && strip target/release/openeral-fused openrind-openclaw-agent openrind-openhands-agent openrind-browser-client

FROM ghcr.io/nvidia/openshell-community/sandboxes/base:latest

LABEL com.openrind.desktop.fuse-contract="fuse-haloop-required-v29-browser-client"

USER root

ARG OPENCLAW_VERSION=2026.7.1-2
ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error "openclaw@${OPENCLAW_VERSION}" \
    && test -x /usr/bin/openclaw \
    && test -f /usr/lib/node_modules/openclaw/openclaw.mjs \
    && rm -rf /var/lib/apt/lists/*

RUN /usr/bin/python3.12 -m venv --copies /opt/openrind-openhands \
    && /opt/openrind-openhands/bin/python3.12 -m pip install --no-cache-dir "openhands==1.16.0" \
    && /opt/openrind-openhands/bin/python3.12 -I -c 'import sys; from openhands_cli.entrypoint import main; sys.argv = ["openhands", "--help"]; main()'

COPY openeral-js/ /opt/openrind-shell/
RUN cd /opt/openrind-shell && npm install && npm run build && npm prune --omit=dev \
    && chmod -R a+rX /opt/openrind-shell \
    && chown -R sandbox:sandbox /opt/openrind-shell \
    && ln -s /opt/openrind-shell /opt/openeral

RUN rm -f /usr/local/bin/claude \
    && npm install -g --prefix /usr/local --loglevel=error "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && test -x /usr/local/bin/claude \
    && claude_version="$(/usr/local/bin/claude --version | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)" \
    && test -n "$claude_version" \
    && test "$(printf '%s\n' 2.1.227 "$claude_version" | sort -V | head -n1)" = 2.1.227 \
    && mv /usr/local/bin/claude /usr/local/bin/claude-real

COPY --from=fused-builder /source/target/release/openeral-fused /usr/local/bin/openrind-shell-fused
# OpenShell authorizes this kernel-visible parent, never the shared Node runtime.
COPY --from=fused-builder /source/openrind-openclaw-agent /usr/local/bin/openrind-openclaw-agent
COPY --from=fused-builder /source/openrind-openhands-agent /usr/local/bin/openrind-openhands-agent
COPY --from=fused-builder /source/openrind-browser-client /usr/local/bin/openrind-browser-client
COPY --from=browser-client-builder /source/openrind-desktop/packaging/browser-client/dist/ /opt/openrind-browser/
# The endpoint descriptor is installed by trusted provisioning, not baked with
# a default endpoint or credentials. Unprovisioned client startup fails closed.
RUN mkdir -p /etc/openrind-browser \
    && chown -R root:root /etc/openrind-browser /opt/openrind-browser /usr/local/bin/openrind-browser-client \
    && chmod 0755 /etc/openrind-browser /opt/openrind-browser /usr/local/bin/openrind-browser-client \
    && chmod 0644 /opt/openrind-browser/*.cjs /opt/openrind-browser/*.json
COPY sandboxes/openeral/openhands-agent.py /opt/openrind-openhands/openhands-agent.py
COPY sandboxes/openeral/openrind-openhands-fuse.sh /usr/local/bin/openrind-openhands
COPY sandboxes/openeral/openeral-claude-fuse.sh /usr/local/bin/claude
COPY sandboxes/openeral/haloop-agent-proxy.mjs /opt/openrind-shell/haloop-agent-proxy.mjs
COPY sandboxes/openeral/pg-client-fuse.mjs /usr/local/bin/pg
COPY sandboxes/openeral/setup-fuse.sh /opt/openrind-shell/setup.sh
COPY sandboxes/openeral/openrind-pty-bridge.py /opt/openrind-shell/openrind-pty-bridge.py
COPY sandboxes/openeral/openrind-desktop-claude-launch.sh /usr/local/bin/openrind-desktop-claude-launch
COPY sandboxes/openeral/configure-haloop.mjs /opt/openrind-shell/configure-haloop.mjs
COPY sandboxes/openeral/configure-openclaw-fuse.mjs /opt/openrind-shell/configure-openclaw-fuse.mjs
COPY sandboxes/openeral/openrind-openclaw-fuse.sh /usr/local/bin/openrind-openclaw
COPY sandboxes/openeral/supabase-root-2021-ca.pem /opt/openrind-shell/certs/supabase-root-2021-ca.pem
RUN chmod 755 /usr/local/bin/openrind-shell-fused /usr/local/bin/claude /usr/local/bin/pg /usr/local/bin/openrind-desktop-claude-launch \
        /usr/local/bin/openrind-openhands /usr/local/bin/openrind-openhands-agent \
        /usr/local/bin/openrind-openclaw /usr/local/bin/openrind-openclaw-agent \
        /opt/openrind-shell/haloop-agent-proxy.mjs \
        /opt/openrind-shell/setup.sh /opt/openrind-shell/openrind-pty-bridge.py \
        /opt/openrind-shell/configure-haloop.mjs \
        /opt/openrind-shell/configure-openclaw-fuse.mjs \
    && chmod 644 /opt/openrind-shell/certs/supabase-root-2021-ca.pem \
    && install -m 0644 /opt/openrind-shell/certs/supabase-root-2021-ca.pem /usr/local/share/ca-certificates/supabase-root-2021-ca.crt \
    && cat /opt/openrind-shell/certs/supabase-root-2021-ca.pem >> /etc/ssl/certs/ca-certificates.crt \
    && sed -i 's/\r$//' /usr/local/bin/claude /usr/local/bin/pg /usr/local/bin/openrind-desktop-claude-launch \
        /usr/local/bin/openrind-openhands /usr/local/bin/openrind-openclaw \
        /opt/openrind-shell/setup.sh /opt/openrind-shell/openrind-pty-bridge.py \
        /opt/openrind-shell/configure-haloop.mjs \
        /opt/openrind-shell/configure-openclaw-fuse.mjs \
    && bash -n /usr/local/bin/openrind-openhands \
    && /opt/openrind-openhands/bin/python3.12 -m py_compile /opt/openrind-openhands/openhands-agent.py \
    && bash -n /usr/local/bin/openrind-openclaw \
    && bash -n /opt/openrind-shell/setup.sh \
    && node --check /opt/openrind-shell/configure-haloop.mjs \
    && node --check /opt/openrind-shell/configure-openclaw-fuse.mjs \
    && printf '%s' fuse-haloop-required-v29-browser-client > /opt/openrind-shell/desktop-contract \
    && ln -sf /usr/local/bin/openrind-shell-fused /usr/local/bin/openeral-fused \
    && ln -sf /opt/openrind-shell/setup.sh /usr/local/bin/openrind-shell \
    && ln -sf /opt/openrind-shell/setup.sh /usr/local/bin/openrind-shell-init \
    && ln -sf /opt/openrind-shell/setup.sh /usr/local/bin/openrind-shell-start \
    && ln -sf /usr/local/bin/openrind-shell /usr/local/bin/openeral \
    && ln -sf /usr/local/bin/openrind-shell-init /usr/local/bin/openeral-init \
    && ln -sf /usr/local/bin/openrind-shell-start /usr/local/bin/openeral-start \
    && ln -sf /opt/openrind-shell/openrind-pty-bridge.py /usr/local/bin/openrind-pty-bridge.py \
    && install -d -o sandbox -g sandbox -m 0700 \
        /var/lib/openrind-shell/runtime /sandbox/claude-home /sandbox/openclaw-home /sandbox/openhands-home \
        /home/agent /home/agent/.openrind-shell

COPY sandboxes/openeral/policy.yaml /etc/openshell/policy.yaml
COPY --chown=root:root .claude/skills/ /opt/openrind-shell/skills/

WORKDIR /sandbox
