import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";
import { logTiming, nowMs } from "./debugTiming.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;

// Cache clients per configuration
const clientCache = new Map<string, Deno.HttpClient>();

function getOrCreateClient(
    proxyAddress?: string,
    ipv6Block?: string,
): Deno.HttpClient | undefined {
    if (!proxyAddress && !ipv6Block) return undefined;

    // Create a cache key from config
    const cacheKey = `${proxyAddress}|${ipv6Block}`;

    if (clientCache.has(cacheKey)) {
        return clientCache.get(cacheKey)!;
    }

    const clientOptions: Deno.CreateHttpClientOptions = {};

    if (proxyAddress) {
        clientOptions.proxy = { url: proxyAddress };
    }

    // Note: IPv6 rotation per-request is tricky with pooling
    // Consider if you really need this with a proxy
    if (ipv6Block) {
        clientOptions.localAddress = generateRandomIPv6(ipv6Block);
    }

    const client = Deno.createHttpClient(clientOptions);
    clientCache.set(cacheKey, client);
    return client;
}

export const getFetchClient = (config: Config): {
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
    ) => {
        const startMs = nowMs();
        const client = getOrCreateClient(proxyAddress, ipv6Block);
        const method = init?.method ?? "GET";
        const url = input instanceof Request ? input.url : String(input);

        try {
            const fetchRes = await fetchShim(config, input, {
                ...init,
                client,
            });
            logTiming("fetch", startMs, {
                method,
                url,
                status: fetchRes.status,
            });
            return new Response(fetchRes.body, {
                status: fetchRes.status,
                headers: fetchRes.headers,
            });
        } catch (error) {
            logTiming("fetch failed", startMs, {
                method,
                url,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
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
    const fetchInitialDebounce = config.networking.fetch?.retry
        ?.initial_debounce;
    const fetchDebounceMultiplier = config.networking.fetch?.retry
        ?.debounce_multiplier;

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
                : undefined, // Use undefined instead of null
            ...(init || {}),
        });

    return fetchRetry ? retry(callFetch, retryOptions) : callFetch();
}

export const closeHttpClients = () => {
    for (const client of clientCache.values()) {
        client.close();
    }
    clientCache.clear();
};
