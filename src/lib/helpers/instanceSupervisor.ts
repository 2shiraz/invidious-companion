// Multi-instance supervisor: lets a single compiled binary fan out into N
// worker processes sharing one port via SO_REUSEPORT (Linux only), instead
// of needing an external load balancer, PM2, or Docker Compose replicas.
// Set SERVER_INSTANCE_COUNT > 1 to enable it.
//
// Each worker independently creates its own Innertube session / mints its
// own PO token, exactly like a single-instance deployment does today — this
// only handles process fan-out and port sharing, not decoupling token
// generation. That's a separate, larger change; worth revisiting if
// instance counts get large enough that N independent BotGuard challenges
// at once becomes its own problem.

const WORKER_ENV_VAR = "INVIDIOUS_COMPANION_WORKER";
const INSTANCE_ID_ENV_VAR = "INVIDIOUS_COMPANION_INSTANCE_ID";

// Spread out startup so instances don't all mint/validate a PO token at the
// exact same moment.
const STAGGER_MS = 500;

export function isSupervisedWorker(): boolean {
    return Deno.env.get(WORKER_ENV_VAR) === "true";
}

export function currentInstanceId(): number {
    return Number(Deno.env.get(INSTANCE_ID_ENV_VAR)) || 0;
}

/**
 * Returns true if this process should continue on to start the server
 * itself (single-instance mode, or a spawned worker). Returns false only
 * after having run as a supervisor to completion — the caller should exit
 * immediately in that case.
 */
export async function maybeRunAsSupervisor(): Promise<boolean> {
    const instanceCount = Number(Deno.env.get("SERVER_INSTANCE_COUNT")) || 1;

    if (instanceCount <= 1 || isSupervisedWorker()) {
        return true;
    }

    if (!Deno.build.standalone) {
        console.error(
            "[ERROR] [SUPERVISOR] SERVER_INSTANCE_COUNT > 1 is only supported " +
                "when running the compiled binary (it needs to re-exec itself " +
                "as workers). Falling back to a single instance under " +
                "`deno run`/`deno task dev`.",
        );
        return true;
    }

    if (Deno.build.os !== "linux") {
        console.error(
            `[ERROR] [SUPERVISOR] SERVER_INSTANCE_COUNT > 1 requires Linux ` +
                `(SO_REUSEPORT). Detected OS: ${Deno.build.os}. Falling back ` +
                `to a single instance.`,
        );
        return true;
    }

    console.log(
        `[INFO] [SUPERVISOR] Starting ${instanceCount} instance(s) sharing one port via SO_REUSEPORT...`,
    );

    const children: Deno.ChildProcess[] = [];

    for (let i = 0; i < instanceCount; i++) {
        if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
        }

        const command = new Deno.Command(Deno.execPath(), {
            args: Deno.args,
            env: {
                ...Deno.env.toObject(),
                [WORKER_ENV_VAR]: "true",
                [INSTANCE_ID_ENV_VAR]: String(i),
                SERVER_REUSE_PORT: "true",
            },
            stdout: "piped",
            stderr: "piped",
        });

        const child = command.spawn();
        children.push(child);
        void pipeWithPrefix(child.stdout, `[instance ${i}] `, false);
        void pipeWithPrefix(child.stderr, `[instance ${i}] `, true);
    }

    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("[INFO] [SUPERVISOR] Shutting down all instances...");
        for (const child of children) {
            try {
                child.kill("SIGTERM");
            } catch {
                // already exited
            }
        }
    };

    Deno.addSignalListener("SIGINT", shutdown);
    // Safe unconditionally: this point is only reached when
    // Deno.build.os === "linux" (gated above), and SIGTERM is supported
    // there. main.ts's own shutdown handling guards this the same way for
    // the same reason — SIGTERM isn't supported on Windows.
    Deno.addSignalListener("SIGTERM", shutdown);

    // If any one instance dies unexpectedly, bring the whole fleet down
    // rather than silently running short-handed.
    await Promise.race(children.map((child) => child.status));
    shutdown();
    await Promise.all(children.map((child) => child.status.catch(() => {})));

    console.log("[INFO] [SUPERVISOR] All instances exited.");
    return false;
}

async function pipeWithPrefix(
    stream: ReadableStream<Uint8Array>,
    prefix: string,
    isError: boolean,
): Promise<void> {
    const reader = stream
        .pipeThrough(
            new TextDecoderStream() as unknown as ReadableWritablePair<
                string,
                Uint8Array
            >,
        )
        .getReader();
    let buffer = "";
    const write = isError
        ? (line: string) => console.error(prefix + line)
        : (line: string) => console.log(prefix + line);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += value;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) write(line);
        }
        if (buffer) write(buffer);
    } catch {
        // stream closed/errored on shutdown — nothing to do
    }
}
