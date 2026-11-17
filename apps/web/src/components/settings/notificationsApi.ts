import {
  DeletePushSubscriptionResponse,
  MobilePushSubscriptionInput,
  NOTIFICATION_PUSH_SUBSCRIPTION_PATH,
  NOTIFICATION_PUSH_SUBSCRIPTIONS_PATH,
  NOTIFICATION_TEST_PATH,
  NOTIFICATION_VAPID_PUBLIC_KEY_PATH,
  PushSubscriptionsListResponse,
  RegisteredPushSubscription,
  TestNotificationResponse,
  VapidPublicKeyResponse,
  type MobilePushSubscriptionInput as MobilePushSubscriptionInputValue,
  type EnvironmentId,
  type PushSubscriptionId,
  type RegisteredPushSubscription as RegisteredPushSubscriptionValue,
  type TestNotificationRequest,
  type TestNotificationResponse as TestNotificationResponseValue,
  type VapidPublicKeyResponse as VapidPublicKeyResponseValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { BrowserPushSubscription } from "../../pwa/serviceWorkerRegistration";

const decodeVapidResponse = Schema.decodeUnknownSync(VapidPublicKeyResponse);
const decodeSubscriptionsResponse = Schema.decodeUnknownSync(PushSubscriptionsListResponse);
const decodeSubscriptionInput = Schema.decodeSync(MobilePushSubscriptionInput);
const decodeRegisteredSubscription = Schema.decodeUnknownSync(RegisteredPushSubscription);
const decodeDeleteResponse = Schema.decodeUnknownSync(DeletePushSubscriptionResponse);
const decodeTestResponse = Schema.decodeUnknownSync(TestNotificationResponse);

export class NotificationHttpError extends Error {
  constructor(readonly status: number) {
    super(`Notification request failed (HTTP ${status}).`);
    this.name = "NotificationHttpError";
  }
}

interface RequestOptions {
  readonly method?: "POST" | "DELETE";
  readonly body?: unknown;
}

async function request(baseUrl: string, path: string, options: RequestOptions = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) throw new NotificationHttpError(response.status);
  const body: unknown = await response.json();
  return body;
}

export async function fetchVapidPublicKey(baseUrl: string): Promise<VapidPublicKeyResponseValue> {
  return decodeVapidResponse(await request(baseUrl, NOTIFICATION_VAPID_PUBLIC_KEY_PATH));
}

export async function fetchPushSubscriptions(
  baseUrl: string,
): Promise<readonly RegisteredPushSubscriptionValue[]> {
  const response = decodeSubscriptionsResponse(
    await request(baseUrl, NOTIFICATION_PUSH_SUBSCRIPTIONS_PATH),
  );
  return response.subscriptions;
}

export async function registerBrowserPushSubscription(
  baseUrl: string,
  subscription: BrowserPushSubscription,
  context: { readonly environmentId: EnvironmentId; readonly label: string },
): Promise<RegisteredPushSubscriptionValue> {
  const input: MobilePushSubscriptionInputValue = decodeSubscriptionInput({
    ...subscription,
    label: context.label,
  });
  const registered = decodeRegisteredSubscription(
    await request(baseUrl, NOTIFICATION_PUSH_SUBSCRIPTIONS_PATH, { method: "POST", body: input }),
  );
  localStorage.setItem(
    browserPushSubscriptionStorageKey(context.environmentId, subscription.endpoint),
    registered.id,
  );
  return registered;
}

export function browserPushSubscriptionStorageKey(environmentId: EnvironmentId, endpoint: string) {
  return `cox.notifications.pushSubscriptionIds:${JSON.stringify([environmentId, endpoint])}`;
}

export async function deletePushSubscription(baseUrl: string, id: PushSubscriptionId) {
  const path = NOTIFICATION_PUSH_SUBSCRIPTION_PATH.replace(":id", encodeURIComponent(id));
  return decodeDeleteResponse(await request(baseUrl, path, { method: "DELETE" }));
}

export async function sendTestNotification(
  baseUrl: string,
  input: TestNotificationRequest,
): Promise<TestNotificationResponseValue> {
  return decodeTestResponse(
    await request(baseUrl, NOTIFICATION_TEST_PATH, { method: "POST", body: input }),
  );
}
