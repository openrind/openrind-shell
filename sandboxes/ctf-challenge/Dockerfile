# Build one isolated image per challenge with its original application files.
FROM node:22.19.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates iproute2 nftables util-linux python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd sandbox \
    && useradd -m -d /sandbox -g sandbox -s /bin/sh sandbox \
    && ln -s /usr/local/bin/node /usr/bin/node

ARG TASK_ID

WORKDIR /opt/openrind-ctf
COPY openrind-desktop/packages/ctf-runtime/package.json ./package.json
COPY openrind-desktop/packages/ctf-runtime/src/ ./src/
COPY openrind-desktop/packages/ctf-runtime/bin/challenge.mjs ./bin/challenge.mjs
COPY sandboxes/ctf-challenge/tasks/${TASK_ID}/ /opt/openrind-ctf/task/

RUN case "$TASK_ID" in flag-command|glacier-exchange) ;; *) echo "Unsupported TASK_ID" >&2; exit 1 ;; esac \
    && python3 -m venv /opt/openrind-ctf/venv \
    && /opt/openrind-ctf/venv/bin/pip install --no-cache-dir \
      Flask==2.3.3 Flask-RESTful==0.3.10 colorama==0.4.6 \
    && install -m 0444 /opt/openrind-ctf/task/flag.txt /flag.txt \
    && node --check bin/challenge.mjs \
    && chown -R sandbox:sandbox /opt/openrind-ctf /sandbox

USER sandbox
WORKDIR /sandbox
CMD ["sleep", "infinity"]
