import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { AuthSessionId, ThreadId } from "@t3tools/contracts";

import { NotificationSubscriptionRepository, layer } from "./NotificationSubscriptions.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const NOW = "2026-11-15T12:00:00.000Z";
const SESSION_A = AuthSessionId.make("session-a");
const SESSION_B = AuthSessionId.make("session-b");
const THREAD = ThreadId.make("thread-1");

const KEYS_A = {
  p256dh: "BGsfNQGvaqB9gvJrI6fqU25k4Zk1bQTfi_5JxFlC0tDnMMXwcxVB99rrVHadkm01RJRIaE5_p3dT6bO0LPL1FWQ",
  auth: "2jbUB3a7NutJl3Q2pEfKdg",
};
const KEYS_B = {
  p256dh: "BLta6VtGLJeMxaQyXXsxS0GrVj33IDiftUwC12xlFYB0J14G0inMiSIsisXnM-ubh__wf40gCLw74AxadMG0GH0",
  auth: "EgGjJVIrmD8qxGSQZf5GFA",
};

const insertAuthSession = (row: {
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
      VALUES (
        ${row.sessionId},
        'subject-1',
        '[]',
        'browser-session-cookie',
        '2026-11-01T00:00:00.000Z',
        ${row.expiresAt},
        ${row.revokedAt}
      )
    `;
  });

const layerPerTest = () =>
  layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  );

type TestServices =
  | SqlClient.SqlClient
  | NotificationSubscriptionRepository
  | SecureRandom.SecureRandom;

const testEffect = <A, E>(name: string, body: () => Effect.Effect<A, E, TestServices>) =>
  it.effect(name, () => body().pipe(Effect.provide(layerPerTest())));

describe("NotificationSubscriptionRepository", () => {
  testEffect("upserts a subscription and re-subscribes the same endpoint cleanly", () =>
    Effect.gen(function* () {
      const repository = yield* NotificationSubscriptionRepository;
      yield* insertAuthSession({
        sessionId: "session-a",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      yield* insertAuthSession({
        sessionId: "session-b",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });

      const first = yield* repository.upsertSubscription({
        sessionId: SESSION_A,
        endpoint: "https://push.example.com/sub/1",
        endpointOrigin: "https://push.example.com",
        keys: KEYS_A,
        label: "Pixel 9",
        userAgent: "Mozilla/5.0 (Linux; Android 15)",
        createdAt: NOW,
      });
      assert.strictEqual(first.sessionId, SESSION_A);
      assert.strictEqual(first.endpoint, "https://push.example.com/sub/1");
      assert.strictEqual(first.endpointOrigin, "https://push.example.com");
      assert.deepStrictEqual(first.keys, KEYS_A);
      assert.strictEqual(first.label, "Pixel 9");
      assert.strictEqual(first.userAgent, "Mozilla/5.0 (Linux; Android 15)");
      assert.strictEqual(first.createdAt, NOW);
      assert.isNull(first.lastDeliveredAt);
      assert.isTrue(first.id.length > 0);

      const resubscribed = yield* repository.upsertSubscription({
        sessionId: SESSION_B,
        endpoint: "https://push.example.com/sub/1",
        endpointOrigin: "https://push.example.com",
        keys: KEYS_B,
        label: "iPhone 17",
        userAgent: null,
        createdAt: "2026-11-15T13:00:00.000Z",
      });
      assert.strictEqual(resubscribed.id, first.id);
      assert.strictEqual(resubscribed.sessionId, SESSION_B);
      assert.deepStrictEqual(resubscribed.keys, KEYS_B);
      assert.strictEqual(resubscribed.label, "iPhone 17");
      assert.strictEqual(resubscribed.userAgent, null);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mobile_push_subscriptions
      `;
      assert.strictEqual(rows[0]?.count, 1);
      assert.deepStrictEqual(
        yield* repository.listSubscriptionsForSession({ sessionId: SESSION_A }),
        [],
      );
      assert.strictEqual(
        (yield* repository.listSubscriptionsForSession({ sessionId: SESSION_B })).length,
        1,
      );
    }),
  );

  testEffect("lists only subscriptions whose auth session is active or still exists", () =>
    Effect.gen(function* () {
      const repository = yield* NotificationSubscriptionRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* insertAuthSession({
        sessionId: "session-active",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      yield* insertAuthSession({
        sessionId: "session-revoked",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: "2026-11-14T00:00:00.000Z",
      });
      yield* insertAuthSession({
        sessionId: "session-expired",
        expiresAt: NOW,
        revokedAt: null,
      });

      const upsert = (sessionId: string, endpoint: string) =>
        repository.upsertSubscription({
          sessionId: AuthSessionId.make(sessionId),
          endpoint,
          endpointOrigin: "https://push.example.com",
          keys: KEYS_A,
          label: "Phone",
          userAgent: null,
          createdAt: NOW,
        });
      yield* upsert("session-active", "https://push.example.com/active");
      yield* upsert("session-revoked", "https://push.example.com/revoked");
      yield* upsert("session-expired", "https://push.example.com/expired");

      const deliverable = yield* repository.listDeliverableSubscriptions({ now: NOW });
      assert.deepStrictEqual(
        deliverable.map((subscription) => subscription.endpoint),
        ["https://push.example.com/active"],
      );

      yield* insertAuthSession({
        sessionId: "session-deleted",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      yield* upsert("session-deleted", "https://push.example.com/deleted");
      yield* sql`DELETE FROM auth_sessions WHERE session_id = 'session-deleted'`;
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mobile_push_subscriptions
        WHERE session_id = 'session-deleted'
      `;
      assert.strictEqual(remaining[0]?.count, 0);
      assert.deepStrictEqual(
        (yield* repository.listDeliverableSubscriptions({ now: NOW })).map(
          (subscription) => subscription.endpoint,
        ),
        ["https://push.example.com/active"],
      );
    }),
  );

  testEffect("deletes a subscription only for its owning session", () =>
    Effect.gen(function* () {
      const repository = yield* NotificationSubscriptionRepository;
      yield* insertAuthSession({
        sessionId: "session-a",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      yield* insertAuthSession({
        sessionId: "session-b",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      const stored = yield* repository.upsertSubscription({
        sessionId: SESSION_A,
        endpoint: "https://push.example.com/sub/1",
        endpointOrigin: "https://push.example.com",
        keys: KEYS_A,
        label: "Phone",
        userAgent: null,
        createdAt: NOW,
      });

      assert.isFalse(
        yield* repository.deleteSubscriptionForSession({ id: stored.id, sessionId: SESSION_B }),
      );
      assert.strictEqual(
        (yield* repository.listSubscriptionsForSession({ sessionId: SESSION_A })).length,
        1,
      );
      assert.isTrue(
        yield* repository.deleteSubscriptionForSession({ id: stored.id, sessionId: SESSION_A }),
      );
      assert.deepStrictEqual(
        yield* repository.listSubscriptionsForSession({ sessionId: SESSION_A }),
        [],
      );
    }),
  );

  testEffect("tracks delivery, endpoint deletion, and gone subscriptions", () =>
    Effect.gen(function* () {
      const repository = yield* NotificationSubscriptionRepository;
      yield* insertAuthSession({
        sessionId: "session-a",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      const first = yield* repository.upsertSubscription({
        sessionId: SESSION_A,
        endpoint: "https://push.example.com/sub/1",
        endpointOrigin: "https://push.example.com",
        keys: KEYS_A,
        label: "Phone",
        userAgent: null,
        createdAt: "2026-11-15T11:00:00.000Z",
      });
      const second = yield* repository.upsertSubscription({
        sessionId: SESSION_A,
        endpoint: "https://push.example.com/sub/2",
        endpointOrigin: "https://push.example.com",
        keys: KEYS_B,
        label: "Tablet",
        userAgent: null,
        createdAt: NOW,
      });

      yield* repository.markSubscriptionDelivered({
        id: first.id,
        deliveredAt: "2026-11-15T12:05:00.000Z",
      });
      assert.deepStrictEqual(
        (yield* repository.listSubscriptionsForSession({ sessionId: SESSION_A })).map(
          (subscription) => subscription.lastDeliveredAt,
        ),
        ["2026-11-15T12:05:00.000Z", null],
      );

      assert.isTrue(
        yield* repository.deleteSubscriptionByEndpoint({
          endpoint: "https://push.example.com/sub/1",
        }),
      );
      assert.isFalse(
        yield* repository.deleteSubscriptionByEndpoint({
          endpoint: "https://push.example.com/sub/1",
        }),
      );

      assert.isTrue(yield* repository.markSubscriptionGone({ id: second.id }));
      assert.isFalse(yield* repository.markSubscriptionGone({ id: second.id }));
      assert.deepStrictEqual(
        yield* repository.listSubscriptionsForSession({ sessionId: SESSION_A }),
        [],
      );
    }),
  );

  testEffect("purges subscriptions for revoked and expired sessions", () =>
    Effect.gen(function* () {
      const repository = yield* NotificationSubscriptionRepository;
      yield* insertAuthSession({
        sessionId: "session-active",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });
      yield* insertAuthSession({
        sessionId: "session-revoked",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: "2026-11-14T00:00:00.000Z",
      });
      yield* insertAuthSession({
        sessionId: "session-expired",
        expiresAt: NOW,
        revokedAt: null,
      });

      const upsert = (sessionId: string, endpoint: string) =>
        repository.upsertSubscription({
          sessionId: AuthSessionId.make(sessionId),
          endpoint,
          endpointOrigin: "https://push.example.com",
          keys: KEYS_A,
          label: "Phone",
          userAgent: null,
          createdAt: NOW,
        });
      const active = yield* upsert("session-active", "https://push.example.com/active");
      const revoked = yield* upsert("session-revoked", "https://push.example.com/revoked");
      const expired = yield* upsert("session-expired", "https://push.example.com/expired");

      const purged = yield* repository.deleteSubscriptionsForInactiveSessions({ now: NOW });
      assert.deepStrictEqual(purged.toSorted(), [expired.id, revoked.id].toSorted());
      assert.deepStrictEqual(
        yield* repository.deleteSubscriptionsForSession({
          sessionId: active.sessionId,
        }),
        [active.id],
      );
      assert.deepStrictEqual(
        (yield* repository.listDeliverableSubscriptions({ now: NOW })).map(
          (subscription) => subscription.endpoint,
        ),
        [],
      );
    }),
  );

  testEffect(
    "claims each dedupe key exactly once and prunes entries past the retention window",
    () =>
      Effect.gen(function* () {
        const repository = yield* NotificationSubscriptionRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
        INSERT INTO mobile_notification_dedupe (dedupe_key, thread_id, created_at) VALUES
          ('dedupe-stale', 'thread-0', '2026-11-01T00:00:00.000Z'),
          ('dedupe-recent', 'thread-0', '2026-11-14T12:00:00.000Z')
      `;

        assert.isTrue(
          yield* repository.claimNotificationDedupeKey({
            dedupeKey: "dedupe-new",
            threadId: THREAD,
            now: NOW,
          }),
        );
        assert.isFalse(
          yield* repository.claimNotificationDedupeKey({
            dedupeKey: "dedupe-new",
            threadId: THREAD,
            now: NOW,
          }),
        );
        assert.isFalse(
          yield* repository.claimNotificationDedupeKey({
            dedupeKey: "dedupe-new",
            threadId: ThreadId.make("thread-2"),
            now: NOW,
          }),
        );
        assert.isFalse(
          yield* repository.claimNotificationDedupeKey({
            dedupeKey: "dedupe-recent",
            threadId: THREAD,
            now: NOW,
          }),
        );
        assert.isTrue(
          yield* repository.claimNotificationDedupeKey({
            dedupeKey: "dedupe-stale",
            threadId: THREAD,
            now: NOW,
          }),
        );

        const rows = yield* sql<{ readonly dedupe_key: string }>`
        SELECT dedupe_key FROM mobile_notification_dedupe ORDER BY dedupe_key
      `;
        assert.deepStrictEqual(
          rows.map((row) => row.dedupe_key),
          ["dedupe-new", "dedupe-recent", "dedupe-stale"],
        );
      }),
  );

  testEffect("rejects malformed subscription keys at the repository boundary", () =>
    Effect.gen(function* () {
      const repository = yield* NotificationSubscriptionRepository;
      yield* insertAuthSession({
        sessionId: "session-a",
        expiresAt: "2026-12-01T00:00:00.000Z",
        revokedAt: null,
      });

      const exit = yield* Effect.exit(
        repository.upsertSubscription({
          sessionId: SESSION_A,
          endpoint: "https://push.example.com/sub/1",
          endpointOrigin: "https://push.example.com",
          keys: { p256dh: "bm90LWEta2V5", auth: KEYS_A.auth },
          label: "Phone",
          userAgent: null,
          createdAt: NOW,
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "Decode error in");

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mobile_push_subscriptions
      `;
      assert.strictEqual(rows[0]?.count, 0);
    }),
  );
});
