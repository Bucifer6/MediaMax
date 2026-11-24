# syntax=docker/dockerfile:1
# Multi-arch (linux/amd64, linux/arm64):
#   docker buildx build --platform linux/amd64,linux/arm64 -t kinora .

# ---- build ----
# Runs on the build machine's own architecture: the output (JavaScript, the web app and pure-JS
# dependencies; Kinora uses no native addons) is the same for every target, so arm64 images don't
# need to run npm and Vite under emulation.
FROM --platform=$BUILDPLATFORM node:26-bookworm-slim AS build
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
FROM node:26-bookworm-slim
ARG TARGETARCH
# jellyfin-ffmpeg: upstream ffmpeg plus the hardware paths the transcoder uses (tonemap_cuda / tonemap_opencl bt2390,
# Rockchip RKMPP + RGA on arm64, Dolby Vision reshaping) and a bundled Intel iHD + oneVPL runtime, so QSV and
# VA-API work on current Intel (N100, Arc, Core Ultra). Linked into /usr/local/bin as ffmpeg / ffprobe.
# Distro VA drivers stay for AMD (Mesa) and pre-Broadwell Intel (i965); intel-opencl-icd enables OpenCL tone-mapping.
# For NVIDIA use the nvidia container runtime (see docs/INSTALL.md).
ADD --chmod=644 https://repo.jellyfin.org/jellyfin_team.gpg.key /etc/apt/keyrings/jellyfin.asc
RUN set -eux; \
    if [ "$TARGETARCH" = "amd64" ]; then \
      sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
      extra="intel-media-va-driver-non-free i965-va-driver intel-opencl-icd"; \
    else \
      extra=""; \
    fi; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/jellyfin.asc] https://repo.jellyfin.org/debian bookworm main" > /etc/apt/sources.list.d/jellyfin.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends jellyfin-ffmpeg7 libchromaprint-tools ca-certificates tzdata mesa-va-drivers $extra; \
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg; \
    ln -s /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe; \
    ffmpeg -hide_banner -version | head -1; \
    rm -rf /var/lib/apt/lists/*
# NVIDIA runtime: expose NVENC/NVDEC (video), CUDA (compute: -init_hw_device cuda, tonemap_cuda) and nvidia-smi (utility).
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility
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
