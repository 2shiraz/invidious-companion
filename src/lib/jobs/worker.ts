/// <reference lib="webworker" />

import { z } from "zod";
import { Config, ConfigSchema } from "../helpers/config.ts";
import { BG, buildURL, GOOG_API_KEY, USER_AGENT } from "bgutils";
import type { WebPoSignalOutput } from "bgutils";
import { JSDOM } from "jsdom";
import { Innertube } from "youtubei.js";
import { PLAYER_ID } from "../../constants.ts";
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

type FetchFunction = typeof fetch;
const { getFetchClient }: {
    getFetchClient: (config: Config) => Promise<FetchFunction>;
} = await import(getFetchClientLocation);

// ---- Messages to send to the webworker ----
const InputInitialiseSchema = z.object({
    type: z.literal("initialise"),
    config: ConfigSchema,
}).strict();

const InputContentTokenSchema = z.object({
    type: z.literal("content-token-request"),
    videoId: z.string(),
    requestId: z.string().uuid(),
}).strict();
export type InputInitialise = z.infer<typeof InputInitialiseSchema>;
export type InputContentToken = z.infer<typeof InputContentTokenSchema>;
const InputMessageSchema = z.union([
    InputInitialiseSchema,
    InputContentTokenSchema,
]);
export type InputMessage = z.infer<typeof InputMessageSchema>;

// ---- Messages that the webworker sends to the parent ----
const OutputReadySchema = z.object({
    type: z.literal("ready"),
}).strict();

const OutputInitialiseSchema = z.object({
    type: z.literal("initialised"),
    sessionPoToken: z.string(),
    visitorData: z.string(),
}).strict();

const OutputContentTokenSchema = z.object({
    type: z.literal("content-token"),
    contentToken: z.string(),
    requestId: InputContentTokenSchema.shape.requestId,
}).strict();

const OutputErrorSchema = z.object({
    type: z.literal("error"),
    error: z.any(),
}).strict();
export const OutputMessageSchema = z.union([
    OutputReadySchema,
    OutputInitialiseSchema,
    OutputContentTokenSchema,
    OutputErrorSchema,
]);
type OutputMessage = z.infer<typeof OutputMessageSchema>;

const IntegrityTokenResponse = z.tuple([z.string()]).rest(z.unknown());

type InitialAttestationResponse = {
    bgChallenge?: {
        program: string;
        globalName: string;
        interpreterUrl: {
            privateDoNotAccessOrElseTrustedResourceUrlWrappedValue: string;
        };
    };
};

