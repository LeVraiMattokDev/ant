# syntax=docker/dockerfile:1.7
# Image shared by the `web` and `worker` services. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t ant-server .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @ant/server... --filter @ant/ui...
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/ui apps/ui
RUN pnpm --filter @ant/ui build && pnpm --filter @ant/server build
# Production dependencies only (includes the Claude Code native binary of the Agent SDK).
RUN pnpm --filter @ant/server deploy --prod --legacy /out

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
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
