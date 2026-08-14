import { Hono } from "hono";
import { companionRoutes, miscRoutes } from "./routes/index.ts";
import { Innertube, Platform, UniversalCache } from "youtubei.js";
import { poTokenGenerate, type TokenMinter } from "./lib/jobs/potoken.ts";
import { USER_AGENT } from "bgutils";
import type { HonoVariables } from "./lib/types/HonoVariables.ts";
import { parseArgs } from "@std/cli/parse-args";
import { existsSync } from "@std/fs/exists";

import { parseConfig } from "./lib/helpers/config.ts";
const config = await parseConfig();
import { Metrics } from "./lib/helpers/metrics.ts";
import { PLAYER_ID } from "./constants.ts";
import { jsInterpreter } from "./lib/helpers/jsInterpreter.ts";

const args = parseArgs(Deno.args);

if (args._version_date && args._version_commit) {
    console.log(
        `[INFO] Using Invidious companion version ${args._version_date}-${args._version_commit}`,
    );
}

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

declare module "hono" {
    interface ContextVariableMap extends HonoVariables {}
}

const app = new Hono({
    getPath: (req) => new URL(req.url).pathname,
});
const companionApp = new Hono({
    getPath: (req) => new URL(req.url).pathname,
}).basePath(config.server.base_path);
const metrics = config.server.enable_metrics ? new Metrics() : undefined;
const INNERTUBE_REFRESH_INTERVAL_MS = 3_000;

let tokenMinter: TokenMinter | undefined;
let innertubeClient: Innertube;
let innertubeClientFetchPlayer = true;
const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;
const innertubeClientJobPoTokenEnabled =
    config.jobs.youtube_session.po_token_enabled;
const innertubeClientCookies = config.youtube_session.cookies;
let refreshInFlight: Promise<void> | undefined;
let tokenMinterReadyResolved = false;

// Promise that resolves when tokenMinter initialization is complete (for tests)
let tokenMinterReadyResolve: (() => void) | undefined;
export const tokenMinterReady = new Promise<void>((resolve) => {
    tokenMinterReadyResolve = resolve;
});

function resolveTokenMinterReady() {
    if (!tokenMinterReadyResolved) {
        tokenMinterReadyResolved = true;
        tokenMinterReadyResolve?.();
        tokenMinterReadyResolve = undefined;
    }
}

if (!innertubeClientOauthEnabled) {
    if (innertubeClientJobPoTokenEnabled) {
        console.log("[INFO] job po_token is active.");
        // Don't fetch fetch player yet for po_token
        innertubeClientFetchPlayer = false;
    } else if (!innertubeClientJobPoTokenEnabled) {
        console.log("[INFO] job po_token is NOT active.");
    }
}

Platform.shim.eval = jsInterpreter;
console.log("[INFO] CREATING INNERTUBE CLIENT.");

async function createInnertubeClient(): Promise<Innertube> {
    return await Innertube.create({
        cache: new UniversalCache(true),
        enable_session_cache: false,
        retrieve_player: innertubeClientFetchPlayer,
        fetch: getFetchClient(config),
        cookie: innertubeClientCookies || undefined,
        user_agent: USER_AGENT,
        player_id: PLAYER_ID,
    });
}

function registerOauthEventHandlers(client: Innertube) {
    client.session.on("auth-pending", (data) => {
        console.log(
            `[INFO] [OAUTH] Go to ${data.verification_url} in your browser and enter code ${data.user_code} to authenticate.`,
        );
    });
    client.session.on("auth", () => {
        console.log("[INFO] [OAUTH] Sign in successful!");
    });
    client.session.on("update-credentials", async () => {
        console.log("[INFO] [OAUTH] Credentials updated.");
        await client.session.oauth.cacheCredentials();
    });
}

async function createAuthenticatedInnertubeClient(): Promise<Innertube> {
    const client = await createInnertubeClient();
    registerOauthEventHandlers(client);
    await client.session.signIn();
    await client.session.oauth.cacheCredentials();
    return client;
}

