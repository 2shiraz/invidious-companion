import { ApiResponse, Innertube, Constants } from "youtubei.js";
import { UmpReader, CompositeBuffer } from "googlevideo/ump";
import {
    UMPPartId,
    OnesieInnertubeRequest,
    OnesieHeader,
    SabrError,
    OnesieProxyStatus,
    OnesieInnertubeResponse,
    OnesieRequest,
    CompressionType,
    OnesieHeaderType,
} from "googlevideo/protos";
import { base64ToU8 } from "googlevideo/utils";
import type { TokenMinter } from "../jobs/potoken.ts";
import type { Config } from "./config.ts";
import { getFetchClient } from "./getFetchClient.ts";

const enableCompression = true;
const TV_CONFIG_CACHE_TTL_MS = 15 * 60 * 1000;
const REDIRECTOR_CACHE_TTL_MS = 5 * 1 * 1000;

type CacheEntry<T> = {
    expiresAt: number;
    value: T;
};

type YouTubeTVClientConfig = Awaited<ReturnType<typeof getYouTubeTVClientConfig>>;

let cachedYouTubeTVClientConfig: CacheEntry<YouTubeTVClientConfig> | undefined;
let cachedYouTubeTVClientConfigPromise: Promise<YouTubeTVClientConfig> | undefined;
let cachedRedirectorBaseUrl: CacheEntry<string> | undefined;
let cachedRedirectorBaseUrlPromise: Promise<string> | undefined;

function getCachedValue<T>(cacheEntry: CacheEntry<T> | undefined): T | undefined {
    if (!cacheEntry || cacheEntry.expiresAt <= Date.now()) {
        return undefined;
    }

    return cacheEntry.value;
}

async function encryptRequest(
    clientKey: Uint8Array,
    data: Uint8Array,
): Promise<{ encrypted: Uint8Array; hmac: Uint8Array; iv: Uint8Array }> {
    if (clientKey.length !== 32) {
        throw new Error("Invalid client key length");
    }

    const aesKeyData = clientKey.slice(0, 16);
    const hmacKeyData = clientKey.slice(16, 32);

    const iv = crypto.getRandomValues(new Uint8Array(16));

    const aesKey = await crypto.subtle.importKey(
        "raw",
        aesKeyData,
        { name: "AES-CTR", length: 128 },
        false,
        ["encrypt"],
    );

    const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-CTR", counter: iv, length: 128 },
            aesKey,
            data,
        ),
    );

    const hmacKey = await crypto.subtle.importKey(
        "raw",
        hmacKeyData,
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign"],
    );

    const hmac = new Uint8Array(
        await crypto.subtle.sign(
            "HMAC",
            hmacKey,
            new Uint8Array([...encrypted, ...iv]),
        ),
    );

    return { encrypted, hmac, iv };
}

async function decryptResponse(
    iv: Uint8Array,
    hmac: Uint8Array,
    data: Uint8Array,
    clientKeyData: Uint8Array,
): Promise<Uint8Array> {
    if (!iv || !hmac || !data || !clientKeyData) {
        throw new Error("Invalid input");
    }

    const aesKey = await crypto.subtle.importKey(
        "raw",
        clientKeyData.slice(0, 16),
        { name: "AES-CTR", length: 128 },
        false,
        ["decrypt"],
    );

    const decryptedData = new Uint8Array(
        await crypto.subtle.decrypt(
            { name: "AES-CTR", counter: iv, length: 128 },
            aesKey,
            data,
        ),
    );

    const hmacKey = await crypto.subtle.importKey(
        "raw",
        clientKeyData.slice(16, 32),
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["verify"],
    );

    const isValid = await crypto.subtle.verify(
        "HMAC",
        hmacKey,
        hmac,
        new Uint8Array([...data, ...iv]),
    );

    if (!isValid) {
        throw new Error("HMAC verification failed");
    }

    return decryptedData;
}

async function getYouTubeTVClientConfig(fetchImpl: typeof fetch) {
    const tvConfigResponse = await fetchImpl(
        "https://www.youtube.com/tv_config?action_get_config=true&client=lb4&theme=cl",
        {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
            },
        },
    );

    const tvConfig = await tvConfigResponse.text();
    if (!tvConfig.startsWith(")]}")) {
        throw new Error("Invalid response from YouTube TV config endpoint.");
    }

    const tvConfigJson = JSON.parse(tvConfig.slice(4));

    const webPlayerContextConfig =
        tvConfigJson.webPlayerContextConfig
            .WEB_PLAYER_CONTEXT_CONFIG_ID_LIVING_ROOM_WATCH;
    const onesieHotConfig = webPlayerContextConfig.onesieHotConfig;

    const clientKeyData = base64ToU8(onesieHotConfig.clientKey);
    const encryptedClientKey = base64ToU8(onesieHotConfig.encryptedClientKey);
    const onesieUstreamerConfig = base64ToU8(
        onesieHotConfig.onesieUstreamerConfig,
    );
    const baseUrl = onesieHotConfig.baseUrl;

    return {
        clientKeyData,
        encryptedClientKey,
        onesieUstreamerConfig,
        baseUrl,
    };
}

