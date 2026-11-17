// allow: SIZE_OK — single-file Effect repository module, matching the persistence-layer idiom
// (AuthSessions.ts) and this todo's pinned deliverable file.
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  AuthSessionId,
  IsoDateTime,
  NotificationLabel,
  PushSubscriptionId,
  PushSubscriptionKeys,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import {
  type PersistenceErrorCorrelation,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export type NotificationSubscriptionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const UpsertMobilePushSubscriptionInput = Schema.Struct({
  sessionId: AuthSessionId,
  endpoint: TrimmedNonEmptyString,
  endpointOrigin: TrimmedNonEmptyString,
  keys: PushSubscriptionKeys,
  label: NotificationLabel,
  userAgent: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type UpsertMobilePushSubscriptionInput = typeof UpsertMobilePushSubscriptionInput.Type;

export const StoredMobilePushSubscription = Schema.Struct({
  id: PushSubscriptionId,
  sessionId: AuthSessionId,
  endpoint: TrimmedNonEmptyString,
  endpointOrigin: TrimmedNonEmptyString,
  keys: PushSubscriptionKeys,
  label: NotificationLabel,
  userAgent: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  lastDeliveredAt: Schema.NullOr(IsoDateTime),
});
export type StoredMobilePushSubscription = typeof StoredMobilePushSubscription.Type;

export const ClaimNotificationDedupeKeyInput = Schema.Struct({
  dedupeKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  now: IsoDateTime,
});
export type ClaimNotificationDedupeKeyInput = typeof ClaimNotificationDedupeKeyInput.Type;

const ListSubscriptionsForSessionInput = Schema.Struct({ sessionId: AuthSessionId });
type ListSubscriptionsForSessionInput = typeof ListSubscriptionsForSessionInput.Type;

const ListDeliverableSubscriptionsInput = Schema.Struct({ now: IsoDateTime });
type ListDeliverableSubscriptionsInput = typeof ListDeliverableSubscriptionsInput.Type;

const DeleteSubscriptionForSessionInput = Schema.Struct({
  id: PushSubscriptionId,
  sessionId: AuthSessionId,
});
type DeleteSubscriptionForSessionInput = typeof DeleteSubscriptionForSessionInput.Type;

const DeleteSubscriptionByEndpointInput = Schema.Struct({ endpoint: TrimmedNonEmptyString });
type DeleteSubscriptionByEndpointInput = typeof DeleteSubscriptionByEndpointInput.Type;

const MarkSubscriptionGoneInput = Schema.Struct({ id: PushSubscriptionId });
type MarkSubscriptionGoneInput = typeof MarkSubscriptionGoneInput.Type;

const MarkSubscriptionDeliveredInput = Schema.Struct({
  id: PushSubscriptionId,
  deliveredAt: IsoDateTime,
});
type MarkSubscriptionDeliveredInput = typeof MarkSubscriptionDeliveredInput.Type;

const DeleteSubscriptionsForSessionInput = Schema.Struct({ sessionId: AuthSessionId });
type DeleteSubscriptionsForSessionInput = typeof DeleteSubscriptionsForSessionInput.Type;

const DeleteSubscriptionsForInactiveSessionsInput = Schema.Struct({ now: IsoDateTime });
type DeleteSubscriptionsForInactiveSessionsInput =
  typeof DeleteSubscriptionsForInactiveSessionsInput.Type;

const PruneNotificationDedupeInput = Schema.Struct({ cutoff: IsoDateTime });

const UpsertSubscriptionRowInput = Schema.Struct({
  id: PushSubscriptionId,
  ...UpsertMobilePushSubscriptionInput.fields,
});

const dedupeCutoffBefore = (now: string): string =>
  DateTime.formatIso(DateTime.subtractDuration(Duration.days(7))(DateTime.makeUnsafe(now)));

export class NotificationSubscriptionRepository extends Context.Service<
  NotificationSubscriptionRepository,
  {
    readonly upsertSubscription: (
      input: UpsertMobilePushSubscriptionInput,
    ) => Effect.Effect<StoredMobilePushSubscription, NotificationSubscriptionRepositoryError>;
    readonly listSubscriptionsForSession: (
      input: ListSubscriptionsForSessionInput,
    ) => Effect.Effect<
      ReadonlyArray<StoredMobilePushSubscription>,
      NotificationSubscriptionRepositoryError
    >;
    readonly listDeliverableSubscriptions: (
      input: ListDeliverableSubscriptionsInput,
    ) => Effect.Effect<
      ReadonlyArray<StoredMobilePushSubscription>,
      NotificationSubscriptionRepositoryError
    >;
    readonly deleteSubscriptionForSession: (
      input: DeleteSubscriptionForSessionInput,
    ) => Effect.Effect<boolean, NotificationSubscriptionRepositoryError>;
    readonly deleteSubscriptionByEndpoint: (
      input: DeleteSubscriptionByEndpointInput,
    ) => Effect.Effect<boolean, NotificationSubscriptionRepositoryError>;
    readonly markSubscriptionGone: (
      input: MarkSubscriptionGoneInput,
    ) => Effect.Effect<boolean, NotificationSubscriptionRepositoryError>;
    readonly markSubscriptionDelivered: (
      input: MarkSubscriptionDeliveredInput,
    ) => Effect.Effect<void, NotificationSubscriptionRepositoryError>;
    readonly deleteSubscriptionsForSession: (
      input: DeleteSubscriptionsForSessionInput,
    ) => Effect.Effect<ReadonlyArray<PushSubscriptionId>, NotificationSubscriptionRepositoryError>;
    readonly deleteSubscriptionsForInactiveSessions: (
      input: DeleteSubscriptionsForInactiveSessionsInput,
    ) => Effect.Effect<ReadonlyArray<PushSubscriptionId>, NotificationSubscriptionRepositoryError>;
    readonly claimNotificationDedupeKey: (
      input: ClaimNotificationDedupeKeyInput,
    ) => Effect.Effect<boolean, NotificationSubscriptionRepositoryError>;
  }
>()("cox/persistence/NotificationSubscriptions/NotificationSubscriptionRepository") {}

const MobilePushSubscriptionRawRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  endpoint: Schema.String,
  endpointOrigin: Schema.String,
  p256dh: Schema.String,
  authSecret: Schema.String,
  label: Schema.String,
  userAgent: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  lastDeliveredAt: Schema.NullOr(Schema.String),
});

const decodeStoredSubscription = Schema.decodeUnknownEffect(StoredMobilePushSubscription);

const toStoredSubscription = (row: typeof MobilePushSubscriptionRawRow.Type) =>
  decodeStoredSubscription({
    id: row.id,
    sessionId: row.sessionId,
    endpoint: row.endpoint,
    endpointOrigin: row.endpointOrigin,
    keys: { p256dh: row.p256dh, auth: row.authSecret },
    label: row.label,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastDeliveredAt: row.lastDeliveredAt,
  });

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): NotificationSubscriptionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const subscriptionSelectColumns = sql`
    s.id,
    s.session_id AS "sessionId",
    s.endpoint,
    s.endpoint_origin AS "endpointOrigin",
    s.p256dh,
    s.auth_secret AS "authSecret",
    s.label,
    s.user_agent AS "userAgent",
    s.created_at AS "createdAt",
    s.last_delivered_at AS "lastDeliveredAt"
  `;

  const upsertRow = SqlSchema.findOne({
    Request: UpsertSubscriptionRowInput,
    Result: MobilePushSubscriptionRawRow,
    execute: (input) => sql`
      INSERT INTO mobile_push_subscriptions (
        id,
        session_id,
        endpoint,
        endpoint_origin,
        p256dh,
        auth_secret,
        label,
        user_agent,
        created_at,
        last_delivered_at
      )
      VALUES (
        ${input.id},
        ${input.sessionId},
        ${input.endpoint},
        ${input.endpointOrigin},
        ${input.keys.p256dh},
        ${input.keys.auth},
        ${input.label},
        ${input.userAgent},
        ${input.createdAt},
        NULL
      )
      ON CONFLICT(endpoint) DO UPDATE SET
        session_id = excluded.session_id,
        endpoint_origin = excluded.endpoint_origin,
        p256dh = excluded.p256dh,
        auth_secret = excluded.auth_secret,
        label = excluded.label,
        user_agent = excluded.user_agent
      RETURNING
        id,
        session_id AS "sessionId",
        endpoint,
        endpoint_origin AS "endpointOrigin",
        p256dh,
        auth_secret AS "authSecret",
        label,
        user_agent AS "userAgent",
        created_at AS "createdAt",
        last_delivered_at AS "lastDeliveredAt"
    `,
  });

  const listRowsForSession = SqlSchema.findAll({
    Request: ListSubscriptionsForSessionInput,
    Result: MobilePushSubscriptionRawRow,
    execute: ({ sessionId }) => sql`
      SELECT ${subscriptionSelectColumns}
      FROM mobile_push_subscriptions AS s
      WHERE s.session_id = ${sessionId}
      ORDER BY s.created_at, s.id
    `,
  });

  const listDeliverableRows = SqlSchema.findAll({
    Request: ListDeliverableSubscriptionsInput,
    Result: MobilePushSubscriptionRawRow,
    execute: ({ now }) => sql`
      SELECT ${subscriptionSelectColumns}
      FROM mobile_push_subscriptions AS s
      JOIN auth_sessions AS a ON a.session_id = s.session_id
      WHERE a.revoked_at IS NULL
        AND a.expires_at > ${now}
      ORDER BY s.created_at, s.id
    `,
  });

  const deleteRowForSession = SqlSchema.findAll({
    Request: DeleteSubscriptionForSessionInput,
    Result: Schema.Struct({ id: PushSubscriptionId }),
    execute: ({ id, sessionId }) => sql`
      DELETE FROM mobile_push_subscriptions
      WHERE id = ${id}
        AND session_id = ${sessionId}
      RETURNING id
    `,
  });

  const deleteRowByEndpoint = SqlSchema.findAll({
    Request: DeleteSubscriptionByEndpointInput,
    Result: Schema.Struct({ id: PushSubscriptionId }),
    execute: ({ endpoint }) => sql`
      DELETE FROM mobile_push_subscriptions
      WHERE endpoint = ${endpoint}
      RETURNING id
    `,
  });

  const deleteRowById = SqlSchema.findAll({
    Request: MarkSubscriptionGoneInput,
    Result: Schema.Struct({ id: PushSubscriptionId }),
    execute: ({ id }) => sql`
      DELETE FROM mobile_push_subscriptions
      WHERE id = ${id}
      RETURNING id
    `,
  });

  const deleteRowsForSession = SqlSchema.findAll({
    Request: DeleteSubscriptionsForSessionInput,
    Result: Schema.Struct({ id: PushSubscriptionId }),
    execute: ({ sessionId }) => sql`
      DELETE FROM mobile_push_subscriptions
      WHERE session_id = ${sessionId}
      RETURNING id
    `,
  });

  const deleteRowsForInactiveSessions = SqlSchema.findAll({
    Request: DeleteSubscriptionsForInactiveSessionsInput,
    Result: Schema.Struct({ id: PushSubscriptionId }),
    execute: ({ now }) => sql`
      DELETE FROM mobile_push_subscriptions
      WHERE session_id IN (
        SELECT s.session_id
        FROM mobile_push_subscriptions AS s
        LEFT JOIN auth_sessions AS a ON a.session_id = s.session_id
        WHERE a.session_id IS NULL
          OR a.revoked_at IS NOT NULL
          OR a.expires_at <= ${now}
      )
      RETURNING id
    `,
  });

  const markDeliveredRow = SqlSchema.void({
    Request: MarkSubscriptionDeliveredInput,
    execute: ({ id, deliveredAt }) => sql`
      UPDATE mobile_push_subscriptions
      SET last_delivered_at = ${deliveredAt}
      WHERE id = ${id}
    `,
  });

  const pruneDedupeRows = SqlSchema.void({
    Request: PruneNotificationDedupeInput,
    execute: ({ cutoff }) => sql`
      DELETE FROM mobile_notification_dedupe
      WHERE created_at < ${cutoff}
    `,
  });

  const claimDedupeRow = SqlSchema.findAll({
    Request: ClaimNotificationDedupeKeyInput,
    Result: Schema.Struct({ dedupeKey: Schema.String }),
    execute: ({ dedupeKey, threadId, now }) => sql`
      INSERT INTO mobile_notification_dedupe (dedupe_key, thread_id, created_at)
      VALUES (${dedupeKey}, ${threadId}, ${now})
      ON CONFLICT(dedupe_key) DO NOTHING
      RETURNING dedupe_key AS "dedupeKey"
    `,
  });

  const upsertSubscription: NotificationSubscriptionRepository["Service"]["upsertSubscription"] = (
    input,
  ) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.flatMap((id) => upsertRow({ id: PushSubscriptionId.make(id), ...input })),
      Effect.flatMap(toStoredSubscription),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "NotificationSubscriptionRepository.upsertSubscription:query",
          "NotificationSubscriptionRepository.upsertSubscription:decodeRow",
          { sessionId: input.sessionId },
        ),
      ),
    );

  const listSubscriptionsForSession: NotificationSubscriptionRepository["Service"]["listSubscriptionsForSession"] =
    (input) =>
      listRowsForSession(input).pipe(
        NodeSqliteClient.readOnly,
        Effect.flatMap((rows) => Effect.forEach(rows, toStoredSubscription)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.listSubscriptionsForSession:query",
            "NotificationSubscriptionRepository.listSubscriptionsForSession:decodeRows",
            { sessionId: input.sessionId },
          ),
        ),
      );

  const listDeliverableSubscriptions: NotificationSubscriptionRepository["Service"]["listDeliverableSubscriptions"] =
    (input) =>
      listDeliverableRows(input).pipe(
        NodeSqliteClient.readOnly,
        Effect.flatMap((rows) => Effect.forEach(rows, toStoredSubscription)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.listDeliverableSubscriptions:query",
            "NotificationSubscriptionRepository.listDeliverableSubscriptions:decodeRows",
          ),
        ),
      );

  const deleteSubscriptionForSession: NotificationSubscriptionRepository["Service"]["deleteSubscriptionForSession"] =
    (input) =>
      deleteRowForSession(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.deleteSubscriptionForSession:query",
            "NotificationSubscriptionRepository.deleteSubscriptionForSession:encodeRequest",
            { sessionId: input.sessionId },
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );

  const deleteSubscriptionByEndpoint: NotificationSubscriptionRepository["Service"]["deleteSubscriptionByEndpoint"] =
    (input) =>
      deleteRowByEndpoint(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.deleteSubscriptionByEndpoint:query",
            "NotificationSubscriptionRepository.deleteSubscriptionByEndpoint:encodeRequest",
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );

  const markSubscriptionGone: NotificationSubscriptionRepository["Service"]["markSubscriptionGone"] =
    (input) =>
      deleteRowById(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.markSubscriptionGone:query",
            "NotificationSubscriptionRepository.markSubscriptionGone:encodeRequest",
          ),
        ),
        Effect.map((rows) => rows.length > 0),
      );

  const markSubscriptionDelivered: NotificationSubscriptionRepository["Service"]["markSubscriptionDelivered"] =
    (input) =>
      markDeliveredRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.markSubscriptionDelivered:query",
            "NotificationSubscriptionRepository.markSubscriptionDelivered:encodeRequest",
          ),
        ),
      );

  const deleteSubscriptionsForSession: NotificationSubscriptionRepository["Service"]["deleteSubscriptionsForSession"] =
    (input) =>
      deleteRowsForSession(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.deleteSubscriptionsForSession:query",
            "NotificationSubscriptionRepository.deleteSubscriptionsForSession:encodeRequest",
            { sessionId: input.sessionId },
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.id)),
      );

  const deleteSubscriptionsForInactiveSessions: NotificationSubscriptionRepository["Service"]["deleteSubscriptionsForInactiveSessions"] =
    (input) =>
      deleteRowsForInactiveSessions(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.deleteSubscriptionsForInactiveSessions:query",
            "NotificationSubscriptionRepository.deleteSubscriptionsForInactiveSessions:encodeRequest",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.id)),
      );

  const claimNotificationDedupeKey: NotificationSubscriptionRepository["Service"]["claimNotificationDedupeKey"] =
    (input) =>
      Effect.all([
        pruneDedupeRows({ cutoff: dedupeCutoffBefore(input.now) }),
        claimDedupeRow(input),
      ]).pipe(
        Effect.map(([, claimedRows]) => claimedRows.length > 0),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "NotificationSubscriptionRepository.claimNotificationDedupeKey:query",
            "NotificationSubscriptionRepository.claimNotificationDedupeKey:encodeRequest",
            { threadId: input.threadId },
          ),
        ),
      );

  return {
    upsertSubscription,
    listSubscriptionsForSession,
    listDeliverableSubscriptions,
    deleteSubscriptionForSession,
    deleteSubscriptionByEndpoint,
    markSubscriptionGone,
    markSubscriptionDelivered,
    deleteSubscriptionsForSession,
    deleteSubscriptionsForInactiveSessions,
    claimNotificationDedupeKey,
  } satisfies NotificationSubscriptionRepository["Service"];
});

export const layer = Layer.effect(NotificationSubscriptionRepository, make);
