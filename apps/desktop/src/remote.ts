import { randomUUID } from "node:crypto";
import {
  inspectRemoteServer as inspectSharedRemoteServer,
  normalizeRemoteOrigin as normalizeSharedRemoteOrigin,
  type RemoteServerInspection,
} from "@t3tools/shared/remoteServerAdmission";

export {
  isCloudflareAccessGate,
  isCloudflareAccessUrl,
  RemoteGatewayRequiredError,
  type RemoteServerInspection,
} from "@t3tools/shared/remoteServerAdmission";

export interface RemoteConnectionInput {
  readonly id?: string;
  readonly name?: string;
  readonly origin?: string;
  readonly openInNewWindow?: boolean;
}

export function normalizeRemoteOrigin(input: string): string {
  return normalizeSharedRemoteOrigin(input, { allowInsecureHttp: false });
}

export function remoteProfileId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Invalid remote server identity.");
  return value.toLowerCase();
}

export function remotePartition(id: string): string {
  return `persist:cox-remote-${remoteProfileId(id)}`;
}

export function newRemoteProfileId(): string {
  return randomUUID();
}

export async function inspectRemoteServer(
  originInput: string,
  fetcher: typeof fetch = fetch,
  signal = AbortSignal.timeout(15_000),
): Promise<RemoteServerInspection> {
  return inspectSharedRemoteServer(originInput, {
    allowInsecureHttp: false,
    fetcher,
    signal,
  });
}
