/**
 * On-chain discovery of protocol addresses that the canonical reference does
 * not publish (Router, Voter, VotingEscrow, …).
 *
 * Strategy: start from the two addresses we DO trust (PoolFactory from the
 * contracts reference, and a canonical pool) and follow accessor functions a
 * Velodrome/Aerodrome-style deployment exposes. Anything found this way is
 * derived from on-chain state rather than guessed, and is still only a
 * candidate until verifyaddrs.ts confirms its own interface.
 */
import "./_testenv.js";
import { type Address, encodeFunctionData, decodeAbiParameters } from "viem";
import { publicClient } from "../src/chain/client.js";
import { registry } from "../src/registry/registry.js";

const client = publicClient();

const POOL_FACTORY = "0x83FE469C636C4081b87bA5b3Ae9991c6Ed104248" as Address;

/** Zero-arg accessors that commonly return linked protocol addresses. */
const ADDR_ACCESSORS = [
  "voter", "router", "factory", "defaultFactory", "poolFactory", "factoryRegistry",
  "votingEscrow", "ve", "escrow", "minter", "rewardsDistributor", "gaugeFactory",
  "votingRewardsFactory", "managedRewardsFactory", "owner", "feeManager",
  "pauser", "emergencyCouncil", "team", "token", "token0", "token1",
];

async function readAddr(to: Address, fn: string): Promise<string | undefined> {
  try {
    const data = encodeFunctionData({
      abi: [{ type: "function", name: fn, inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
      functionName: fn,
    });
    const res = await client.call({ to, data });
    if (!res.data || res.data === "0x") return undefined;
    const a = decodeAbiParameters([{ type: "address" }], res.data)[0] as string;
    return a === "0x0000000000000000000000000000000000000000" ? undefined : a;
  } catch {
    return undefined;
  }
}

async function sweep(label: string, addr: Address) {
  console.log(`\n${label}  ${addr}`);
  const code = await client.getCode({ address: addr });
  if (!code || code === "0x") { console.log("  (no code)"); return {}; }
  const found: Record<string, string> = {};
  for (const fn of ADDR_ACCESSORS) {
    const v = await readAddr(addr, fn);
    if (v) { found[fn] = v; console.log(`  ${fn}() = ${v}`); }
  }
  if (Object.keys(found).length === 0) console.log("  (no accessor responded)");
  return found;
}

async function main() {
  console.log(`network=${process.env.MEZO_NETWORK}`);
  const fromFactory = await sweep("PoolFactory", POOL_FACTORY);

  const pool = registry.pools()[0];
  if (pool) await sweep(`Pool ${pool.pair.join("/")}`, pool.address as Address);

  // Follow anything the factory pointed at — a Voter reveals ve/minter/etc.
  for (const [fn, addr] of Object.entries(fromFactory)) {
    if (["voter", "votingEscrow", "ve", "minter", "router"].includes(fn)) {
      await sweep(`↳ ${fn}`, addr as Address);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
