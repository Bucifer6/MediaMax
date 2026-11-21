# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64, linux/arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 -t kinora .

# ---- build ----
# Runs on the build machine's own architecture: the output (JavaScript, the web app and pure-JS
# dependencies; Kinora uses no native addons) is the same for every target, so arm64 images don't
# need to run npm and Vite under emulation.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev --workspaces --include-workspace-root

# ---- runtime ----
FROM node:22-bookworm-slim
ARG TARGETARCH
# ffmpeg with VA-API drivers for hardware transcoding: Mesa (AMD, and Intel through Gallium) on every arch,
# plus Intel's iHD (QSV/VA-API on Broadwell and newer, incl. Synology/QNAP Celerons) and i965 on amd64.
# For NVIDIA use the nvidia container runtime.
RUN set -eux; \
    if [ "$TARGETARCH" = "amd64" ]; then \
      sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
      extra="intel-media-va-driver-non-free i965-va-driver"; \
    else \
      extra=""; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools ca-certificates tzdata mesa-va-drivers $extra; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/shared/package.json shared/package.json
COPY --from=build /src/shared/dist shared/dist
COPY --from=build /src/server/package.json server/package.json
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/server/help server/help
COPY --from=build /src/web/dist web/dist
COPY --from=caddy:2 /usr/bin/caddy /usr/local/bin/caddy
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/kinora-entrypoint
# Defaults under the original MEDIAMAX_* names, so a container started with either name works: a KINORA_* variable
# you pass (e.g. -e KINORA_PORT=9000) overrides these; a MEDIAMAX_* one replaces them as before.
ENV NODE_ENV=production \
    MEDIAMAX_DATA=/config \
    MEDIAMAX_TRANSCODE_DIR=/transcode \
    MEDIAMAX_RECORDINGS=/recordings \
    MEDIAMAX_PORT=8484
VOLUME ["/config", "/transcode", "/recordings"]
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.KINORA_PORT||process.env.MEDIAMAX_PORT||8484)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Optional PUID/PGID: run as that user (see docker/entrypoint.sh). Unset = root, as in earlier images.
ENTRYPOINT ["/usr/local/bin/kinora-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
