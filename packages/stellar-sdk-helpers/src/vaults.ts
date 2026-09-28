import { PoolV2 } from "@blend-capital/blend-sdk";
import {
  getStellarStablecoinPools,
  assessPoolRisk,
  type RiskLevel,
} from "./defilamma";
import { KNOWN_POOLS } from "./known-pools";
import { APP_NETWORK, withRaceTimeout } from "@meridian/shared";
import { simulateView } from "./tx";
import { getRpcServer, toBigInt } from "./internal";
import { getCachedVaults, setCachedVaults } from "./vault-cache";

export interface ApiVault {
  id: string;
  protocol: "blend" | "defindex" | "meridian";
  asset: string;
  name: string;
  label: string;
  apy: number;
  tvl: number;
  userBalance: number;
  riskLevel: RiskLevel;
}

// Matches CACHE_TTL_SECONDS in ./vault-cache, which is the persistence side of
// the same window.
const VAULT_CACHE_TTL_MS = 60_000;

interface VaultCacheEntry {
  vaults: ApiVault[];
  fetchedAt: number;
}

/**
 * Per-process cache of the last successful DeFiLlama read, kept alongside the
 * shared Upstash entry rather than instead of it.
 *
 * The shared cache is the cross-instance source of truth, but it is optional:
 * `vault-cache.ts` disables itself when UPSTASH_REDIS_REST_URL/TOKEN aren't
 * set, and `.env.example` documents an in-memory fallback for exactly that
 * case. Without this layer an unconfigured or unreachable Upstash meant every
 * caller hit DeFiLlama on every request, and — because the "no usable pools"
 * path returned an empty list — a transient DeFiLlama blip was reported to
 * users as "there are no vaults" even though a perfectly good result had been
 * fetched seconds earlier. This entry is what makes that blip degrade to
 * slightly stale data instead.
 */
const memoryCache = new Map<string, VaultCacheEntry>();

/** Clears the in-memory vault cache. Exposed for tests only. */
export function clearVaultCache(): void {
  memoryCache.clear();
}

/** Returns true if a valid cached result exists and will be returned by fetchAllVaults. */
export function isVaultCacheWarm(
  network: "mainnet" | "testnet" = APP_NETWORK.network
): boolean {
  const entry = memoryCache.get(network);
  return (
    entry !== undefined && Date.now() - entry.fetchedAt < VAULT_CACHE_TTL_MS
  );
}

/**
 * Reads the live supply APY for the Blend pool at `poolId`, matching the
 * reserve for `assetId`. Returns 0 if the pool has no such reserve.
 */
async function fetchBlendApy(
  network: { rpc: string; passphrase: string },
  poolId: string,
  assetId: string
): Promise<number> {
  const pool = await withRaceTimeout(
    () => PoolV2.load(network, poolId),
    10_000,
    "Blend RPC"
  );
  const reserve = pool.reserves.get(assetId);
  return reserve ? Number((reserve.estSupplyApy * 100).toFixed(2)) : 0;
}

/**
 * Discovers the live APY for a Meridian coordinator vault by reading its
 * active adapter's underlying protocol on-chain (get_adapter -> get_pool /
 * get_protocol) rather than tracking it in config. This makes rate discovery
 * self-updating if the adapter is ever swapped via `set_adapter`: there is no
 * config entry that could drift out of sync with the actual deployment.
 *
 * DeFindex has no live-rate SDK integration wired up yet, so vaults backed by
 * a DefindexAdapter report apy: 0 until that is added. Any adapter protocol
 * this function doesn't recognise also reports apy: 0 rather than throwing,
 * so a future protocol degrades gracefully (TVL is unaffected) until its
 * rate-fetching branch is added here.
 */
async function fetchMeridianApy(
  server: ReturnType<typeof getRpcServer>,
  network: { rpc: string; passphrase: string },
  vaultId: string,
  assetId: string
): Promise<number> {
  const adapterId = (await simulateView(
    server,
    vaultId,
    network.passphrase,
    "get_adapter"
  )) as string;

  const [poolId, protocol] = (await Promise.all([
    simulateView(server, adapterId, network.passphrase, "get_pool"),
    simulateView(server, adapterId, network.passphrase, "get_protocol"),
  ])) as [string, string];

  if (protocol === "blend") {
    return fetchBlendApy(network, poolId, assetId);
  }

  return 0;
}

