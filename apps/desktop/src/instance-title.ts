const ACCENTS = ["#d4537e", "#e09f3e", "#3d9a78", "#3d7ec9", "#7a5af5", "#c46b3a"] as const;
const INSTANCE_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function instanceLabel(input: {
  readonly kind: "local" | "remote";
  readonly localLabel: string;
  readonly name?: string | null | undefined;
  readonly origin?: string | null | undefined;
}): string {
  if (input.kind === "local") return input.localLabel;
  const name = input.name?.trim();
  let hostname = "";
  if (input.origin) {
    try {
      hostname = new URL(input.origin).hostname;
    } catch {
      hostname = "";
    }
  }
  if (name && name !== input.origin && name !== hostname) return name;
  return hostname || name || input.localLabel;
}

export function instanceWindowTitle(instanceName: string, documentTitle?: string | null): string {
  const context = pageContext(documentTitle);
  return context ? `${instanceName} — ${context}` : `${instanceName} — Cox`;
}

export function instanceRoleTitle(instanceName: string, role: string): string {
  return `${instanceName} — ${role}`;
}

function pageContext(documentTitle?: string | null): string | null {
  const title = documentTitle?.trim() ?? "";
  if (!title || /^cox(?:\s*\([^)]+\))?$/i.test(title)) return null;
  const stripped = title.replace(/\s*[·—|-]\s*cox(?:\s*\([^)]+\))?$/i, "").trim();
  if (!stripped || /^cox(?:\s*\([^)]+\))?$/i.test(stripped)) return null;
  return stripped;
}

export function instanceAccent(instanceId: string): string {
  let hash = 0;
  for (const char of instanceId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return ACCENTS[hash % ACCENTS.length]!;
}

export function accentBitmap(color: string, size = 16): Buffer {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match || !Number.isInteger(size) || size < 1 || size > 64)
    throw new Error("Invalid instance accent.");
  const value = Number.parseInt(match[1]!, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let pixel = 0; pixel < size * size; pixel++) {
    bitmap[pixel * 4] = blue;
    bitmap[pixel * 4 + 1] = green;
    bitmap[pixel * 4 + 2] = red;
    bitmap[pixel * 4 + 3] = 255;
  }
  return bitmap;
}

export function windowsInstanceAppId(instanceId: string): string {
  if (!INSTANCE_ID.test(instanceId)) throw new Error("Invalid instance id.");
  return "dev.cox.desktop.instance." + instanceId;
}

export function windowsRelaunchCommand(input: {
  readonly execPath: string;
  readonly appPath?: string;
  readonly instanceId: string;
}): string {
  windowsInstanceAppId(input.instanceId);
  const quote = (value: string) => `"${value.replaceAll('"', "")}"`;
  return [
    quote(input.execPath),
    ...(input.appPath ? [quote(input.appPath)] : []),
    "--cox-instance=" + input.instanceId,
  ].join(" ");
}

export function instanceIdFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    const value = argument.startsWith("--cox-instance=")
      ? argument.slice("--cox-instance=".length)
      : argument === "--cox-instance"
        ? argv[index + 1]
        : undefined;
    if (value && INSTANCE_ID.test(value)) return value;
  }
}