async function getCachedYouTubeTVClientConfig(
    fetchImpl: typeof fetch,
): Promise<YouTubeTVClientConfig> {
    const cachedValue = getCachedValue(cachedYouTubeTVClientConfig);
    if (cachedValue) {
        return cachedValue;
    }

    if (!cachedYouTubeTVClientConfigPromise) {
        cachedYouTubeTVClientConfigPromise = getYouTubeTVClientConfig(fetchImpl)
            .then((value) => {
                cachedYouTubeTVClientConfig = {
                    value,
                    expiresAt: Date.now() + TV_CONFIG_CACHE_TTL_MS,
                };
                return value;
            })
            .finally(() => {
                cachedYouTubeTVClientConfigPromise = undefined;
            });
    }

    return await cachedYouTubeTVClientConfigPromise;
}

async function getRedirectorBaseUrl(fetchImpl: typeof fetch): Promise<string> {
    const cachedValue = getCachedValue(cachedRedirectorBaseUrl);
    if (cachedValue) {
        return cachedValue;
    }

    if (!cachedRedirectorBaseUrlPromise) {
        cachedRedirectorBaseUrlPromise = fetchImpl(
            "https://redirector.googlevideo.com/initplayback?source=youtube&itag=0&pvi=0&pai=0&owc=yes&cmo:sensitive_content=yes&alr=yes&id=" +
                Math.round(Math.random() * 1e5),
            { method: "GET" },
        )
            .then((response) => response.text())
            .then((responseUrl) => {
                if (!responseUrl.startsWith("https://")) {
                    throw new Error("Invalid redirector response");
                }

                const baseUrl = responseUrl.split("/initplayback")[0];
                cachedRedirectorBaseUrl = {
                    value: baseUrl,
                    expiresAt: Date.now() + REDIRECTOR_CACHE_TTL_MS,
                };
                return baseUrl;
            })
            .finally(() => {
                cachedRedirectorBaseUrlPromise = undefined;
            });
    }

    return await cachedRedirectorBaseUrlPromise;
}

async function prepareOnesieRequest(
    {
        videoId,
        poToken,
        clientConfig,
        innertube,
        reloadPlaybackContext,
    }: {
        videoId: string;
        poToken: string | undefined;
        clientConfig: Awaited<ReturnType<typeof getYouTubeTVClientConfig>>;
        innertube: Innertube;
        reloadPlaybackContext?: unknown;
    },
) {
    const { clientKeyData, encryptedClientKey, onesieUstreamerConfig } =
        clientConfig;
    const clonedInnerTubeContext = structuredClone(innertube.session.context);

    clonedInnerTubeContext.client.clientName =
        Constants.CLIENTS.VISIONOS.NAME;
    clonedInnerTubeContext.client.clientVersion =
        Constants.CLIENTS.VISIONOS.VERSION;

    delete clonedInnerTubeContext.client.configInfo;

    const params = {
        //adPlaybackContext: { pyv: true },
        playbackContext: {
            contentPlaybackContext: {
                vis: 0,
                splay: false,
                lactMilliseconds: "-1",
                signatureTimestamp: innertube.session.player?.signature_timestamp,
            },
        },
        contentCheckOk: true,
        racyCheckOk: true,
        videoId,
    };

    if (reloadPlaybackContext) {
        params.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
    }
    if (poToken) {
        params.serviceIntegrityDimensions = {
            poToken,
        };
    }

    const playerRequestJson = {
        context: clonedInnerTubeContext,
        ...params,
    };

    const headers = [
        { name: "Content-Type", value: "application/json" },
        { name: "User-Agent", value: clonedInnerTubeContext.client.userAgent },
        {
            name: "X-Goog-Visitor-Id",
            value: clonedInnerTubeContext.client.visitorData,
        },
    ];

    const onesieInnertubeRequest = OnesieInnertubeRequest.encode({
        url:
            "https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8",
        headers,
        body: JSON.stringify(playerRequestJson),
        proxiedByTrustedBandaid: true,
        skipResponseEncryption: true,
    }).finish();

    const { encrypted, hmac, iv } = await encryptRequest(
        clientKeyData,
        onesieInnertubeRequest,
    );

    const body = OnesieRequest.encode({
        urls: [],
        innertubeRequest: {
            enableCompression,
            encryptedClientKey,
            encryptedOnesieInnertubeRequest: encrypted,
            hmac,
            iv,
            useJsonformatterToParsePlayerResponse: false,
            serializeResponseAsJson: true,
        },
        streamerContext: {
            sabrContexts: [],
            unsentSabrContexts: [],
            poToken: poToken ? base64ToU8(poToken) : undefined,
            playbackCookie: undefined,
            clientInfo: {
                clientName: parseInt(
                    Constants.CLIENT_NAME_IDS[
                        clonedInnerTubeContext.client.clientName
                    ],
                ),
                clientVersion: clonedInnerTubeContext.client.clientVersion,
            },
        },
        bufferedRanges: [],
        onesieUstreamerConfig,
    }).finish();

    const videoIdBytes = base64ToU8(videoId);
    const encodedVideoId = Array.from(videoIdBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

    return { body, encodedVideoId };
}

async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data]).stream()
        .pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

