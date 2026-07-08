import { defineChain } from "viem";
import type { NetworkName } from "../config/env.js";

/**
 * Mezo network parameters, transcribed verbatim from the canonical docs:
 *   https://mezo.org/docs/users/getting-started/connect
 *
 * Note: the native gas asset is BTC with **18 decimals** on Mezo (not 8).
 * All gas accounting and native-balance formatting uses 18 decimals.
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
      http: ["https://rpc_evm-mezo.imperator.co"],
      webSocket: ["wss://ws_evm-mezo.imperator.co"],
    },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" },
  },
  testnet: false,
});

export function chainFor(network: NetworkName) {
  return network === "mainnet" ? MEZO_MAINNET : MEZO_TESTNET;
}

export function explorerTxUrl(network: NetworkName, hash: string): string {
  return `${chainFor(network).blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(network: NetworkName, address: string): string {
  return `${chainFor(network).blockExplorers.default.url}/address/${address}`;
}
