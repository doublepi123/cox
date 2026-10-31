import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "The local server address is not available.",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: "Only this computer can call this local server address.",
  };
}