function parseLooseJSON(looseJson: string): Record<string, unknown> {
    const sanitizedString = looseJson.replace(
        /\\x([0-9A-Fa-f]{2})/g,
        (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)),
    );

    let jsonString = sanitizedString.replace(/,\s*([\]}])/g, "$1");
    jsonString = jsonString.replace(
        /'((?:[^'\\]|\\[\s\S])*)'/g,
        (_match, innerString: string) =>
            JSON.stringify(innerString.replace(/\\'/g, "'")),
    );
    jsonString = jsonString.replace(
        /([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g,
        '$1"$2":',
    );

    const parsedData = JSON.parse(jsonString) as Record<string, unknown>;
    for (const key in parsedData) {
        const value = parsedData[key];
        if (
            typeof value === "string" &&
            (value.trim().startsWith("{") || value.trim().startsWith("["))
        ) {
            try {
                parsedData[key] = JSON.parse(value);
            } catch {
                // The value is an ordinary string, not nested JSON.
            }
        }
    }

    return parsedData;
}

const isWorker = typeof WorkerGlobalScope !== "undefined" &&
    self instanceof WorkerGlobalScope;
if (isWorker) {
    // helper function to force type-checking
    const untypedPostmessage = self.postMessage.bind(self);
    const postMessage = (message: OutputMessage) => {
        untypedPostmessage(message);
    };

    let minter: BG.WebPoMinter;

    onmessage = async (event) => {
        const message = InputMessageSchema.parse(event.data);
        if (message.type === "initialise") {
            const fetchImpl: typeof fetch = await getFetchClient(
                message.config,
            );
            try {
                const {
                    sessionPoToken,
                    visitorData,
                    generatedMinter,
                } = await setup({
                    fetchImpl,
                    innertubeClientCookies:
                        message.config.youtube_session.cookies,
                });
                minter = generatedMinter;
                postMessage({
                    type: "initialised",
                    sessionPoToken,
                    visitorData,
                });
            } catch (err) {
                postMessage({ type: "error", error: err });
            }
        }
        // this is called every time a video needs a content token
        if (message.type === "content-token-request") {
            if (!minter) {
                throw new Error(
                    "Minter not yet ready, must initialise first",
                );
            }
            const contentToken = await minter.mintAsWebsafeString(
                message.videoId,
            );
            postMessage({
                type: "content-token",
                contentToken,
                requestId: message.requestId,
            });
        }
    };

    postMessage({ type: "ready" });
}

async function setup(
    { fetchImpl, innertubeClientCookies }: {
        fetchImpl: FetchFunction;
        innertubeClientCookies: string;
    },
) {
    const innertubeClient = await Innertube.create({
        enable_session_cache: false,
        fetch: fetchImpl,
        user_agent: USER_AGENT,
        retrieve_player: false,
        cookie: innertubeClientCookies || undefined,
        player_id: PLAYER_ID,
    });

    const visitorData = innertubeClient.session.context.client.visitorData;

    if (!visitorData) {
        throw new Error("Could not get visitor data");
    }

    const dom = new JSDOM(
        '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
        {
            url: "https://www.youtube.com/",
            referrer: "https://www.youtube.com/",
            userAgent: USER_AGENT,
        },
    );

    const pageResponse = await fetchImpl("https://www.youtube.com", {
        headers: {
            "accept": "*/*",
            "accept-language": "en-US,en;q=0.7",
            "user-agent": USER_AGENT,
        },
    });
    if (!pageResponse.ok) {
        throw new Error(
            `Could not load YouTube page: HTTP ${pageResponse.status}`,
        );
    }

    const pageHtml = await pageResponse.text();
    const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
    if (!ytConfig) {
        throw new Error("Could not find ytcfg in page HTML");
    }

    const yt = {
        // BotGuard reads EVENT_ID through this object.
        config_: JSON.parse(ytConfig),
    };
    Object.assign(dom.window, { yt });

    Object.assign(globalThis, {
        yt,
        window: dom.window,
        document: dom.window.document,
        // location: dom.window.location, // --- doesn't seem to be necessary and the Web Worker doesn't like it
        origin: dom.window.origin,
    });

    if (!Reflect.has(globalThis, "navigator")) {
        Object.defineProperty(globalThis, "navigator", {
            value: dom.window.navigator,
        });
    }

    const initialAttestationData = pageHtml.match(
        /window\.ytAtN\(\s*({[\s\S]*?})\s*\)/,
    );
    if (!initialAttestationData) {
        throw new Error("Could not find challenge in page HTML");
    }

    const initialAttestationDataJson = parseLooseJSON(
        initialAttestationData[1],
    );
    const challengeResponse = initialAttestationDataJson.R as
        | InitialAttestationResponse
        | undefined;
    if (!challengeResponse?.bgChallenge) {
        throw new Error("Could not get challenge");
    }

    const interpreterUrl = challengeResponse.bgChallenge.interpreterUrl
        .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    const bgScriptResponse = await fetchImpl(
        `https:${interpreterUrl}`,
    );
    const interpreterJavascript = await bgScriptResponse.text();

    if (interpreterJavascript) {
        new Function(interpreterJavascript)();
    } else throw new Error("Could not load VM");

    // Botguard currently surfaces a "Not implemented" error here, due to the environment
    // not having a valid Canvas API in JSDOM. At the time of writing, this doesn't cause
    // any issues as the Canvas check doesn't appear to be an enforced element of the checks
    console.log(
        '[INFO] the "Not implemented: HTMLCanvasElement.prototype.getContext" error is normal. Please do not open a bug report about it.',
    );
    const botguard = await BG.BotGuardClient.create({
        program: challengeResponse.bgChallenge.program,
        globalName: challengeResponse.bgChallenge.globalName,
        globalObj: globalThis,
    });

    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
    const requestKey = "O43z0dpjhgX20SCx4KAo";

    const integrityTokenResponse = await fetchImpl(
        buildURL("GenerateIT", true),
        {
            method: "POST",
            headers: {
                "content-type": "application/json+protobuf",
                "x-goog-api-key": GOOG_API_KEY,
                "x-user-agent": "grpc-web-javascript/0.1",
                "user-agent": USER_AGENT,
            },
            body: JSON.stringify([requestKey, botguardResponse]),
        },
    );
    const integrityTokenBody = IntegrityTokenResponse.parse(
        await integrityTokenResponse.json(),
    );

    const [
        integrityToken,
        estimatedTtlSecs,
        mintRefreshThreshold,
        websafeFallbackToken,
    ] = integrityTokenBody;
    const hasExtendedIntegrityTokenData =
        typeof estimatedTtlSecs === "number" &&
        typeof mintRefreshThreshold === "number" &&
        typeof websafeFallbackToken === "string";
    const integrityTokenData = hasExtendedIntegrityTokenData
        ? {
            integrityToken,
            estimatedTtlSecs,
            mintRefreshThreshold,
            websafeFallbackToken,
        }
        : { integrityToken };
    const integrityTokenBasedMinter = await BG.WebPoMinter.create(
        integrityTokenData,
        webPoSignalOutput,
    );

    const sessionPoToken = await integrityTokenBasedMinter.mintAsWebsafeString(
        visitorData,
    );

    return {
        sessionPoToken,
        visitorData,
        generatedMinter: integrityTokenBasedMinter,
    };
}