async function refreshSharedInnertubeClient(): Promise<void> {
    if (refreshInFlight) {
        return await refreshInFlight;
    }

    refreshInFlight = (async () => {
        try {
            if (innertubeClientOauthEnabled) {
                innertubeClient = await createAuthenticatedInnertubeClient();
                tokenMinter = undefined;
            } else if (innertubeClientJobPoTokenEnabled) {
                ({ innertubeClient, tokenMinter } = await poTokenGenerate(
                    config,
                    metrics,
                ));
            } else {
                innertubeClient = await createInnertubeClient();
                tokenMinter = undefined;
            }

            console.log("[INFO] Shared Innertube client refreshed.");
            resolveTokenMinterReady();
        } catch (err) {
            console.error("[ERROR] Failed to refresh shared Innertube client:", err);
            if (innertubeClientJobPoTokenEnabled) {
                metrics?.potokenGenerationFailure.inc();
            }
            resolveTokenMinterReady();
        } finally {
            refreshInFlight = undefined;
        }
    })();

    return await refreshInFlight;
}

function startInnertubeRefreshLoop(signal: AbortSignal) {
    console.log(
        `[INFO] Starting shared Innertube refresh loop every ${INNERTUBE_REFRESH_INTERVAL_MS}ms.`,
    );
    const intervalId = setInterval(() => {
        void refreshSharedInnertubeClient();
    }, INNERTUBE_REFRESH_INTERVAL_MS);

    signal.addEventListener(
        "abort",
        () => {
            clearInterval(intervalId);
        },
        { once: true },
    );
}

innertubeClient = await createInnertubeClient();

if (!innertubeClientOauthEnabled) {
    if (innertubeClientJobPoTokenEnabled) {
        console.log("[INFO] Starting PO token generation in background...");
        void refreshSharedInnertubeClient();
    } else {
        resolveTokenMinterReady();
    }
} else if (innertubeClientOauthEnabled) {
    registerOauthEventHandlers(innertubeClient);
    await innertubeClient.session.signIn();
    await innertubeClient.session.oauth.cacheCredentials();
    resolveTokenMinterReady();
}

companionApp.use("*", async (c, next) => {
    c.set("innertubeClient", innertubeClient);
    c.set("tokenMinter", tokenMinter);
    c.set("config", config);
    c.set("metrics", metrics);
    await next();
});
companionRoutes(companionApp, config);

app.use("*", async (c, next) => {
    c.set("metrics", metrics);
    await next();
});
miscRoutes(app, config);

app.route("/", companionApp);

// This cannot be changed since companion restricts the
// files it can access using deno `--allow-write` argument
const udsPath = config.server.unix_socket_path;

export function run(signal: AbortSignal, port: number, hostname: string) {
    startInnertubeRefreshLoop(signal);

    if (config.server.use_unix_socket) {
        try {
            if (existsSync(udsPath)) {
                // Delete the unix domain socket manually before starting the server
                Deno.removeSync(udsPath);
            }
        } catch (err) {
            console.log(
                `[ERROR] Failed to delete unix domain socket '${udsPath}' before starting the server:`,
                err,
            );
        }

        const srv = Deno.serve(
            {
                onListen() {
                    Deno.chmodSync(udsPath, 0o777);
                    console.log(
                        `[INFO] Server successfully started at ${udsPath} with permissions set to 777.`,
                    );
                },
                signal: signal,
                path: udsPath,
            },
            app.fetch,
        );

        return srv;
    } else {
        return Deno.serve(
            {
                onListen() {
                    console.log(
                        `[INFO] Server successfully started at http://${config.server.host}:${config.server.port}${config.server.base_path}`,
                    );
                },
                signal: signal,
                port: port,
                hostname: hostname,
            },
            app.fetch,
        );
    }
}
if (import.meta.main) {
    const controller = new AbortController();
    const { signal } = controller;
    run(signal, config.server.port, config.server.host);

    const shutdown = (signalName: string) => {
        console.log(`Caught ${signalName}, shutting down...`);
        controller.abort();
        Deno.exit(0);
    };

    if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
    }

    Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
    if (Deno.build.os === "windows") {
        Deno.addSignalListener("SIGBREAK", () => shutdown("SIGBREAK"));
    }
}
