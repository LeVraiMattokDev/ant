# syntax=docker/dockerfile:1
# « Ordinateur » des agents Ant. Construire depuis la RACINE du dépôt :
#   docker build -f apps/computer/Dockerfile -t ant-computer .
# (le fichier apps/computer/Dockerfile.dockerignore limite le contexte envoyé).
# Étapes : deps (manifestes) → prod-deps (node_modules d'exécution) et build (sources) → runtime.
# Chromium est installé dans une couche qui ne dépend que de la version de Playwright : une
# modification du code ne retélécharge ni Chromium ni ses dépendances système.

############################# deps ############################
FROM node:22-bookworm-slim AS deps
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

# Manifestes seuls (cache des dépendances). Le lockfile est celui de la racine du monorepo.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/computer/package.json apps/computer/
# Repli documenté : si le lockfile est momentanément désynchronisé par des modifications
# concurrentes d'autres paquets, remplacer --frozen-lockfile par --no-frozen-lockfile ici.
RUN pnpm install --frozen-lockfile --filter @ant/computer...

########################## prod-deps ##########################
# Dépendances d'exécution de @ant/computer seulement (node-pty, playwright, ws, zod) : pas celles des
# autres paquets du lockfile partagé. @ant/shared est déjà dans le bundle : sa copie est retirée.
FROM deps AS prod-deps
RUN pnpm --filter @ant/computer deploy --prod --legacy /out \
 && rm -rf /out/node_modules/@ant /out/node_modules/.pnpm/@ant+shared* /out/node_modules/.pnpm/node_modules/@ant

############################ build ############################
# Sources + bundle (tsup intègre @ant/shared ; les dépendances npm restent externes).
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/computer apps/computer
RUN pnpm --filter @ant/computer typecheck && pnpm --filter @ant/computer build

###################### playwright-version #####################
# Version exacte de Playwright, seule donnée dont dépend la couche Chromium du runtime.
FROM node:22-bookworm-slim AS playwright-version
COPY apps/computer/package.json /tmp/package.json
RUN node -e " \
  const v = require('/tmp/package.json').dependencies.playwright; \
  if (!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(v)) { \
    console.error('playwright doit être épinglé à une version exacte dans apps/computer/package.json (trouvé : ' + v + ')'); \
    process.exit(1); \
  } \
  require('fs').writeFileSync('/playwright-version', v);"

########################### runtime ###########################
FROM node:22-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    LANG=C.UTF-8 \
    DISPLAY=:99 \
    PORT=7000 \
    VNC_SOCKET=/tmp/.ant-vnc/vnc.sock \
    WORKSPACE_ROOT=/workspace \
    BROWSER_PROFILE_DIR=/home/agent/.ant-browser

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini xvfb x11vnc openbox tmux git curl wget ca-certificates \
      python3 python3-pip python3-venv jq unzip procps \
      fonts-noto fonts-noto-color-emoji fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Chromium de la version exacte de Playwright embarquée + ses dépendances système.
# --no-shell : le mode headless utilise aussi ce Chromium (channel « chromium »).
COPY --from=playwright-version /playwright-version /tmp/playwright-version
RUN npx -y "playwright@$(cat /tmp/playwright-version)" install --with-deps --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/playwright-version \
 && chmod -R a+rX /ms-playwright

# L'image node fournit l'utilisateur « node » (uid 1000) : on le remplace par « agent ».
# /tmp et /home/agent sont des tmpfs pris sur la mémoire du conteneur (docker-compose.yml) : pas de cache
# pip, et le cache npm (npm, npx) sur le volume /workspace. Fichiers de configuration globaux : l'environnement
# des commandes des agents est volontairement minimal (agentEnv), il ne transmet pas de variables PIP_* ou npm_config_*.
RUN userdel -r node \
 && useradd --create-home --uid 1000 --user-group --shell /bin/bash agent \
 && mkdir -p /workspace /home/agent/.ant-browser /tmp/.X11-unix /usr/local/etc \
 && chown agent:agent /workspace /home/agent/.ant-browser \
 && chmod 1777 /tmp/.X11-unix \
 && printf '[global]\nbreak-system-packages = true\nno-cache-dir = true\n' > /etc/pip.conf \
 && printf 'cache=/workspace/.cache/npm\n' > /usr/local/etc/npmrc

WORKDIR /app
COPY --from=prod-deps /out/node_modules /app/node_modules
COPY --from=build /repo/apps/computer/dist /app/dist
COPY --from=build /repo/apps/computer/package.json /app/package.json
COPY apps/computer/entrypoint.sh /app/entrypoint.sh
# Garde-fou (sans réseau) : le Chromium installé plus haut est bien celui qu'attend le Playwright de node_modules.
RUN dirs="$(node /app/node_modules/playwright/cli.js install --dry-run --no-shell chromium | sed -n 's/^ *Install location: *//p')" \
 && [ -n "$dirs" ] \
 && for dir in $dirs; do \
      test -d "$dir" || { echo "Navigateur attendu absent : $dir (versions de Playwright différentes ?)" >&2; exit 1; }; \
    done \
 && chmod 0755 /app/entrypoint.sh

USER agent
WORKDIR /workspace
EXPOSE 7000
# /livez : sans authentification et sans information (le /health complet exige le jeton).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-7000}/livez" >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
