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

# Drop root — but at RUNTIME, not here.
#
# node:slim ships an unprivileged `node` user and the image had no USER
# directive, so the process ran as uid 0 next to the encrypted key store. The
# obvious fix (chown at build time + `USER node`) is WRONG on a platform with
# attached volumes: Railway mounts its volume over /data after the image is
# built, so the build-time ownership is thrown away and the mount arrives owned
# by root. uid 1000 then gets EACCES on the file holding every user's sealed
# key, and the container crash-loops on boot.
#
# So the entrypoint starts as root, chowns the volume that actually exists, and
# then drops to `node` before exec'ing the app. /app is chowned here because it
# is baked into the image and no mount covers it.
RUN chown -R node:node /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "src/index.ts"]
