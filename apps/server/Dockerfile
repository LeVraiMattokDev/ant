# syntax=docker/dockerfile:1.7
# Image shared by the `web` and `worker` services. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t ant-server .
# Stages: deps (manifests only) → prod-deps (runtime node_modules) and build (sources) → runtime.
# prod-deps depends only on the manifests and the lockfile, so a code change rebuilds neither it nor
# the ~340 MB node_modules layer of the image (the Claude Code binary of the Agent SDK).

FROM node:22-bookworm-slim AS deps
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @ant/server... --filter @ant/ui...

# Production dependencies only, for the libc of this image (pnpm-workspace.yaml: supportedArchitectures).
# @ant/shared is bundled into dist by tsup: its injected copy is removed.
FROM deps AS prod-deps
RUN pnpm --filter @ant/server deploy --prod --legacy /out \
 && rm -rf /out/node_modules/@ant /out/node_modules/.pnpm/@ant+shared* /out/node_modules/.pnpm/node_modules/@ant

FROM deps AS build
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/ui apps/ui
RUN pnpm --filter @ant/ui build && pnpm --filter @ant/server build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /out/node_modules ./node_modules
COPY --from=prod-deps /out/package.json ./package.json
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/server/drizzle ./drizzle
COPY --from=build /repo/apps/ui/dist ./ui
RUN mkdir -p /data/claude /data/agent-cwd && chown -R node:node /data
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/drizzle \
    UI_DIST=/app/ui \
    CLAUDE_CONFIG_DIR=/data/claude \
    AGENT_CWD=/data/agent-cwd \
    HOME=/home/node
USER node
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/web.js"]
