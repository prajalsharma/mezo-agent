/**
 * On-chain verification of candidate contract addresses BEFORE they are wired
 * into the registry.
 *
 * The bounty requires reading addresses from the canonical reference and
 * forbids hardcoding stale values. Docs can be out of date, so a published
 * address is a candidate, not a fact. This script proves three things per
 * address: code is deployed, the contract answers a selector its interface
 * must implement, and — where the protocol links contracts together — the
 * cross-references agree (BorrowerOperations.troveManager() == TroveManager).
 * That last check is what distinguishes "some contract exists here" from
 * "this is the real, linked deployment".
 *
 *   MEZO_NETWORK=mainnet npx tsx scripts/verifyaddrs.ts
 */
import "./_testenv.js";
import { type Address, encodeFunctionData, decodeAbiParameters } from "viem";
import { publicClient } from "../src/chain/client.js";
import { chainFor } from "../src/chain/networks.js";
import { env } from "../src/config/env.js";

const net = chainFor(env.network);
const client = publicClient();

/** Candidates from https://mezo.org/docs/developers/musd/musd-redemptions */
const CANDIDATES: Record<string, Record<string, Address>> = {
  mainnet: {
    BorrowerOperations: "0x44b1bac67dDA612a41a58AAf779143B181dEe031",
    TroveManager: "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193",
    HintHelpers: "0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3",
    SortedTroves: "0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f",
    PriceFeed: "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88",
  },
  testnet: {
    BorrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5",
    TroveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
    HintHelpers: "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6",
    SortedTroves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
    PriceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
  },
};

/** Selectors each contract must answer if it really is what the docs claim. */
const PROBES: Record<string, { name: string; type: "address" | "uint256" }[]> = {
  BorrowerOperations: [
    { name: "troveManager", type: "address" },
    { name: "sortedTroves", type: "address" },
    { name: "priceFeed", type: "address" },
    { name: "musd", type: "address" },
  ],
  TroveManager: [
    { name: "borrowerOperations", type: "address" },
    { name: "getTroveOwnersCount", type: "uint256" },
    { name: "MCR", type: "uint256" },
  ],
  SortedTroves: [
    { name: "getSize", type: "uint256" },
    { name: "getFirst", type: "address" },
  ],
  // `fetchPrice`, NOT `lastGoodPrice`. The latter exists in musd only as an
  // EVENT parameter, so probing it returned empty data on both networks and the
  // probe's catch swallowed it — PriceFeed silently failed verification while
  // the registry claimed every address "answers its own interface". This is the
  // contract every collateral-ratio check depends on, so it was the worst one to
  // be checking with a selector that cannot succeed.
  PriceFeed: [{ name: "fetchPrice", type: "uint256" }],
  HintHelpers: [{ name: "sortedTroves", type: "address" }],
};

async function probe(addr: Address, fn: string, type: "address" | "uint256") {
  try {
    const data = encodeFunctionData({
      abi: [{ type: "function", name: fn, inputs: [], outputs: [{ type }], stateMutability: "view" }],
      functionName: fn,
    });
    const res = await client.call({ to: addr, data });
    if (!res.data || res.data === "0x") return undefined;
    return decodeAbiParameters([{ type }], res.data)[0] as string | bigint;
  } catch {
    return undefined;
  }
}

async function main() {
  const netName = process.env.MEZO_NETWORK ?? "testnet";
  const set = CANDIDATES[netName];
  if (!set) throw new Error(`no candidates for ${netName}`);
  console.log(`\nVerifying ${netName} (chain ${net.id}) via ${net.rpcUrls.default.http[0]}\n`);

  const resolved: Record<string, string | bigint | undefined> = {};
  let ok = 0, bad = 0;

  for (const [name, addr] of Object.entries(set)) {
    const code = await client.getCode({ address: addr });
    const deployed = !!code && code !== "0x";
    const size = deployed ? (code!.length - 2) / 2 : 0;
    if (!deployed) {
      console.log(`❌ ${name.padEnd(19)} ${addr}  NO CODE`);
      bad++;
      continue;
    }
    const answers: string[] = [];
    for (const p of PROBES[name] ?? []) {
      const v = await probe(addr, p.name, p.type);
      if (v !== undefined) {
        answers.push(`${p.name}=${typeof v === "bigint" ? v.toString() : v}`);
        resolved[`${name}.${p.name}`] = v;
      }
    }
    if (answers.length === 0) {
      console.log(`⚠️  ${name.padEnd(19)} ${addr}  code ${size}B but answered NO probe`);
      bad++;
    } else {
      console.log(`✅ ${name.padEnd(19)} ${addr}  code ${size}B`);
      for (const a of answers) console.log(`      ${a}`);
      ok++;
    }
  }

  // Cross-reference invariants — the real proof these are the linked deployment.
  console.log("\nCross-references:");
  const eq = (a?: string | bigint, b?: string) =>
    typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
  const checks: [string, boolean][] = [
    ["BorrowerOperations.troveManager == TroveManager",
      eq(resolved["BorrowerOperations.troveManager"] as string, set.TroveManager)],
    ["BorrowerOperations.sortedTroves == SortedTroves",
      eq(resolved["BorrowerOperations.sortedTroves"] as string, set.SortedTroves)],
    ["BorrowerOperations.priceFeed == PriceFeed",
      eq(resolved["BorrowerOperations.priceFeed"] as string, set.PriceFeed)],
    ["TroveManager.borrowerOperations == BorrowerOperations",
      eq(resolved["TroveManager.borrowerOperations"] as string, set.BorrowerOperations)],
    ["HintHelpers.sortedTroves == SortedTroves",
      eq(resolved["HintHelpers.sortedTroves"] as string, set.SortedTroves)],
  ];
  let xok = 0;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "✅" : "— "} ${label}`);
    if (pass) xok++;
  }

  console.log(`\n  contracts verified: ${ok}/${ok + bad}   cross-refs matched: ${xok}/${checks.length}`);
  if (resolved["BorrowerOperations.musd"]) console.log(`  MUSD token per BorrowerOperations: ${resolved["BorrowerOperations.musd"]}`);
  if (resolved["PriceFeed.lastGoodPrice"]) {
    const p = resolved["PriceFeed.lastGoodPrice"] as bigint;
    console.log(`  BTC price (PriceFeed, 18dp): $${(Number(p) / 1e18).toFixed(2)}`);
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
