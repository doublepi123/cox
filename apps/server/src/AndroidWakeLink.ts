import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";

const framePrefix = "@cox-android-wake/1";

type WakeMode = "hold" | "idle";
type ReleaseWakeLease = () => void;

export class AndroidWakeLinkError extends Error {
  override readonly name = "AndroidWakeLinkError";
}

export function makeAndroidWakeLink(
  nonce: string,
  input: NodeJS.ReadableStream,
  output: Pick<typeof process.stdout, "write">,
  idleDelayMs = 15_000,
  ackTimeoutMs = 5_000,
) {
  const prefix = `${framePrefix} ${nonce}`;
  const replies = createInterface({ input, crlfDelay: Infinity });
  let reply: { readonly frame: string; readonly resolve: () => void } | undefined;
  let sequence = 0;
  let closed = false;
  let armed = false;
  let leases = 0;
  let mode: WakeMode | undefined;
  let idle: AbortController | undefined;
  let lastRequest: Promise<void> = Promise.resolve();

  replies.on("line", (line) => {
    if (reply?.frame === line) reply.resolve();
  });
  replies.on("close", () => {
    closed = true;
  });

  const request = (next: WakeMode): Promise<void> => {
    const current = lastRequest.then(async () => {
      if (closed) throw new AndroidWakeLinkError("Android wake link closed");
      if (mode === next) return;
      mode = undefined;
      const frame = `${prefix} ${++sequence}`;
      const acknowledgement = Effect.callback<void, AndroidWakeLinkError>((resume) => {
        const expected = { frame: `${frame} ack`, resolve: () => resume(Effect.void) };
        reply = expected;
        output.write(`${frame} ${next}\n`, (error) => {
          if (error) {
            resume(
              Effect.fail(
                new AndroidWakeLinkError("Android wake link write failed", { cause: error }),
              ),
            );
          }
        });
        return Effect.sync(() => {
          if (reply === expected) reply = undefined;
        });
      });
      try {
        await Effect.runPromise(acknowledgement.pipe(Effect.timeout(ackTimeoutMs)));
      } finally {
        reply = undefined;
      }
      mode = next;
    });
    lastRequest = current.catch(() => undefined);
    return current;
  };

  const scheduleIdle = () => {
    if (!armed || leases !== 0 || idle !== undefined || closed) return;
    const timer = new AbortController();
    idle = timer;
    Effect.runFork(
      Effect.sleep(idleDelayMs).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (idle !== timer) return Effect.void;
            idle = undefined;
            if (leases !== 0 || closed) return Effect.void;
            return Effect.tryPromise(() => request("idle")).pipe(
              Effect.catch(() => Effect.tryPromise(() => request("hold"))),
              Effect.catch((error) =>
                Effect.logWarning("Android wake link could not restore the wake state", error),
              ),
            );
          }),
        ),
      ),
      { signal: timer.signal },
    );
  };

  return {
    enableIdle(): void {
      armed = true;
      scheduleIdle();
    },
    async hold(): Promise<ReleaseWakeLease> {
      idle?.abort();
      idle = undefined;
      leases += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        leases -= 1;
        scheduleIdle();
      };
      try {
        await request("hold");
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
    close(): void {
      closed = true;
      idle?.abort();
      replies.close();
      input.pause();
    },
  };
}

let link: ReturnType<typeof makeAndroidWakeLink> | undefined;

export function hasAndroidWakeLink(): boolean {
  return link !== undefined;
}

export function startAndroidWakeLink(): ReleaseWakeLease {
  const nonce = process.env.COX_ANDROID_WAKE_NONCE;
  if (nonce === undefined || !/^[a-f0-9]{32}$/.test(nonce)) return () => undefined;
  const running = makeAndroidWakeLink(nonce, process.stdin, process.stdout);
  link = running;
  return () => {
    running.close();
    if (link === running) link = undefined;
  };
}

export function enableAndroidWakeIdle(): void {
  link?.enableIdle();
}

export function holdAndroidWake(): Promise<ReleaseWakeLease> {
  return link?.hold() ?? Promise.resolve(() => undefined);
}