/**
 * Query each pool in KNOWN_POOLS.testnet on-chain and return its TVL and APY.
 * Blend pools use PoolV2.load directly; Meridian coordinator vaults read
 * get_total_assets for TVL and discover their active adapter's protocol
 * on-chain for APY (see fetchMeridianApy). Adding a new testnet pool only
 * requires a new entry in KNOWN_POOLS.testnet.
 */
async function fetchTestnetVaults(): Promise<ApiVault[]> {
  const network = {
    rpc: APP_NETWORK.rpcUrl,
    passphrase: APP_NETWORK.passphrase,
  };
  const vaults: ApiVault[] = [];

  for (const meta of Object.values(KNOWN_POOLS.testnet)) {
    if (meta.protocol === "blend") {
      const pool = await withRaceTimeout(
        () => PoolV2.load(network, meta.contractId),
        10_000,
        "Blend RPC"
      );
      const reserve = pool.reserves.get(meta.assetId);
      const tvl = reserve ? Math.round(Number(reserve.totalSupply()) / 1e7) : 0;
      const apy = reserve ? Number((reserve.estSupplyApy * 100).toFixed(2)) : 0;
      vaults.push({ ...meta, apy, tvl, userBalance: 0, riskLevel: "safe" });
    } else if (meta.protocol === "meridian") {
      const server = getRpcServer(network.rpc, 10_000);
      const [totalAssetsRaw, apy] = await Promise.all([
        withRaceTimeout(
          () =>
            simulateView(
              server,
              meta.contractId,
              network.passphrase,
              "get_total_assets"
            ),
          10_000,
          "Meridian RPC"
        ),
        withRaceTimeout(
          () =>
            fetchMeridianApy(server, network, meta.contractId, meta.assetId),
          10_000,
          "Meridian adapter RPC"
        ),
      ]);
      const tvl = Math.round(Number(toBigInt(totalAssetsRaw)) / 1e7);
      vaults.push({ ...meta, apy, tvl, userBalance: 0, riskLevel: "safe" });
    }
  }

  return vaults;
}

/**
 * Fetch vaults for the given network. On mainnet, pulls live APY/TVL from
 * DeFiLlama and matches against KNOWN_POOLS.mainnet. On testnet, queries the
 * Blend TestnetV2 pool on-chain directly (DeFiLlama does not index testnet).
 * Mainnet results are cached for 60 s; testnet results are always fresh.
 */
export async function fetchAllVaults(
  network: "mainnet" | "testnet" = APP_NETWORK.network
): Promise<ApiVault[]> {
  if (network === "testnet") return fetchTestnetVaults();

  // Serve a fresh in-process entry without paying for a cache round-trip.
  const now = Date.now();
  const local = memoryCache.get(network);
  if (local && now - local.fetchedAt < VAULT_CACHE_TTL_MS) {
    return local.vaults;
  }

  // Check shared Upstash cache before spending a DeFiLlama request. An empty
  // list is treated as a miss: it is what callers used to get back from the
  // blip path, and caching it would pin that empty result for the whole TTL.
  const cached = await getCachedVaults(network);
  if (cached && cached.length > 0) {
    memoryCache.set(network, { vaults: cached, fetchedAt: now });
    return cached;
  }

  const pools = await getStellarStablecoinPools();

  const vaults: ApiVault[] = [];
  for (const pool of pools) {
    const meta = KNOWN_POOLS.mainnet[pool.pool];
    if (!meta) {
      console.warn(
        "[vaults] unknown DeFiLlama pool, skipping:",
        pool.pool,
        pool.project,
        pool.symbol
      );
      continue;
    }
    vaults.push({
      ...meta,
      asset: pool.symbol,
      apy: Number(pool.apy.toFixed(2)),
      tvl: Math.round(pool.tvlUsd),
      userBalance: 0,
      riskLevel: assessPoolRisk(pool),
    });
  }

  // Cache the result if we have data
  if (vaults.length > 0) {
    memoryCache.set(network, { vaults, fetchedAt: Date.now() });
    try {
      await setCachedVaults(network, vaults);
    } catch (e) {
      console.error("[vaults] Failed to set cache:", e);
    }
    return vaults;
  }

  // DeFiLlama returned no usable pools — likely a transient blip. Serve the
  // last good result rather than an empty list, and deliberately leave its
  // timestamp alone so the next caller still retries DeFiLlama.
  if (local) return local.vaults;

  // Nothing cached to fall back on: this is the honest empty answer.
  return [];
}
