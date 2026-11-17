import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  fixture,
  panel,
  requestUrl,
  type NotificationTestState,
} from "./notificationsSettingsTestFixture";

export function notificationDeviceTests(state: NotificationTestState) {
  it.each([true, false])(
    "reconciles browser B and respects DELETE deleted=%s with a shared push origin",
    async (deleted) => {
      using setup = fixture(state);
      const keys = {
        p256dh:
          "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU",
        auth: "AAAAAAAAAAAAAAAAAAAAAA",
      };
      state.browserSubscription = {
        endpoint: "https://push.example/device-B",
        keys,
        userAgent: navigator.userAgent,
      };
      const registrations = ["device-A", "device-B"].map((id) => ({
        id,
        sessionId: "session-1",
        endpointOrigin: "https://push.example",
        label: id,
        createdAt: "2026-11-15T00:00:00.000Z",
        lastDeliveredAt: null,
      }));
      let rows = [...registrations];
      setup.fetchMock.mockImplementation(async (input, init) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/notifications/push-subscriptions") {
          if (init?.method === "POST") {
            expect(JSON.parse(String(init.body))).toMatchObject({
              endpoint: "https://push.example/device-B",
              keys,
            });
            return Response.json(registrations[1]);
          }
          return Response.json({ subscriptions: rows });
        }
        if (path === "/api/notifications/test") {
          expect(JSON.parse(String(init?.body))).toEqual({
            target: "web_push",
            subscriptionId: "device-B",
          });
          return Response.json({ delivered: true });
        }
        expect(path).toBe("/api/notifications/push-subscriptions/device-B");
        expect(init?.method).toBe("DELETE");
        if (deleted) rows = rows.filter((row) => row.id !== "device-B");
        return Response.json({ deleted });
      });
      await using screen = await render(panel());
      const toggle = screen.getByRole("switch", {
        name: "Enable Push on this device",
        exact: true,
      });
      await expect.element(screen.getByRole("button", { name: "Send Test Push" })).toBeEnabled();
      await screen.getByRole("button", { name: "Send Test Push" }).click();
      await expect.element(pageToast("Test push sent")).toBeVisible();
      await expect.element(toggle).toBeEnabled();
      await toggle.click();
      await expect
        .element(
          pageToast(deleted ? "Push disabled on this device" : "Push subscription was not deleted"),
        )
        .toBeVisible();
      expect(state.unsubscribe).toHaveBeenCalledTimes(deleted ? 1 : 0);
      await expect.element(screen.getByText("device-A", { exact: true })).toBeVisible();
      if (deleted) {
        await expect.element(screen.getByText("device-B", { exact: true })).not.toBeInTheDocument();
        await expect.element(toggle).not.toBeChecked();
      } else {
        await expect.element(screen.getByText("device-B", { exact: true })).toBeVisible();
        await expect.element(toggle).toBeChecked();
        expect(
          setup.fetchMock.mock.calls.filter(
            ([input, init]) =>
              requestUrl(input).pathname === "/api/notifications/push-subscriptions" &&
              init?.method === "GET",
          ),
        ).toHaveLength(2);
      }
      expect(
        setup.fetchMock.mock.calls.some(
          ([, init]) => init?.method === "POST" && String(init.body).includes('"endpoint"'),
        ),
      ).toBe(true);
      expect(
        Object.keys(localStorage).some(
          (key) => key.includes("device-B") && localStorage.getItem(key) === "device-B",
        ),
      ).toBe(true);
    },
  );
}

import { page } from "vite-plus/test/browser";
const pageToast = (name: string) => page.getByText(name, { exact: true });
