# Build one isolated challenge image from a caller-supplied task directory.
# The build context must contain the Openrind CTF runtime (RUNTIME_DIR) and the
# challenge task directory (TASK_DIR). The task directory must contain a
# flag.txt for the judge and, for non-default layouts, a challenge.json with
# the task metadata (entrypoint, workingDirectory, backendPort).
FROM node:22.19.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates iproute2 nftables util-linux python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd sandbox \
    && useradd -m -d /sandbox -g sandbox -s /bin/sh sandbox \
    && ln -s /usr/local/bin/node /usr/bin/node

# Paths inside the build context. There are no bundled tasks; the caller
# supplies the challenge directory at build time.
ARG RUNTIME_DIR=openrind-desktop/packages/ctf-runtime
ARG TASK_DIR

# Fail before the COPY lines so an unset TASK_DIR cannot copy the whole context.
RUN test -n "$TASK_DIR" || (echo "TASK_DIR build-arg is required: path to the challenge directory inside the build context" >&2; exit 1)

WORKDIR /opt/openrind-ctf
COPY ${RUNTIME_DIR}/package.json ./package.json
COPY ${RUNTIME_DIR}/src/ ./src/
COPY ${RUNTIME_DIR}/bin/challenge.mjs ./bin/challenge.mjs
COPY ${TASK_DIR}/ /opt/openrind-ctf/task/

# The challenge server runs the task entrypoint with this Python venv. Flask is
# preinstalled because most web challenges need it; a task requirements.txt
# (at the root or in chall/ / challenge/) is installed on top.
RUN test -f /opt/openrind-ctf/task/flag.txt \
      || (echo "The task directory must contain flag.txt for the challenge judge" >&2; exit 1) \
    && python3 -m venv /opt/openrind-ctf/venv \
    && /opt/openrind-ctf/venv/bin/pip install --no-cache-dir \
      Flask==2.3.3 Flask-RESTful==0.3.10 colorama==0.4.6 \
    && if [ -f /opt/openrind-ctf/task/requirements.txt ]; then \
      /opt/openrind-ctf/venv/bin/pip install --no-cache-dir -r /opt/openrind-ctf/task/requirements.txt; \
    elif [ -f /opt/openrind-ctf/task/chall/requirements.txt ]; then \
      /opt/openrind-ctf/venv/bin/pip install --no-cache-dir -r /opt/openrind-ctf/task/chall/requirements.txt; \
    elif [ -f /opt/openrind-ctf/task/challenge/requirements.txt ]; then \
      /opt/openrind-ctf/venv/bin/pip install --no-cache-dir -r /opt/openrind-ctf/task/challenge/requirements.txt; \
    fi \
    && install -m 0444 /opt/openrind-ctf/task/flag.txt /flag.txt \
    && node --check bin/challenge.mjs \
    && chown -R sandbox:sandbox /opt/openrind-ctf /sandbox

USER sandbox
WORKDIR /sandbox
CMD ["sleep", "infinity"]
