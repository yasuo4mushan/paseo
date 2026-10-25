# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS source-pack

ARG AASWITCH_VERSION

ENV ONNXRUNTIME_NODE_INSTALL=skip

WORKDIR /tmp/aaswitch-src
COPY . .

RUN set -eux; \
    if [ -n "${AASWITCH_VERSION:-}" ]; then \
      test "$(node -p "require('./package.json').version")" = "${AASWITCH_VERSION}"; \
    fi; \
    node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); delete pkg.scripts.prepare; fs.writeFileSync("package.json", `${JSON.stringify(pkg)}\n`);'; \
    npm ci

RUN set -eux; \
    mkdir -p /tmp/aaswitch-packs; \
    npm pack --workspace=@aaswitch/highlight --pack-destination /tmp/aaswitch-packs; \
    npm pack --workspace=@aaswitch/relay --pack-destination /tmp/aaswitch-packs; \
    npm pack --workspace=@aaswitch/protocol --pack-destination /tmp/aaswitch-packs; \
    npm pack --workspace=@aaswitch/client --pack-destination /tmp/aaswitch-packs; \
    npm pack --workspace=@aaswitch/plugin --pack-destination /tmp/aaswitch-packs; \
    npm pack --workspace=@aaswitch/server --pack-destination /tmp/aaswitch-packs; \
    npm pack --workspace=aaswitch --pack-destination /tmp/aaswitch-packs

FROM ${NODE_IMAGE}

ENV HOME=/home/aaswitch \
    AASWITCH_HOME=/home/aaswitch/.aaswitch \
    AASWITCH_LISTEN=0.0.0.0:6767 \
    AASWITCH_WEB_UI_ENABLED=true \
    AASWITCH_LOG_FORMAT=json \
    AASWITCH_LOG_LEVEL=info \
    CLAUDE_CONFIG_DIR=/home/aaswitch/.claude \
    CODEX_HOME=/home/aaswitch/.codex \
    XDG_CONFIG_HOME=/home/aaswitch/.config \
    XDG_DATA_HOME=/home/aaswitch/.local/share \
    XDG_STATE_HOME=/home/aaswitch/.local/state \
    XDG_CACHE_HOME=/home/aaswitch/.cache \
    ONNXRUNTIME_NODE_INSTALL=skip

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      gosu \
      lbzip2 \
      openssh-client \
      procps \
      tini; \
    rm -rf /var/lib/apt/lists/*

COPY --from=source-pack /tmp/aaswitch-packs /tmp/aaswitch-packs
RUN set -eux; \
	npm install -g /tmp/aaswitch-packs/*.tgz; \
    rm -rf /tmp/aaswitch-packs; \
    npm cache clean --force; \
    server_entry="$(npm root -g)/@aaswitch/server/dist/scripts/supervisor-entrypoint.js"; \
    test -f "$server_entry"; \
    printf '%s\n' "$server_entry" > /etc/aaswitch-server-entry; \
    node --check "$server_entry"

RUN set -eux; \
    existing_group="$(getent group 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_group" ] && [ "$existing_group" != "aaswitch" ]; then \
      groupmod --new-name aaswitch "$existing_group"; \
    elif [ -z "$existing_group" ]; then \
      groupadd --gid 1000 aaswitch; \
    fi; \
    existing_user="$(getent passwd 1000 | cut -d: -f1 || true)"; \
    if [ -n "$existing_user" ] && [ "$existing_user" != "aaswitch" ]; then \
      usermod --login aaswitch --gid aaswitch --home /home/aaswitch --shell /bin/bash "$existing_user"; \
    elif [ -z "$existing_user" ]; then \
      useradd --uid 1000 --gid aaswitch --create-home --home-dir /home/aaswitch --shell /bin/bash aaswitch; \
    fi; \
    mkdir -p \
      /workspace \
      "$AASWITCH_HOME" \
      "$CLAUDE_CONFIG_DIR" \
      "$CODEX_HOME" \
      "$XDG_CONFIG_HOME" \
      "$XDG_DATA_HOME" \
      "$XDG_STATE_HOME" \
      "$XDG_CACHE_HOME"; \
    chown -R aaswitch:aaswitch /home/aaswitch /workspace

COPY docker/base/rootfs/ /
RUN chmod +x /usr/local/bin/aaswitch-docker-entrypoint

WORKDIR /workspace

EXPOSE 6767
VOLUME ["/home/aaswitch"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const listen=process.env.AASWITCH_LISTEN||'0.0.0.0:6767'; const m=listen.match(/:(\\d+)$/); const port=m?Number(m[1]):6767; require('http').get({hostname:'127.0.0.1',port,path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/aaswitch-docker-entrypoint"]
