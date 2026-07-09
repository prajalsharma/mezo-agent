import type { Context } from "grammy";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { enableSmartAccount, isSmartAccount, DelegationError } from "../../custody/delegation.js";
import { registry } from "../../registry/registry.js";
import { explorerTxUrl } from "../../chain/networks.js";
import { limitsOf, fmtBtc } from "../../custody/policy.js";
import { b, i, code, link } from "../format.js";

/**
 * /upgrade — turn the account into an EIP-7702 smart account (Option A). The
 * root self-signs a set-code authorization pointing at the SessionKeyDelegate
 * and registers a scoped session key, so routine ops are signed by the session
 * key and bounded on-chain.
 */
export async function handleUpgrade(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return;
  }

  if (!registry.hasContract("Delegate7702")) {
    await ctx.reply(
      "⚠️ The session-key delegate isn't deployed/registered for this network yet, " +
        "so the smart-account upgrade is unavailable. Token swaps still work via the " +
        "direct signing path.",
    );
    return;
  }

  if (await isSmartAccount(user)) {
    await ctx.reply(
      `${b("Already upgraded.")}\nThis account is an EIP-7702 smart account.\n` +
        `Session key: ${code(user.session!.address)}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const limits = limitsOf(user.limits);
  await ctx.reply(
    `⏳ Upgrading to an EIP-7702 smart account…\n` +
      i(
        `A scoped session key will sign routine ops, bounded on-chain to ` +
          `${fmtBtc(limits.perTxNativeWei)}/tx and ${fmtBtc(limits.dailyNativeWei)}/24h.`,
      ),
    { parse_mode: "HTML" },
  );

  try {
    const upgraded = await enableSmartAccount(user);
    const hash = upgraded.delegation?.txHash;
    await ctx.reply(
      `✅ ${b("Smart account enabled.")}\n\n` +
        `Session key: ${code(upgraded.session!.address)}\n` +
        (hash
          ? `${link("Set-code tx on explorer", explorerTxUrl(env.network, hash))}\n\n`
          : "\n") +
        `Routine ops are now signed by the session key and enforced on-chain. ` +
        `Your root key stays cold except for upgrades and revocation.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  } catch (err) {
    if (err instanceof DelegationError) {
      await ctx.reply(`❌ Upgrade failed: ${err.message}`);
    } else {
      throw err; // surfaced by the global error boundary
    }
  }
}
