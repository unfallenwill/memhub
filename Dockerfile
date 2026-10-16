# syntax=docker/dockerfile:1
#
# MemHub daemon image.
#
# Runtime base: Debian slim (glibc), NOT Alpine — onnxruntime-node, the
# embedding runtime behind @huggingface/transformers, only ships glibc
# binaries and cannot load on musl.
#
# Size strategy (multi-stage; only the last stage forms the image):
# - compile with tsc + Vite in a throwaway stage, copy just the JS output
# - install production dependencies separately, then prune natives:
#     * onnxruntime-web (~136MB) is never imported by the Node build of
#       transformers (its WASM bundle is inlined) — deleted entirely
#     * onnxruntime-node bundles darwin/win32 + foreign-arch binaries
#       (~220MB); only linux/<arch> is kept
#     * native .node/.so libraries are stripped of debug symbols
# - tsc output ships as .js only (no .d.ts / source maps)
#
# Cloud deployment: the image binds 0.0.0.0 (container default) and keeps
# the token + Host-header protections. Set at runtime:
#   MEMHUB_TOKEN           fixed API token (else generated into /data/token)
#   MEMHUB_ALLOWED_HOSTS   comma-separated hostnames the Host check accepts
#   MEMHUB_PORT            port (default 7800)
# Mount a volume at /data to persist SQLite, the vector index and the
# cached embedding model.

ARG NODE_IMAGE=node:24-slim

# ---------- stage: build the server (tsc) and the web UI (Vite) ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Skip the onnxruntime-node postinstall CUDA download: CPU binaries ship
# in the npm package, the GPU providers would only be fetched from nuget.org.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm install -g pnpm@12
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN pnpm run build \
 && pnpm --filter memhub-web run build

# ---------- stage: production dependencies, pruned and stripped ----------
FROM ${NODE_IMAGE} AS deps
ARG TARGETARCH
WORKDIR /app
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm install -g pnpm@12 \
 && apt-get update \
 && apt-get install -y --no-install-recommends binutils \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/package.json
# --filter memhub: runtime deps of the daemon only (the web workspace's
# deps are build-time only; its compiled assets are copied from `build`).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --prod --filter memhub

# Keep only the native binaries the Linux runtime can load.
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) NAPI_ARCH=x64 ;; \
      arm64) NAPI_ARCH=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && rm -rf node_modules/.pnpm/onnxruntime-web@* \
          node_modules/.pnpm/onnxruntime-common@1.31* \
          node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/darwin \
          node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/win32 \
 && for d in node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/*; do \
      [ "$(basename "$d")" = "$NAPI_ARCH" ] || rm -rf "$d"; \
    done \
 && find node_modules/.pnpm -type f \( -name '*.node' -o -name '*.so' -o -name '*.so.*' \) \
      -exec sh -c 'for f; do strip --strip-unneeded "$f" 2>/dev/null || true; done' sh {} +

# ---------- stage: runtime ----------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="memhub" \
      org.opencontainers.image.description="Local-first memory card daemon for AI coding agents" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    MEMHUB_HOME=/data \
    MEMHUB_HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/web/dist ./web/dist
RUN find dist -type f \( -name '*.d.ts' -o -name '*.map' \) -delete \
 && mkdir -p /data \
 && chown node:node /data
USER node
EXPOSE 7800
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MEMHUB_PORT||'7800')+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/src/cli/index.js"]
CMD ["server", "--foreground"]
