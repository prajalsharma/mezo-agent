import { env } from "./config/env.js";
import { hydrateFromRemote } from "./db/remote.js";
import { errMsg } from "./core/log.js";

/**
 * Boot order matters here. The Store is created at IMPORT time and reads the
 * local file then, so with DATABASE_URL set the file must be pulled from
 * Postgres FIRST - only then is the rest of the app (and the Store) imported.
 * See src/db/remote.ts.
 */
// Render's free plan has no persistent disk: without Postgres every restart
// would wipe every wallet. A paid plan with a disk at DATA_DIR opts out.
if (process.env.RENDER && !process.env.DATABASE_URL && process.env.STORE_ON_DISK !== "true") {
  console.error(
    "Fatal: running on Render without DATABASE_URL. The filesystem here is wiped on restart, so " +
      "wallets would be lost. Set DATABASE_URL (see README, Render), or STORE_ON_DISK=true if a " +
      "persistent disk is mounted at DATA_DIR.",
  );
  process.exit(1);
}

try {
  const mirror = await hydrateFromRemote({ url: process.env.DATABASE_URL, dataDir: env.dataDir, network: env.network });
  if (mirror) console.log("🗄️  Store loaded from Postgres (DATABASE_URL); local file is a cache.");
} catch (err) {
  console.error("Fatal:", errMsg(err));
  process.exit(1);
}
await import("./main.js");
