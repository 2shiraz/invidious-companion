import { retry, type RetryOptions } from "@std/async";
import type { Config } from "./config.ts";
import { generateRandomIPv6 } from "./ipv6Rotation.ts";

type FetchInputParameter = Parameters<typeof fetch>[0];
type FetchInitParameterWithClient =
    | RequestInit
    | RequestInit & { client: Deno.HttpClient };
type FetchReturn = ReturnType<typeof fetch>;
type FetchClientOptions = {
    proxySessionId?: string;
};

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

function getStickyProxyAddress(
    proxyAddress: string | null,
    proxySessionId?: string,
): string | undefined {
    if (!proxyAddress) return undefined;
    if (!proxySessionId) return proxyAddress;

    const proxyUrl = new URL(proxyAddress);
    if (!proxyUrl.username) return proxyAddress;

    proxyUrl.username = `${proxySessionId}__${proxyUrl.username}`;
    //console.log(`[INFO] Using sticky proxy username: ${proxyUrl.username}`);
    //proxyUrl.username = `${proxyUrl.username}`;
    return proxyUrl.toString();
}

export const getFetchClient = (
    config: Config,
    options: FetchClientOptions = {},
): {
    (
        input: FetchInputParameter,
        init?: FetchInitParameterWithClient,
    ): FetchReturn;
} => {
    const proxyAddress = getStickyProxyAddress(
        config.networking.proxy,
        options.proxySessionId,
    );
    const ipv6Block = config.networking.ipv6_block ?? undefined;

    return async (
        input: FetchInputParameter,
        init?: RequestInit,
    ) => {
        const client = getOrCreateClient(proxyAddress, ipv6Block);
        const fetchRes = await fetchShim(config, input, {
            ...init,
            client,
        });
        return new Response(fetchRes.body, {
            status: fetchRes.status,
            headers: fetchRes.headers,
        });
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

// Cleanup function - call on application shutdown
export const closeHttpClients = () => {
    for (const client of clientCache.values()) {
        client.close();
    }
    clientCache.clear();
};
