import { Platform, Types } from "youtubei.js";

// https://ytjs.dev/guide/getting-started.html#providing-a-custom-javascript-interpreter
//
// A player response has ~25 formats/adaptive_formats, and youtubei.js's
// Player.decipher() calls Platform.shim.eval() once per format. Before
// calling it, Player.decipher() (see YouTube.js's core/Player.ts) appends
// a generated trailer to data.output:
//
//   function process(n = "", sp = "", s = "") {
//     ... stable body, calls exportedVars.nsigFunction ...
//   }
//   return process("<n value>", "<sp value>", "<s value>");
//
// Only that last line varies between calls — the process() *definition*
// is identical every time for the same player. The original version
// below ran `new Function(data.output)()` fresh on every single call:
// since the trailing invocation line embeds the actual value as a string
// literal, the full source text differs per call, so V8 can never reuse
// a compiled function — it re-parses and re-JIT-compiles the entire
// extracted transform script from scratch, ~25 times per video, all
// synchronously on the one JS thread. That blocks everything else in the
// process for the duration — confirmed to be why this only affected
// web-family clients (iOS/Android skip decipher() entirely) and only
// within the busy process handling it (a separate idle process, even
// sharing the same IP, was unaffected).
//
// Fix: split off that last "return process(...)" line, compile
// everything before it exactly once per unique player script (cached
// below), and return the `process` function itself instead of its
// already-baked result. Every subsequent call for the same player is
// then a direct, cheap function call with n/sp/s as real arguments — the
// exact same process() logic youtubei.js generates, just not
// recompiled every time. Falls back to the original one-shot behavior
// if the expected shape isn't found (e.g. a future youtubei.js version
// changes this trailer), so this can never silently produce wrong
// results — it just stops being fast.

type ProcessFn = (
    n?: string,
    sp?: string,
    s?: string,
) => { sig?: string; n?: string };

const TRAILER_MARKER = "\n\nreturn process(";
const MAX_CACHED_SCRIPTS = 4;
const scriptCache = new Map<string, ProcessFn>();

function getCachedProcessFn(output: string): ProcessFn | undefined {
    const markerIndex = output.lastIndexOf(TRAILER_MARKER);
    if (markerIndex === -1) {
        // Doesn't match the expected youtubei.js getNsigProcessorFn shape —
        // don't guess, just let the caller fall back to the safe path.
        return undefined;
    }
    const stablePart = output.slice(0, markerIndex);

    const cached = scriptCache.get(stablePart);
    if (cached) {
        // Re-set to move this entry to the end (Map preserves insertion
        // order) so eviction below always drops the least-recently-used
        // script, not just the least-recently-inserted one.
        scriptCache.delete(stablePart);
        scriptCache.set(stablePart, cached);
        return cached;
    }

    const compiled = new Function(`${stablePart}\n\nreturn process;`)() as
        | ProcessFn
        | undefined;
    if (typeof compiled !== "function") {
        return undefined;
    }

    scriptCache.set(stablePart, compiled);
    while (scriptCache.size > MAX_CACHED_SCRIPTS) {
        const oldestKey = scriptCache.keys().next().value;
        if (oldestKey === undefined) break;
        scriptCache.delete(oldestKey);
    }

    return compiled;
}

function evalUncached(
    data: Types.BuildScriptResult,
    env: Record<string, Types.VMPrimative>,
) {
    const properties = [];
    if (env.n) {
        properties.push(`n: exportedVars.nFunction("${env.n}")`);
    }
    if (env.sig) {
        properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
    }
    const code = `${data.output}\nreturn { ${properties.join(", ")} }`;
    return new Function(code)();
}

// deno-lint-ignore require-await
export const jsInterpreter = Platform.shim.eval = async (
    data: Types.BuildScriptResult,
    env: Record<string, Types.VMPrimative>,
) => {
    const process = getCachedProcessFn(data.output);
    if (!process) {
        return evalUncached(data, env);
    }

    return process(
        env.n !== undefined ? String(env.n) : undefined,
        env.sp !== undefined ? String(env.sp) : undefined,
        env.sig !== undefined ? String(env.sig) : undefined,
    );
};
