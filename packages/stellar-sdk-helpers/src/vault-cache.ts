import { withRaceTimeout } from "@meridian/shared";
import type { ApiVault } from "./vaults";

const CACHE_TTL_SECONDS = 60; // 60 seconds TTL
const CACHE_KEY_PREFIX = "vault-cache";

// Matches keeper-state.ts's store timeout: both sit on a path that has to fit
// inside a single invocation, so a hung Upstash request must not stall it.
const DEFAULT_UPSTASH_TIMEOUT_MS = 5_000;

interface UpstashCredentials {
  url: string;
  token: string;
}

/**
 * Reads the Upstash credentials at call time rather than at module load.
 *
 * The client used to be built eagerly as `new Redis({ url: "", token: "" })`,
 * which pointed it at an empty URL whenever the pair was unset: every read and
 * write then fired a request that could only fail, instead of being skipped.
 * Testing the pair per call also covers a process that has them injected after
 * import, and lets `vaults.ts` fall back to its in-memory layer when the shared
 * cache is genuinely unavailable — the behaviour `.env.example` documents.
 */
function upstashCredentials(
  env: Record<string, string | undefined> = process.env
): UpstashCredentials | null {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * Issues one Redis command over Upstash's HTTP REST API.
 *
 * Spoken over plain `fetch` rather than `@upstash/redis` on purpose, matching
 * keeper-state.ts: this package is the shared Stellar helper library, imported
 * by the web build as well as the API, and the two commands below don't justify
 * pulling a client dependency into it. Upstash was only resolvable here at all
 * because pnpm hoists it out of `api`, which declares it — this package never
 * did.
 */
async function command(
  credentials: UpstashCredentials,
  args: (string | number)[]
): Promise<unknown> {
  const response = await withRaceTimeout(
    () =>
      fetch(credentials.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
        // Belt and braces with the race below: this also frees the socket
        // rather than leaving a hung request running past the call.
        signal: AbortSignal.timeout(DEFAULT_UPSTASH_TIMEOUT_MS),
      }),
    DEFAULT_UPSTASH_TIMEOUT_MS,
    "Upstash Redis"
  );
  if (!response.ok) {
    // Deliberately status-only: the response body can echo the command, and
    // the URL and token never appear in the message at all.
    throw new Error(
      `Upstash Redis request failed with HTTP ${response.status}`
    );
  }
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`Upstash Redis error: ${body.error}`);
  return body.result ?? null;
}

export async function getCachedVaults(
  network: string
): Promise<ApiVault[] | null> {
  const credentials = upstashCredentials();
  if (!credentials) return null;
  try {
    const result = await command(credentials, [
      "GET",
      `${CACHE_KEY_PREFIX}:${network}`,
    ]);
    if (typeof result !== "string") return null;
    // Exactly one decode, matching the one encode below. The old pair
    // JSON.stringify'd on the way in and JSON.parse'd again on the way out
    // against a client that had already deserialised the reply, so a hit came
    // back as a string (or threw) rather than a vault list.
    const parsed = JSON.parse(result) as unknown;
    return Array.isArray(parsed) ? (parsed as ApiVault[]) : null;
  } catch (error) {
    console.error("[vault-cache] read failed:", error);
    return null;
  }
}

export async function setCachedVaults(
  network: string,
  vaults: ApiVault[]
): Promise<void> {
  const credentials = upstashCredentials();
  if (!credentials) return;
  try {
    await command(credentials, [
      "SET",
      `${CACHE_KEY_PREFIX}:${network}`,
      JSON.stringify(vaults),
      // Redis-side expiry, so an entry can't outlive CACHE_TTL_SECONDS even if
      // a later write fails.
      "EX",
      CACHE_TTL_SECONDS,
    ]);
  } catch (error) {
    console.error("[vault-cache] write failed:", error);
  }
}
