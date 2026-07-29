/**
 * On-chain verification of the DEX Router + ve(3,3) suite before wiring.
 * Source: docs/developers/features/mezo-pools.md in mezo-org/documentation.
 *
 * Same doctrine as verifyaddrs.ts (Borrow): a documented address is a
 * candidate, not a fact. Each must (1) have code, (2) answer its own
 * interface, (3) cross-reference the others — Voter.ve() == VeBTC,
 * RewardsDistributor.ve() == VeBTC, VeBTC.voter() == Voter, and the escrow's
 * locked token must be the BTC ERC-20 precompile. That linkage is what proves
 * "the real deployed system" vs. "some contract at a documented address".
 *
 *   MEZO_NETWORK=mainnet npx tsx scripts/verifyve.ts
 *   MEZO_NETWORK=testnet npx tsx scripts/verifyve.ts
 */
import "./_testenv.js";
import { type Address, encodeFunctionData, decodeAbiParameters } from "viem";
import { publicClient } from "../src/chain/client.js";
import { WRAPPED_NATIVE_ADDRESS } from "../src/registry/addresses.js";

const client = publicClient();

const CANDIDATES: Record<string, Record<string, Address>> = {
  mainnet: {
    Router: "0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706",
    PoolFactory: "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248",
    VeBTC: "0x7D807e9CE1ef73048FEe9A4214e75e894ea25914",
    Voter: "0x3A4a6919F70e5b0aA32401747C471eCfe2322C1b",
    RewardsDistributor: "0x535E01F948458E0b64F9dB2A01Da6F32E240140f",
  },
  testnet: {
    Router: "0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9",
    PoolFactory: "0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A",
    VeBTC: "0xB63fcCd03521Cf21907627bd7fA465C129479231",
    Voter: "0x72F8dd7F44fFa19E45955aa20A5486E8EB255738",
    RewardsDistributor: "0x10B0E7b3411F4A38ca2F6BB697aA28D607924729",
  },
};

const TESTNET_POOLS: Record<string, Address> = {
  "MUSD/BTC": "0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9",
  "MUSD/mUSDC": "0x525F049A4494dA0a6c87E3C4df55f9929765Dc3e",
  "MUSD/mUSDT": "0x27414B76CF00E24ed087adb56E26bAeEEe93494e",
};

async function read(to: Address, fn: string, type: "address" | "uint256" | "string", args?: { type: string; value: unknown }[]) {
  try {
    const data = encodeFunctionData({
      abi: [{ type: "function", name: fn, inputs: (args ?? []).map((a, i) => ({ name: `a${i}`, type: a.type })), outputs: [{ type }], stateMutability: "view" }],
      functionName: fn,
      args: (args ?? []).map((a) => a.value) as never,
    });
    const res = await client.call({ to, data });
    if (!res.data || res.data === "0x") return undefined;
    return decodeAbiParameters([{ type }], res.data)[0] as string | bigint;
  } catch { return undefined; }
}

const eq = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

async function main() {
  const netName = process.env.MEZO_NETWORK ?? "testnet";
  const C = CANDIDATES[netName]!;
  console.log(`\nVerifying ve(3,3) + Router on ${netName}\n`);
  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean) => { console.log(`  ${ok ? "✅" : "❌"} ${label}`); ok ? pass++ : fail++; };

  for (const [name, addr] of Object.entries(C)) {
    const code = await client.getCode({ address: addr });
    check(`${name} has code (${addr})`, !!code && code !== "0x");
  }

  // Router — Velodrome-style: factory()/defaultFactory() must point at PoolFactory.
  const rFactory = (await read(C.Router!, "defaultFactory", "address")) ?? (await read(C.Router!, "factory", "address"));
  check(`Router.factory == PoolFactory (${rFactory ?? "no answer"})`, eq(rFactory, C.PoolFactory!));

  // VeBTC escrow — token() must be the BTC ERC-20 precompile; voter() must be Voter.
  const veToken = await read(C.VeBTC!, "token", "address");
  check(`VeBTC.token == BTC precompile (${veToken ?? "no answer"})`, eq(veToken, WRAPPED_NATIVE_ADDRESS));
  const veVoter = await read(C.VeBTC!, "voter", "address");
  check(`VeBTC.voter == Voter (${veVoter ?? "no answer"})`, eq(veVoter, C.Voter!));

  // Voter — ve() must be the escrow; it must know gauges.
  const voterVe = await read(C.Voter!, "ve", "address");
  check(`Voter.ve == VeBTC (${voterVe ?? "no answer"})`, eq(voterVe, C.VeBTC!));
  const gaugeCount = await read(C.Voter!, "length", "uint256");
  check(`Voter.length() answers (gauges: ${gaugeCount ?? "?"})`, gaugeCount !== undefined);

  // RewardsDistributor — ve() must be the escrow.
  const rdVe = await read(C.RewardsDistributor!, "ve", "address");
  check(`RewardsDistributor.ve == VeBTC (${rdVe ?? "no answer"})`, eq(rdVe, C.VeBTC!));

  // Testnet pools: factory() must match the testnet PoolFactory and quote.
  if (netName === "testnet") {
    for (const [pair, addr] of Object.entries(TESTNET_POOLS)) {
      const f = await read(addr, "factory", "address");
      check(`pool ${pair} factory == PoolFactory (${addr})`, eq(f, C.PoolFactory!));
    }
  }

  // A gauge lookup through the Voter for a real pool proves stake-LP wiring.
  const pool = netName === "testnet" ? TESTNET_POOLS["MUSD/mUSDC"]! : ("0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356" as Address);
  const gauge = await read(C.Voter!, "gauges", "address", [{ type: "address", value: pool }]);
  check(`Voter.gauges(MUSD/mUSDC pool) → ${gauge ?? "none"}`, typeof gauge === "string" && gauge !== "0x0000000000000000000000000000000000000000");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
