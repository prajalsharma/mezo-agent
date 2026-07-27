import { createPublicClient, http, type PublicClient } from "viem";
import { env } from "../config/env.js";
import { chainFor } from "./networks.js";

/**
 * Shared read-only RPC client. The write path (signing/submitting) lives in the
 * isolated Signer service; this client is used only for reads and simulation.
 */
let cached: PublicClient | undefined;

export function publicClient(): PublicClient {
  if (!cached) {
    const chain = chainFor(env.network);
    cached = createPublicClient({
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    });
  }
  return cached;
}
