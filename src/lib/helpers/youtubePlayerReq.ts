import { ApiResponse, Constants, Innertube } from "youtubei.js";
import { CompositeBuffer, UmpReader } from "googlevideo/ump";
import {
    CompressionType,
    OnesieHeader,
    OnesieHeaderType,
    OnesieInnertubeRequest,
    OnesieInnertubeResponse,
    OnesieProxyStatus,
    OnesieRequest,
    SabrError,
    UMPPartId,
} from "googlevideo/protos";
import { base64ToU8 } from "googlevideo/utils";
import type { TokenMinter } from "../jobs/potoken.ts";
import type { Config } from "./config.ts";
import { getFetchClient } from "./getFetchClient.ts";
import { logTiming, nowMs, withTiming } from "./debugTiming.ts";

const enableCompression = true;

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
    const tvConfigUrl =
        "https://www.youtube.com/tv_config?action_get_config=true&client=lb4&theme=cl";
    const tvConfigResponse = await withTiming(
        "youtube tv_config fetch",
        () =>
            fetchImpl(tvConfigUrl, {
                method: "GET",
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
                },
            }),
        {
            endpoint: "tv_config",
            url: tvConfigUrl,
        },
    );

    const tvConfig = await withTiming(
        "youtube tv_config body",
        () => tvConfigResponse.text(),
        {
            endpoint: "tv_config",
            url: tvConfigUrl,
        },
    );
    if (!tvConfig.startsWith(")]}")) {
        throw new Error("Invalid response from YouTube TV config endpoint.");
    }

    const tvConfigJson = JSON.parse(tvConfig.slice(4));

    const webPlayerContextConfig = tvConfigJson.webPlayerContextConfig
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

    clonedInnerTubeContext.client.clientName = Constants.CLIENTS.TV_SIMPLY.NAME;
    clonedInnerTubeContext.client.clientVersion =
        Constants.CLIENTS.TV_SIMPLY.VERSION;

    delete clonedInnerTubeContext.client.configInfo;

    const params = {
        adPlaybackContext: { pyv: true },
        playbackContext: {
            contentPlaybackContext: {
                vis: 0,
                splay: false,
                lactMilliseconds: "-1",
                signatureTimestamp: innertube.session.player
                    ?.signature_timestamp,
            },
        },
        //contentCheckOk: true,
        //racyCheckOk: true,
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
        url: "https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyDCU8hByM-4DrUqRUYnGn-3llEO78bcxq8",
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
    const redirectorUrl =
        "https://redirector.googlevideo.com/initplayback?source=youtube&itag=0&pvi=0&pai=0&owc=yes&cmo:sensitive_content=yes&alr=yes&id=" +
        Math.round(Math.random() * 1e5);
    const redirectorResponse = await withTiming(
        "youtube redirector initplayback fetch",
        () => fetchImpl(redirectorUrl, { method: "GET" }),
        {
            videoId,
            url: redirectorUrl,
        },
    );
    const redirectorTextStartMs = nowMs();
    const redirectorResponseUrl = await redirectorResponse.text();
    logTiming("youtube redirector initplayback body", redirectorTextStartMs, {
        videoId,
        url: redirectorUrl,
    });
    if (!redirectorResponseUrl.startsWith("https://")) {
        throw new Error("Invalid redirector response");
    }

    const clientConfig = await getYouTubeTVClientConfig(fetchImpl);

    const onesieRequest = await withTiming(
        "youtube prepare onesie request",
        () =>
            prepareOnesieRequest({
                videoId,
                poToken,
                clientConfig,
                innertube,
            }),
        { videoId },
    );

    let url = `${
        redirectorResponseUrl.split("/initplayback")[0]
    }${clientConfig.baseUrl}`;

    const queryParams = [];
    queryParams.push(`id=${onesieRequest.encodedVideoId}`);
    queryParams.push("cmo:sensitive_content=yes");
    queryParams.push("opr=1");
    queryParams.push("osts=0");
    queryParams.push("por=1");
    queryParams.push("rn=0");

    url += `&${queryParams.join("&")}`;

    const response = await withTiming(
        "youtube onesie POST fetch",
        () =>
            fetchImpl(url, {
                method: "POST",
                headers: {
                    "accept": "*/*",
                    "content-type": "application/octet-stream",
                },
                referrer: "https://www.youtube.com/",
                body: onesieRequest.body,
            }),
        { videoId },
    );

    const arrayBufferStartMs = nowMs();
    const arrayBuffer = await response.arrayBuffer();
    logTiming("youtube onesie response body", arrayBufferStartMs, {
        videoId,
        bytes: arrayBuffer.byteLength,
    });

    const parseStartMs = nowMs();
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

    logTiming("youtube onesie parse ump", parseStartMs, { videoId });

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
        responseData = await withTiming(
            "youtube onesie gunzip",
            () => decompressGzip(responseData),
            { videoId },
        );
    }

    const decryptStartMs = nowMs();
    const decryptedData = hmac?.length && iv?.length
        ? await decryptResponse(
            iv,
            hmac,
            responseData,
            clientConfig.clientKeyData,
        )
        : responseData;
    logTiming("youtube onesie decrypt", decryptStartMs, { videoId });

    const decodeStartMs = nowMs();
    const decoded = OnesieInnertubeResponse.decode(decryptedData);
    logTiming("youtube onesie decode proto", decodeStartMs, { videoId });

    if (decoded.onesieProxyStatus !== OnesieProxyStatus.OK) {
        throw new Error("Onesie proxy status not OK");
    }

    if (decoded.httpStatus !== 200) {
        throw new Error("Http status not OK");
    }

    const jsonStartMs = nowMs();
    const data = JSON.parse(new TextDecoder().decode(decoded.body));
    logTiming("youtube onesie decode json", jsonStartMs, { videoId });

    return {
        success: true,
        status_code: 200,
        data,
    };
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    const tokenStartMs = nowMs();
    const contentPoToken = await tokenMinter(videoId);
    logTiming("youtube content PO token", tokenStartMs, { videoId });
    const fetchImpl = getFetchClient(config);

    const getBasicInfoStartMs = nowMs();
    const res = await getBasicInfo(
        innertubeClient,
        videoId,
        contentPoToken,
        fetchImpl,
    );
    logTiming("youtube getBasicInfo total", getBasicInfoStartMs, { videoId });

    return res;
};
