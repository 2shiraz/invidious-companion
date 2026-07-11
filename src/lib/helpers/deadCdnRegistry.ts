// TODO: move to config/env once this is battle-tested
const SENTINEL_URL = "http://37.27.193.45:8090";
const SENTINEL_API_KEY = "";

const REPORT_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

function extractHostname(input: string | URL | Request): string | null {
    try {
        const url = input instanceof Request ? input.url : input;
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

// ---- local cache, kept live by a persistent SSE subscription (see bottom of file) ----

const deadHosts = new Map<string, number>(); // hostname -> expiresAt (epoch ms)

export function isDead(hostname: string): boolean {
    const expiresAt = deadHosts.get(hostname);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
        deadHosts.delete(hostname);
        return false;
    }
    return true;
}

// convenience for callers holding a full URL/base-url string rather than a bare hostname
export function isDeadCdnHostname(urlLike: string): boolean {
    const hostname = extractHostname(urlLike);
    return !!hostname && isDead(hostname);
}

type SsePayload = { hostname: string; expiresAt: number };

function handleSseEvent(raw: string): void {
    let event = "message", data = "";
    for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) return;

    let payload: SsePayload | SsePayload[];
    try {
        payload = JSON.parse(data);
    } catch {
        return;
    }

    switch (event) {
        case "snapshot":
            deadHosts.clear();
            for (const { hostname, expiresAt } of payload as SsePayload[]) {
                deadHosts.set(hostname, expiresAt);
            }
            break;
        case "dead":
        case "renewed": {
            const { hostname, expiresAt } = payload as SsePayload;
            deadHosts.set(hostname, expiresAt);
            break;
        }
        case "expired":
            deadHosts.delete((payload as SsePayload).hostname);
            break;
    }
}

async function streamEvents(): Promise<void> {
    const headers: Record<string, string> = {};
    if (SENTINEL_API_KEY) headers["x-api-key"] = SENTINEL_API_KEY;

    const res = await fetch(`${SENTINEL_URL}/dead-cdn/events`, { headers });
    if (!res.ok || !res.body) {
        throw new Error(`sentinel connect failed: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
            handleSseEvent(buffer.slice(0, sepIndex));
            buffer = buffer.slice(sepIndex + 2);
        }
    }

    throw new Error("sentinel stream closed");
}

async function connectLoop(): Promise<void> {
    let reconnectDelay = RECONNECT_MIN_MS;
    while (true) {
        try {
            await streamEvents();
            reconnectDelay = RECONNECT_MIN_MS;
        } catch {
            // connection failed or dropped, fall through to backoff + retry
        }
        await new Promise((r) => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
}

// starts once, the first time this module is imported anywhere in the process
connectLoop();

// a CDN is considered dead if:
// - the request genuinely times out (no response within the configured fetch timeout), or
// - the proxy tried and failed to open a CONNECT tunnel to the target host itself
//   ("unsuccessful tunnel") — this means the proxy actually attempted to reach that
//   specific googlevideo node and couldn't, which is a real signal about that node
//
// this deliberately excludes proxy-credential failures ("proxy authentication required"
// and similar) that fail before the proxy even attempts to reach the target — those
// reflect the proxy's health, not the CDN node's
export function isDeadCdnError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === "TimeoutError") return true;
    if (
        err instanceof TypeError &&
        typeof err.message === "string" &&
        err.message.includes("unsuccessful tunnel")
    ) {
        return true;
    }
    return false;
}

// only specific edge nodes (r1---sn-xxx, r5---sn-xxx, etc.) are reportable —
// redirector.googlevideo.com itself is YouTube's assignment service, not a CDN
// node, and nothing ever checks it against the dead list
const EDGE_NODE_HOSTNAME_RE = /^r+\d*---/;

function isEdgeNodeHostname(hostname: string): boolean {
    if (!hostname.endsWith(".googlevideo.com")) return false;
    return EDGE_NODE_HOSTNAME_RE.test(hostname.split(".")[0]);
}

export function reportDeadCdnIfTimeout(
    input: string | URL | Request,
    err: unknown,
): void {
    if (!isDeadCdnError(err)) return;

    const hostname = extractHostname(input);
    if (!hostname || !isEdgeNodeHostname(hostname)) return;

    const headers: Record<string, string> = {
        "content-type": "application/json",
    };
    if (SENTINEL_API_KEY) headers["x-api-key"] = SENTINEL_API_KEY;

    fetch(`${SENTINEL_URL}/dead-cdn`, {
        method: "POST",
        headers,
        body: JSON.stringify({ hostname }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    }).catch(() => {});
}