async function getBasicInfo(
    innertube: Innertube,
    videoId: string,
    poToken: string | undefined,
    fetchImpl: typeof fetch,
): Promise<ApiResponse> {
    const redirectorBaseUrl = await getRedirectorBaseUrl(fetchImpl);
    const clientConfig = await getCachedYouTubeTVClientConfig(fetchImpl);

    const onesieRequest = await prepareOnesieRequest({
        videoId,
        poToken,
        clientConfig,
        innertube,
    });

    let url = `${redirectorBaseUrl}${clientConfig.baseUrl}`;

    const queryParams = [];
    queryParams.push(`id=${onesieRequest.encodedVideoId}`);
    queryParams.push("cmo:sensitive_content=yes");
    queryParams.push("opr=1");
    queryParams.push("osts=0");
    queryParams.push("por=1");
    queryParams.push("rn=0");

    url += `&${queryParams.join("&")}`;

    const response = await fetchImpl(url, {
        method: "POST",
        headers: {
            "accept": "*/*",
            "content-type": "application/octet-stream",
        },
        referrer: "https://www.youtube.com/",
        body: onesieRequest.body,
    });

    const arrayBuffer = await response.arrayBuffer();
    const googUmp = new UmpReader(
        new CompositeBuffer([new Uint8Array(arrayBuffer)]),
    );

    const onesie: OnesieHeader[] = [];

    function handleSabrError(part: { data: { chunks: Uint8Array[] } }) {
        const data = part.data.chunks[0];
        const error = SabrError.decode(data);
        console.error("[SABR_ERROR]:", error);
    }

    function handleOnesieHeader(part: { data: { chunks: Uint8Array[] } }) {
        const data = part.data.chunks[0];
        onesie.push(OnesieHeader.decode(data));
    }

    function handleOnesieData(part: { data: { chunks: Uint8Array[] } }) {
        const data = part.data.chunks[0];
        if (onesie.length > 0) {
            onesie[onesie.length - 1].data = data;
        } else {
            console.warn(
                "Received ONESIE_DATA without a preceding ONESIE_HEADER",
            );
        }
    }

    const umpPartHandlers = new Map([
        [UMPPartId.SABR_ERROR, handleSabrError],
        [UMPPartId.ONESIE_HEADER, handleOnesieHeader],
        [UMPPartId.ONESIE_DATA, handleOnesieData],
    ]);

    googUmp.read((part) => {
        const handler = umpPartHandlers.get(part.type);
        if (handler) handler(part);
    });

    const onesiePlayerResponse = onesie.find((header) =>
        header.type === OnesieHeaderType.ONESIE_PLAYER_RESPONSE
    );

    if (!onesiePlayerResponse) {
        throw new Error("Player response not found");
    }

    if (!onesiePlayerResponse.cryptoParams) {
        throw new Error("Crypto params not found");
    }

    const iv = onesiePlayerResponse.cryptoParams.iv;
    const hmac = onesiePlayerResponse.cryptoParams.hmac;

    let responseData = onesiePlayerResponse.data;

    if (
        responseData && enableCompression &&
        onesiePlayerResponse.cryptoParams.compressionType ===
            CompressionType.GZIP
    ) {
        responseData = await decompressGzip(responseData);
    }

    const decryptedData = hmac?.length && iv?.length
        ? await decryptResponse(iv, hmac, responseData, clientConfig.clientKeyData)
        : responseData;
    const decoded = OnesieInnertubeResponse.decode(decryptedData);

    if (decoded.onesieProxyStatus !== OnesieProxyStatus.OK) {
        throw new Error("Onesie proxy status not OK");
    }

    if (decoded.httpStatus !== 200) {
        throw new Error("Http status not OK");
    }

    return {
        success: true,
        status_code: 200,
        data: JSON.parse(new TextDecoder().decode(decoded.body)),
    };
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    //const contentPoToken = await tokenMinter(videoId);
    const safeProxySessionId = videoId.replaceAll("_", "-");
    const fetchImpl = getFetchClient(config, {
        proxySessionId: safeProxySessionId,
    });

    const res = await getBasicInfo(
        innertubeClient,
        videoId,
        'contentPoToken',
        fetchImpl,
    );

    return res;
};
