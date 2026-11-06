import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopUpdateProgress } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  backendInstallerEnvironment,
  compareBackendVersions,
  downloadBackendRelease,
  fetchBackendRelease,
  isBackendVersion,
  installBackendRelease,
  parseBackendRelease,
} from "./backend-install.ts";

const archive = Buffer.from("verified Cox archive");
const metadata = {
  name: "@doublepi123/cox",
  version: "0.2.0",
  coxDesktop: { protocol: 1, nodeVersion: "26.12.1" },
  dist: {
    tarball: "https://registry.npmjs.org/@doublepi123/cox/-/cox-0.2.0.tgz",
    integrity: "sha512-" + createHash("sha512").update(archive).digest("base64"),
  },
};
afterEach(() => vi.restoreAllMocks());

function streamedResponse(chunks: Uint8Array[], headers?: HeadersInit): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    headers ? { headers } : {},
  );
}

describe("desktop backend release verification", () => {
  it("does not expose provider or publishing credentials to installer lifecycle commands", () => {
    expect(
      backendInstallerEnvironment({
        PATH: "/runtime/bin",
        HOME: "/user",
        SystemRoot: "C:\\Windows",
        OPENAI_API_KEY: "private",
        ANTHROPIC_API_KEY: "private",
        GH_TOKEN: "private",
        NODE_AUTH_TOKEN: "private",
        NPM_TOKEN: "private",
        npm_config_registry: "https://foreign.invalid",
        NODE_OPTIONS: "--import malicious",
        HTTPS_PROXY: "https://proxy.invalid",
      }),
    ).toEqual({
      PATH: "/runtime/bin",
      HOME: "/user",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "https://proxy.invalid",
    });
  });
  it("uses semantic version ordering rather than lexical ordering", () => {
    expect(compareBackendVersions("0.1.100", "0.1.99")).toBe(1);
    for (const invalid of ["../0.2.0", "0.2.0-beta", "01.2.3", "1.2", "999999999999999999.0.0"])
      expect(isBackendVersion(invalid)).toBe(false);
  });
  it("requires the official package, registry, integrity and runtime compatibility", () => {
    expect(parseBackendRelease(metadata, "26.12.1").compatible).toBe(true);
    expect(parseBackendRelease(metadata, "26.11.0").compatible).toBe(false);
    expect(parseBackendRelease(metadata, "27.0.0").compatible).toBe(false);
    expect(() => parseBackendRelease({ ...metadata, name: "someone/cox" }, "26.12.1")).toThrow();
    for (const tarball of [
      "https://evil.invalid/cox.tgz",
      "http://registry.npmjs.org/cox.tgz",
      metadata.dist.tarball + "?redirect=evil",
    ])
      expect(() =>
        parseBackendRelease({ ...metadata, dist: { ...metadata.dist, tarball } }, "26.12.1"),
      ).toThrow();
  });
  it("limits legacy compatibility to the known desktop-era releases", () => {
    expect(
      parseBackendRelease(
        {
          ...metadata,
          version: "0.1.41",
          coxDesktop: undefined,
          dist: { ...metadata.dist, tarball: metadata.dist.tarball.replace("0.2.0", "0.1.41") },
        },
        "26.12.1",
      ).compatible,
    ).toBe(true);
    expect(parseBackendRelease({ ...metadata, coxDesktop: undefined }, "26.12.1").compatible).toBe(
      false,
    );
  });
  it("checks SHA-512 before allowing an archive to be installed", async () => {
    const release = parseBackendRelease(metadata, "26.12.1");
    const fetcher = vi.fn<typeof fetch>(async () => new Response(archive));
    expect(await downloadBackendRelease(release, AbortSignal.timeout(1000), fetcher)).toEqual(
      archive,
    );
    fetcher.mockImplementation(async () => new Response("corrupted"));
    await expect(
      downloadBackendRelease(release, AbortSignal.timeout(1000), fetcher),
    ).rejects.toThrow("checksum");
  });
  it("does not follow registry redirects or accept a foreign download location", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(metadata)));
    await fetchBackendRelease("26.12.1", AbortSignal.timeout(1000), fetcher);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    await expect(
      downloadBackendRelease(
        { ...parseBackendRelease(metadata, "26.12.1"), url: "file:///etc/passwd" },
        AbortSignal.timeout(1000),
        fetcher,
      ),
    ).rejects.toThrow("official registry");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports streamed bytes, throughput and remaining time for a known download length", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const response = new TransformStream<Uint8Array, Uint8Array>();
    const writer = response.writable.getWriter();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(response.readable, { headers: { "Content-Length": String(archive.length) } }),
    );
    const reported = Promise.withResolvers<void>();
    const headers = Promise.withResolvers<void>();
    const states: DesktopUpdateProgress[] = [];
    const downloading = downloadBackendRelease(
      parseBackendRelease(metadata, "26.12.1"),
      new AbortController().signal,
      fetcher,
      (progress) => {
        states.push(progress);
        if (progress.totalBytes !== null && progress.transferredBytes === 0) headers.resolve();
        if (progress.transferredBytes === 5) reported.resolve();
      },
    );
    await headers.promise;
    now = 1000;
    await writer.write(archive.subarray(0, 5));
    await reported.promise;
    expect(states.at(-1)).toEqual({
      phase: "downloading",
      transferredBytes: 5,
      totalBytes: archive.length,
      bytesPerSecond: 5,
      remainingSeconds: Math.ceil((archive.length - 5) / 5),
    });
    now = 1050;
    await writer.write(archive.subarray(5));
    await writer.close();
    expect(await downloading).toEqual(archive);
    expect(states.at(-2)).toMatchObject({
      phase: "downloading",
      transferredBytes: archive.length,
      totalBytes: archive.length,
      remainingSeconds: 0,
    });
    expect(states.at(-1)?.phase).toBe("verifying");
  });

  it("keeps an unknown download length indeterminate and always emits the final byte count", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const states: DesktopUpdateProgress[] = [];
    const fetcher = vi.fn<typeof fetch>(async () =>
      streamedResponse(Array.from(archive, (byte) => Uint8Array.of(byte))),
    );
    await downloadBackendRelease(
      parseBackendRelease(metadata, "26.12.1"),
      new AbortController().signal,
      fetcher,
      (progress) => states.push(progress),
    );
    expect(states).toEqual([
      {
        phase: "downloading",
        transferredBytes: 0,
        totalBytes: null,
        bytesPerSecond: null,
        remainingSeconds: null,
      },
      {
        phase: "downloading",
        transferredBytes: archive.length,
        totalBytes: null,
        bytesPerSecond: null,
        remainingSeconds: null,
      },
      {
        phase: "verifying",
        transferredBytes: 0,
        totalBytes: null,
        bytesPerSecond: null,
        remainingSeconds: null,
      },
    ]);
  });

  it.each(["0", "-1", "invalid", "1.5", "9007199254740992", "999999999"])(
    "treats content length %s as unknown",
    async (length) => {
      const onProgress = vi.fn<(progress: DesktopUpdateProgress) => void>();
      const fetcher = vi.fn<typeof fetch>(async () =>
        streamedResponse([archive], { "Content-Length": length }),
      );
      await downloadBackendRelease(
        parseBackendRelease(metadata, "26.12.1"),
        new AbortController().signal,
        fetcher,
        onProgress,
      );
      for (const [progress] of onProgress.mock.calls) {
        expect(progress.totalBytes).toBeNull();
        expect(progress.remainingSeconds).toBeNull();
      }
    },
  );

  it.each(["1", String(archive.length + 5)])(
    "discards inconsistent content length %s without reporting over 100 percent",
    async (length) => {
      const states: DesktopUpdateProgress[] = [];
      const fetcher = vi.fn<typeof fetch>(async () =>
        streamedResponse([archive.subarray(0, 5), archive.subarray(5)], {
          "Content-Length": length,
        }),
      );
      await downloadBackendRelease(
        parseBackendRelease(metadata, "26.12.1"),
        new AbortController().signal,
        fetcher,
        (progress) => states.push(progress),
      );
      for (const progress of states)
        if (progress.totalBytes !== null)
          expect(progress.transferredBytes).toBeLessThanOrEqual(progress.totalBytes);
      expect(states.at(-2)).toMatchObject({
        phase: "downloading",
        transferredBytes: archive.length,
        totalBytes: null,
        remainingSeconds: null,
      });
    },
  );

  it("does not compare decoded response bytes against an encoded content length", async () => {
    const states: DesktopUpdateProgress[] = [];
    await downloadBackendRelease(
      parseBackendRelease(metadata, "26.12.1"),
      new AbortController().signal,
      async () =>
        streamedResponse([archive], {
          "Content-Length": "10",
          "Content-Encoding": "gzip",
        }),
      (progress) => states.push(progress),
    );
    expect(states.every((progress) => progress.totalBytes === null)).toBe(true);
  });

  it("cancels a stalled stream and emits the last received byte count without verifying", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const received = Promise.withResolvers<void>();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const states: DesktopUpdateProgress[] = [];
    const downloading = downloadBackendRelease(
      parseBackendRelease(metadata, "26.12.1"),
      controller.signal,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(stream) {
              if (now !== 0) return;
              now = 1000;
              stream.enqueue(archive.subarray(0, 5));
            },
            cancel,
          }),
        ),
      (progress) => {
        states.push(progress);
        if (progress.transferredBytes === 5) received.resolve();
      },
    );
    const rejected = expect(downloading).rejects.toThrow("aborted");
    await received.promise;
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ phase: "downloading", transferredBytes: 5 });
    expect(states.some((progress) => progress.phase === "verifying")).toBe(false);
  });

  it("preserves stream failures and reports partial bytes", async () => {
    const states: DesktopUpdateProgress[] = [];
    let sent = false;
    await expect(
      downloadBackendRelease(
        parseBackendRelease(metadata, "26.12.1"),
        new AbortController().signal,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (sent) controller.error(new Error("connection lost"));
                else {
                  sent = true;
                  controller.enqueue(archive.subarray(0, 5));
                }
              },
            }),
          ),
        (progress) => states.push(progress),
      ),
    ).rejects.toThrow("connection lost");
    expect(states.at(-1)).toMatchObject({ phase: "downloading", transferredBytes: 5 });
  });

  it("still enforces the streamed size limit with progress enabled", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1024 * 1024);
    const states: DesktopUpdateProgress[] = [];
    await expect(
      downloadBackendRelease(
        parseBackendRelease(metadata, "26.12.1"),
        new AbortController().signal,
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(chunk);
              },
              cancel,
            }),
            { headers: { "Content-Length": "1" } },
          ),
        (progress) => states.push(progress),
      ),
    ).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({
      phase: "downloading",
      transferredBytes: 257 * 1024 * 1024,
      totalBytes: null,
    });
  });

  it("threads install progress through download and verification before invoking npm", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-install-progress-"));
    try {
      const states: DesktopUpdateProgress[] = [];
      await expect(
        installBackendRelease({
          release: parseBackendRelease(metadata, "26.12.1"),
          directory,
          node: process.execPath,
          npm: join(directory, "missing-npm.js"),
          environment: process.env,
          signal: new AbortController().signal,
          fetcher: async () => streamedResponse([archive]),
          onProgress: (progress) => states.push(progress),
        }),
      ).rejects.toThrow("command failed");
      expect(states.map((progress) => progress.phase)).toEqual([
        "downloading",
        "downloading",
        "verifying",
        "installing",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not begin installation or write files when integrity verification fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-install-invalid-"));
    try {
      const states: DesktopUpdateProgress[] = [];
      await expect(
        installBackendRelease({
          release: parseBackendRelease(metadata, "26.12.1"),
          directory,
          node: process.execPath,
          npm: join(directory, "missing-npm.js"),
          environment: process.env,
          signal: new AbortController().signal,
          fetcher: async () => streamedResponse([Buffer.from("corrupt")]),
          onProgress: (progress) => states.push(progress),
        }),
      ).rejects.toThrow("checksum");
      expect(states.at(-1)?.phase).toBe("verifying");
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
