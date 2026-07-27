import { defineChain } from "viem";
import { env } from "../config/env.js";
import type { NetworkName } from "../config/env.js";

/**
 * Mezo network parameters, transcribed from the canonical docs:
 *   https://mezo.org/docs/users/getting-started/connect
 *
 * Note: the native gas asset is BTC with **18 decimals** on Mezo (not 8).
 * All gas accounting and native-balance formatting uses 18 decimals.
 *
 * Mainnet default RPC: the docs list several endpoints; the imperator one
 * rejects JSON-RPC POSTs (405), so we default to the public validationcloud
 * endpoint, which is verified working. Override either network with MEZO_RPC_URL.
 */

export const MEZO_TESTNET = defineChain({
  id: 31611,
  name: "Mezo Matsnet Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://rpc.test.mezo.org"],
      webSocket: ["wss://rpc-ws.test.mezo.org"],
    },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer (Testnet)", url: "https://explorer.test.mezo.org" },
  },
  testnet: true,
});

export const MEZO_MAINNET = defineChain({
  id: 31612,
  name: "Mezo Mainnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://mainnet.mezo.public.validationcloud.io"],
      webSocket: ["wss://mainnet.mezo.public.validationcloud.io"],
    },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" },
  },
  testnet: false,
});

export function chainFor(network: NetworkName) {
  const base = network === "mainnet" ? MEZO_MAINNET : MEZO_TESTNET;
  // Allow an operator RPC override without losing the chain metadata.
  if (env.rpcUrl) {
    return defineChain({ ...base, rpcUrls: { default: { http: [env.rpcUrl] } } });
  }
  return base;
}

export function explorerTxUrl(network: NetworkName, hash: string): string {
  return `${chainFor(network).blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(network: NetworkName, address: string): string {
  return `${chainFor(network).blockExplorers.default.url}/address/${address}`;
}
