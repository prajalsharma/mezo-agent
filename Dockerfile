# Mezo Agent — long-polling Telegram bot.
#
# Polling (not webhooks) is deliberate: it needs no public HTTPS endpoint, no
# inbound ports, and no TLS certificate, so the container can run anywhere with
# only outbound network access. src/index.ts also calls deleteWebhook on boot,
# because a webhook left registered on the token makes getUpdates return 409 and
# the bot silently receives nothing.
FROM node:20-slim

WORKDIR /app

# `npm ci` — NOT `npm install`. The lockfile is committed precisely so the
# production image gets the exact dependency tree that was reviewed and audited.
# `npm install` re-resolves every semver range at build time, so a compromised or
# merely broken patch release of any transitive dependency lands in a container
# that holds encrypted private keys, with nothing recording that it changed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# The datastore holds ENCRYPTED user key material. This MUST be backed by a
# persistent volume — see the warning in README. On an ephemeral filesystem every
# redeploy destroys every user's wallet, and because there is no plaintext export
# path, those funds are unrecoverable.
#
# No Docker VOLUME directive here: Railway's builder rejects it outright
# ("docker VOLUME is not supported, use Railway Volumes"). Attach the volume in
# the platform UI (Railway: right-click service → Attach volume → /data).
ENV DATA_DIR=/data

# tsx runs the TypeScript sources directly. Run NODE directly (not npx/npm): a
# wrapper process intercepts SIGTERM on redeploy and exits non-zero, which
# Railway reports as "Deployment crashed". With node as the process, SIGTERM
# reaches the graceful shutdown handler in src/index.ts → clean exit 0.
RUN npm install tsx@^4.19.0

# Drop root. node:slim ships an unprivileged `node` user; the image had no USER
# directive, so the process — and anything that ever achieves execution inside
# it — ran as uid 0 next to the encrypted key store.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

CMD ["node", "--import", "tsx", "src/index.ts"]
