# syntax=docker/dockerfile:1.7

# Pinned, multi-architecture OCI index for Node.js 24.20.0 on Debian Bookworm.
# The per-platform digests and verification date are recorded in
# deploy/docker/base-image.lock.
ARG NODE_IMAGE="node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"
ARG BUILDPLATFORM

# Build/test outputs are architecture-neutral JavaScript, CSS, and WebAssembly.
# Keep this stage native so a cross-build never runs timing-sensitive tests
# through CPU emulation; the runtime stage below still targets each requested
# platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts ./
COPY Dockerfile compose.yaml .dockerignore ./
COPY LICENSE THIRD_PARTY_NOTICES.md README.md PROJECT_HANDOFF.md BACKLOG.md AGENTS.md ./
COPY client ./client
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY tests ./tests
COPY third_party/boko ./third_party/boko
COPY deploy ./deploy
COPY outputs ./outputs

# Assemble a release image only after the repository's test and build gate.
RUN npm run check
RUN mkdir -p dist/release \
    && npm sbom --sbom-format cyclonedx > dist/release/sbom.cdx.json \
    && npm sbom --sbom-format cyclonedx --omit dev > dist/release/sbom.runtime.cdx.json \
    && cd client/vendor/boko \
    && printf '%s  %s\n' \
      '738797303669e53c45c050537640d5535d8c54072b8770a78064e5b080c0d3cc' 'boko.js' \
      '5cc7e4fcd9116218ad7dcaae54e0dbfdead726069c4e6f40176e63a55605c338' 'boko_bg.wasm' \
      | sha256sum -c - \
    && sha256sum boko.js boko_bg.wasm > ../../../dist/release/boko-artifacts.sha256 \
    && sha256sum boko_bg.wasm > ../../../dist/release/boko-wasm.sha256

FROM ${NODE_IMAGE} AS runtime

ARG APP_VERSION="0.1.0"
ARG BUILD_DATE="unknown"
ARG VCS_REF="unknown"
ARG SOURCE_URL="local"

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    TMPDIR=/cache \
    CATALOG_HOST=0.0.0.0 \
    CATALOG_PORT=8080 \
    CATALOG_DATABASE_PATH=/data/catalog.sqlite \
    CATALOG_CACHE_DIRECTORY=/cache \
    CATALOG_ALLOWED_ROOTS=/libraries \
    CATALOG_ALLOWED_HOSTS=localhost:8080,127.0.0.1:8080,[::1]:8080 \
    CATALOG_STATIC_DIRECTORY=/app/dist/client \
    CATALOG_SETTINGS_MODE=read-write \
    CATALOG_ROOT_POLICY_TIMEOUT_MS=10000 \
    CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS=10000 \
    CATALOG_SOURCE_RESPONSE_TIMEOUT_MS=600000 \
    CATALOG_COVER_RESPONSE_TIMEOUT_MS=30000

WORKDIR /app
LABEL org.opencontainers.image.title="Kindle Bridge" \
      org.opencontainers.image.description="Private Docker-hosted ebook catalog with browser-local Kindle transfer" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="${SOURCE_URL}"

RUN mkdir -p /data /cache /libraries /usr/share/kindle-bridge/source \
    && chown -R 1000:1000 /data /cache

COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/deploy/docker/healthcheck.mjs /usr/local/lib/kindle-bridge/healthcheck.mjs
COPY --from=build --chown=1000:1000 /app/LICENSE /app/THIRD_PARTY_NOTICES.md /usr/share/kindle-bridge/

# Corresponding source and deterministic build inputs accompany every image.
COPY --from=build --chown=1000:1000 /app/package.json /app/package-lock.json /app/tsconfig.json /app/tsconfig.server.json /app/vite.config.ts /app/vitest.config.ts /usr/share/kindle-bridge/source/
COPY --from=build --chown=1000:1000 /app/Dockerfile /app/compose.yaml /app/.dockerignore /usr/share/kindle-bridge/source/
COPY --from=build --chown=1000:1000 /app/README.md /app/PROJECT_HANDOFF.md /app/BACKLOG.md /app/AGENTS.md /usr/share/kindle-bridge/source/
COPY --from=build --chown=1000:1000 /app/client /usr/share/kindle-bridge/source/client
COPY --from=build --chown=1000:1000 /app/server /usr/share/kindle-bridge/source/server
COPY --from=build --chown=1000:1000 /app/shared /usr/share/kindle-bridge/source/shared
COPY --from=build --chown=1000:1000 /app/scripts /usr/share/kindle-bridge/source/scripts
COPY --from=build --chown=1000:1000 /app/tests /usr/share/kindle-bridge/source/tests
COPY --from=build --chown=1000:1000 /app/third_party/boko /usr/share/kindle-bridge/source/third_party/boko
COPY --from=build --chown=1000:1000 /app/deploy /usr/share/kindle-bridge/source/deploy
COPY --from=build --chown=1000:1000 /app/outputs /usr/share/kindle-bridge/source/outputs

USER 1000:1000
EXPOSE 8080
VOLUME ["/data", "/cache"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/usr/local/lib/kindle-bridge/healthcheck.mjs"]

CMD ["node", "dist/server/main.js"]
