import type { Context } from "grammy";
import { env } from "../../config/env.js";
import { getUser } from "../../wallet/walletService.js";
import { enableSmartAccount, isSmartAccount, revokeSession, DelegationError } from "../../custody/delegation.js";
import { registry } from "../../registry/registry.js";
import { explorerAddressUrl } from "../../chain/networks.js";
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

  // SECURITY GATE (multi-agent audit): the delegate's on-chain caps are enforced
  // by decoding a hardcoded selector list, so any allowlisted spender holding a
  // standing ERC-20 allowance can move funds without the amount/recipient checks
  // running — proven with executable PoCs. Enumerating selectors cannot close
  // this; it needs balance-delta accounting (a contract rewrite + redeploy).
  // Until then /upgrade is OFF and every user stays on the contained-custodial
  // path, which is unaffected. UPGRADE_7702_ENABLED=true re-enables it for
  // deliberate testnet exercise.
  if (!env.upgrade7702Enabled) {
    await ctx.reply(
      "🔒 <b>Smart-account upgrade is temporarily disabled.</b>\n\n" +
        "Our security audit found that the session-key delegate's on-chain spending caps " +
        "can be bypassed in some cases, so we've turned the upgrade off rather than ship a " +
        "weaker guarantee than we advertise.\n\n" +
        "Nothing else is affected - swaps, borrowing, earning, locking and voting all work " +
        "normally on your existing account, and every action still shows a confirmation " +
        "before it signs.",
      { parse_mode: "HTML" },
    );
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
        // Link the ACCOUNT (its delegation status is reliably indexed); the
        // set-code (type-0x04) tx itself is not rendered by the Mezo explorer yet,
        // so linking it 404s. Keep the tx hash as copyable text for reference.
        `${link("View your smart account", explorerAddressUrl(env.network, user.address))}\n` +
        (hash ? `Set-code tx: ${code(hash)}\n\n` : "\n") +
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

/**
 * /revoke — kill the account's session key immediately.
 *
 * The delegate has always had `revokeSession`, and nothing in the bot called it,
 * so a leaked session key stayed valid for its full 30-day TTL with no way for
 * the user to stop it. This is the caller.
 *
 * Deliberately NOT behind a confirmation card: revocation is the safe direction,
 * and asking someone to tap twice while they believe their key is compromised is
 * the wrong trade. The root key is unaffected — the account keeps working on the
 * contained-custodial path.
 */
export async function handleRevoke(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;
  const user = getUser(telegramId);
  if (!user) {
    await ctx.reply("You don't have an account yet. Send /start.");
    return;
  }
  if (!user.session) {
    await ctx.reply("There's no session key on this account, so there's nothing to revoke.");
    return;
  }

  await ctx.reply("⏳ Revoking the session key…");
  const { onChain, txHash, orphans } = await revokeSession(user);

  if (onChain && orphans === 0) {
    await ctx.reply(
      `🔒 ${b("Session key revoked.")}\n\nIt can no longer sign anything, on-chain or through this bot.\n` +
        (txHash ? `${code(txHash)}\n\n` : "\n") +
        `Your account still works normally - actions are signed directly again, within your /limits.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Be explicit that the key is still live on-chain. The delegate can only
  // revoke a key by name and registering a new one does NOT invalidate the old
  // one, so "disabled in this bot" is a materially weaker statement than
  // "revoked" and must not be worded as though it were the same thing.
  await ctx.reply(
    `⚠️ ${b("Partly revoked.")}\n\n` +
      `This bot will not sign through the session key again - that took effect immediately.\n\n` +
      `But I could not land the on-chain revocation, so ${b("the key is still valid on the delegate")} ` +
      `until it expires. I've kept its address and will retry automatically the next time you run /revoke.\n\n` +
      `${b("Run /revoke again in a few minutes")} until it reports a clean revocation.` +
      (orphans > 1 ? `\n\n(${orphans} keys are pending on-chain revocation.)` : ""),
    { parse_mode: "HTML" },
  );
}
