import { Hono } from "hono";
import { youtubePlayerParsing } from "../../lib/helpers/youtubePlayerHandling.ts";
import { HTTPException } from "hono/http-exception";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";
import { logTiming, nowMs } from "../../lib/helpers/debugTiming.ts";

const player = new Hono();

player.post("/player", async (c) => {
    const startMs = nowMs();
    const jsonReq = await c.req.json();
    const innertubeClient = c.get("innertubeClient");
    const config = c.get("config");
    const metrics = c.get("metrics");
    const tokenMinter = c.get("tokenMinter");

    if (config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        return c.json({
            playabilityStatus: {
                status: "ERROR",
                reason: TOKEN_MINTER_NOT_READY_MESSAGE,
                errorScreen: {
                    playerErrorMessageRenderer: {
                        reason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                        subreason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                    },
                },
            },
        });
    }

    if (jsonReq.videoId) {
        if (!validateVideoId(jsonReq.videoId)) {
            throw new HTTPException(400, {
                res: new Response("Invalid video ID format."),
            });
        }
        try {
            return c.json(
                await youtubePlayerParsing({
                    innertubeClient,
                    videoId: jsonReq.videoId,
                    config,
                    tokenMinter: tokenMinter!,
                    metrics,
                }),
            );
        } finally {
            logTiming("route POST /youtubei/v1/player", startMs, {
                videoId: jsonReq.videoId,
            });
        }
    }
});

export default player;
