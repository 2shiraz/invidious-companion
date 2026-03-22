const DEBUG_TIMINGS = Deno.env.get("DEBUG_TIMINGS") !== "false";
const DEBUG_TIMINGS_SLOW_MS = Number(
    Deno.env.get("DEBUG_TIMINGS_SLOW_MS") ?? "0",
);

function shouldLog(durationMs: number) {
    return DEBUG_TIMINGS && durationMs >= DEBUG_TIMINGS_SLOW_MS;
}

export function nowMs() {
    return performance.now();
}

export function logTiming(
    label: string,
    startMs: number,
    details?: Record<string, unknown>,
) {
    const durationMs = Math.round(performance.now() - startMs);
    if (!shouldLog(durationMs)) {
        return durationMs;
    }

    if (details) {
        console.log(`[DEBUG][timing] ${label} ${durationMs}ms`, details);
    } else {
        console.log(`[DEBUG][timing] ${label} ${durationMs}ms`);
    }

    return durationMs;
}

export async function withTiming<T>(
    label: string,
    fn: () => Promise<T>,
    details?: Record<string, unknown>,
): Promise<T> {
    const startMs = nowMs();
    try {
        return await fn();
    } finally {
        logTiming(label, startMs, details);
    }
}
