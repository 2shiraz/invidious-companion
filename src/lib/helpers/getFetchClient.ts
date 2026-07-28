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

type CachedClient = {
    client: Deno.HttpClient;
    activeRequests: number;
    lastUsedAt: number;
};

// Cache clients per effective network configuration. The cache is bounded
// because sticky proxy sessions create a distinct proxy URL per session id.
const clientCache = new Map<string, CachedClient>();

function closeClient(client: Deno.HttpClient) {
    try {
        client.close();
    } catch {
        // Ignore double-close races during shutdown/eviction.
    }
}

function evictIdleClients(config: Config, now = Date.now()) {
    const { max_size, idle_ttl_ms } = config.networking.http_client_cache;

    for (const [cacheKey, cached] of clientCache) {
        if (
            cached.activeRequests === 0 &&
            now - cached.lastUsedAt >= idle_ttl_ms
        ) {
            clientCache.delete(cacheKey);
            closeClient(cached.client);
        }
    }

    while (clientCache.size > max_size) {
        const idleEntry = Array.from(clientCache.entries()).find((
            [, cached],
        ) => cached.activeRequests === 0);

        if (!idleEntry) {
            break;
        }

        const [cacheKey, cached] = idleEntry;
        clientCache.delete(cacheKey);
        closeClient(cached.client);
    }
}

function getOrCreateClient(
    config: Config,
    proxyAddress?: string,
    ipv6Block?: string,
): CachedClient | undefined {
    if (!proxyAddress && !ipv6Block) return undefined;

    // Create a cache key from config
    const cacheKey = `${proxyAddress}|${ipv6Block}`;
    const now = Date.now();

    evictIdleClients(config, now);

    const cachedClient = clientCache.get(cacheKey);
    if (cachedClient) {
        cachedClient.activeRequests++;
        cachedClient.lastUsedAt = now;
        clientCache.delete(cacheKey);
        clientCache.set(cacheKey, cachedClient);
        return cachedClient;
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
    const cached = {
        client,
        activeRequests: 1,
        lastUsedAt: now,
    };

    clientCache.set(cacheKey, cached);
    evictIdleClients(config, now);

    return cached;
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
        const cached = getOrCreateClient(config, proxyAddress, ipv6Block);
        const client = cached?.client;

        try {
            const fetchRes = await fetchShim(config, input, {
                ...init,
                client,
            });

            return wrapResponse(fetchRes, () => {
                if (!cached) return;
                cached.activeRequests--;
                cached.lastUsedAt = Date.now();
                evictIdleClients(config);
            });
        } catch (err) {
            if (cached) {
                cached.activeRequests--;
                cached.lastUsedAt = Date.now();
                evictIdleClients(config);
            }
            throw err;
        }
    };
};

function wrapResponse(response: Response, release: () => void): Response {
    if (!response.body) {
        release();
        return response;
    }

    let released = false;
    const releaseOnce = () => {
        if (!released) {
            released = true;
            release();
        }
    };
    const reader = response.body.getReader();
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    releaseOnce();
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (err) {
                releaseOnce();
                controller.error(err);
            }
        },
        async cancel(reason) {
            try {
                await reader.cancel(reason);
            } finally {
                releaseOnce();
            }
        },
    });

    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}

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
    for (const cached of clientCache.values()) {
        closeClient(cached.client);
    }
    clientCache.clear();
};
