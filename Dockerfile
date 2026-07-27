# Mezo Agent — long-polling Telegram bot.
#
# Polling (not webhooks) is deliberate: it needs no public HTTPS endpoint, no
# inbound ports, and no TLS certificate, so the container can run anywhere with
# only outbound network access. src/index.ts also calls deleteWebhook on boot,
# because a webhook left registered on the token makes getUpdates return 409 and
# the bot silently receives nothing.
FROM node:20-slim

WORKDIR /app

# package-lock.json is gitignored in this repo, so `npm ci` is not available.
COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# The datastore holds ENCRYPTED user key material. This MUST be backed by a
# persistent volume — see the warning in README. On an ephemeral filesystem every
# redeploy destroys every user's wallet, and because there is no plaintext export
# path, those funds are unrecoverable.
ENV DATA_DIR=/data
VOLUME ["/data"]

# tsx runs the TypeScript sources directly, matching `npm start` locally.
RUN npm install tsx@^4.19.0
CMD ["npx", "tsx", "src/index.ts"]
