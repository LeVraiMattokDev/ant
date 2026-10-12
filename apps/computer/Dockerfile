# syntax=docker/dockerfile:1
# « Ordinateur » des agents Ant. Construire depuis la RACINE du dépôt :
#   docker build -f apps/computer/Dockerfile -t ant-computer .
# (le fichier apps/computer/Dockerfile.dockerignore limite le contexte envoyé).

############################ build ############################
FROM node:22-bookworm-slim AS build
ENV CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
# node-pty n'a pas de binaire précompilé Linux : outils de compilation nécessaires.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

# 1) Manifestes seuls (cache des dépendances). Le lockfile est celui de la racine du monorepo.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/computer/package.json apps/computer/
# Repli documenté : si le lockfile est momentanément désynchronisé par des modifications
# concurrentes d'autres paquets, remplacer --frozen-lockfile par --no-frozen-lockfile ici et plus bas.
RUN pnpm install --frozen-lockfile --filter @ant/computer...

# 2) Sources + bundle (tsup intègre @ant/shared ; les dépendances npm restent externes).
COPY packages/shared packages/shared
COPY apps/computer apps/computer
RUN pnpm --filter @ant/computer typecheck && pnpm --filter @ant/computer build

# 3) node_modules de production à plat (node-linker=hoisted) pour /app/node_modules.
#    @ant/shared est déjà dans le bundle : son lien de workspace est retiré.
RUN rm -rf node_modules packages/shared/node_modules apps/computer/node_modules \
 && pnpm install --frozen-lockfile --prod --filter @ant/computer... --config.node-linker=hoisted \
 && rm -rf node_modules/@ant node_modules/.pnpm node_modules/.modules.yaml

########################### runtime ###########################
FROM node:22-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LANG=C.UTF-8 \
    DISPLAY=:99 \
    PORT=7000 \
    VNC_PORT=5900 \
    WORKSPACE_ROOT=/workspace \
    BROWSER_PROFILE_DIR=/home/agent/.ant-browser

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini xvfb x11vnc openbox tmux git curl wget ca-certificates \
      python3 python3-pip python3-venv jq unzip procps \
      fonts-noto fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /repo/node_modules /app/node_modules
COPY --from=build /repo/apps/computer/dist /app/dist
COPY --from=build /repo/apps/computer/package.json /app/package.json

# Chromium de la version exacte de Playwright embarquée + ses dépendances système.
# --no-shell : le mode headless utilise aussi ce Chromium (channel « chromium »).
RUN node /app/node_modules/playwright/cli.js install --with-deps --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright

# L'image node fournit l'utilisateur « node » (uid 1000) : on le remplace par « agent ».
RUN userdel -r node \
 && useradd --create-home --uid 1000 --user-group --shell /bin/bash agent \
 && mkdir -p /workspace /home/agent/.ant-browser /tmp/.X11-unix \
 && chown agent:agent /workspace /home/agent/.ant-browser \
 && chmod 1777 /tmp/.X11-unix \
 && printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf

COPY apps/computer/entrypoint.sh /app/entrypoint.sh
RUN chmod 0755 /app/entrypoint.sh

USER agent
WORKDIR /workspace
EXPOSE 7000
# /livez : sans authentification et sans information (le /health complet exige le jeton).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-7000}/livez" >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
