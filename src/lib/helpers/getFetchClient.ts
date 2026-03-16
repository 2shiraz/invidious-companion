import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
  | RequestInit
  | (RequestInit & { client: Deno.HttpClient });
type FetchReturn = ReturnType<typeof fetch>;

// Cache only proxy-only clients.
// If ipv6Block is enabled, create a fresh client per request
// so a new random IPv6 is used every time.
const proxyClientCache = new Map<string, Deno.HttpClient>();

function getOrCreateClient(
  proxyAddress?: string,
  ipv6Block?: string,
): { client?: Deno.HttpClient; shouldClose: boolean } {
  if (!proxyAddress && !ipv6Block) {
    return { client: undefined, shouldClose: false };
  }

  const clientOptions: Deno.CreateHttpClientOptions = {};

  if (proxyAddress) {
    clientOptions.proxy = { url: proxyAddress };
  }

  // Fresh client per request when rotating IPv6
  if (ipv6Block) {
    clientOptions.localAddress = generateRandomIPv6(ipv6Block);
    return {
      client: Deno.createHttpClient(clientOptions),
      shouldClose: true,
    };
  }

  // Reuse cached proxy-only client
  const cacheKey = proxyAddress!;
  const cachedClient = proxyClientCache.get(cacheKey);
  if (cachedClient) {
    return { client: cachedClient, shouldClose: false };
  }

  const client = Deno.createHttpClient(clientOptions);
  proxyClientCache.set(cacheKey, client);

  return { client, shouldClose: false };
}

export const getFetchClient = (
  config: Config,
): {
  (
    input: FetchInputParameter,
    init?: FetchInitParameterWithClient,
  ): FetchReturn;
} => {
  const proxyAddress = config.networking.proxy;
  const ipv6Block = config.networking.ipv6_block;

  return async (
    input: FetchInputParameter,
    init?: RequestInit,
  ): Promise<Response> => {
    const { client, shouldClose } = getOrCreateClient(proxyAddress, ipv6Block);

    try {
      return await fetchShim(config, input, {
        ...init,
        ...(client ? { client } : {}),
      });
    } finally {
      if (shouldClose) {
        try {
          client?.close();
        } catch {
          // ignore close errors
        }
      }
    }
  };
};

function fetchShim(
  config: Config,
  input: FetchInputParameter,
  init?: FetchInitParameterWithClient,
): FetchReturn {
  const fetchTimeout = config.networking.fetch?.timeout_ms;
  const fetchRetry = config.networking.fetch?.retry?.enabled;
  const fetchMaxAttempts = config.networking.fetch?.retry?.times;
  const fetchInitialDebounce =
    config.networking.fetch?.retry?.initial_debounce;
  const fetchDebounceMultiplier =
    config.networking.fetch?.retry?.debounce_multiplier;

  const retryOptions: RetryOptions = {
    maxAttempts: fetchMaxAttempts,
    minTimeout: fetchInitialDebounce,
    multiplier: fetchDebounceMultiplier,
    jitter: 0,
  };

  const callFetch = () =>
    fetch(input, {
      signal: fetchTimeout
        ? AbortSignal.timeout(Number(fetchTimeout))
        : undefined,
      ...(init ?? {}),
    });

  return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}

// Cleanup function - call on application shutdown
export const closeHttpClients = () => {
  for (const client of proxyClientCache.values()) {
    try {
      client.close();
    } catch {
      // ignore already-closed client errors
    }
  }
  proxyClientCache.clear();
};