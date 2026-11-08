import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
  Persistence,
} from "@t3tools/client-runtime/platform";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import { EnvironmentId, ServerConfig, ThreadId, VcsListRefsResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { projectFaviconCache } from "../assets/projectFaviconCache";

const DATABASE_NAME = "cox:connection-runtime";
const DATABASE_VERSION = 5;
const SHELL_STORE_NAME = "shell";
const THREAD_STORE_NAME = "thread";
const SERVER_CONFIG_STORE_NAME = "server-config";
const VCS_REFS_STORE_NAME = "vcs-refs";
const QUERY_STORE_NAME = "query";
const QUERY_UPDATED_INDEX_NAME = "environment-updated";
const QUERY_MAX_ROWS = 256;
const QUERY_MAX_BYTES = 32 * 1024 * 1024;
const QUERY_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const QUERY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const QUERY_PRUNE_BATCH_ROWS = 32;
const QUERY_PRUNE_BATCH_BYTES = 1024 * 1024;
const StoredShellSnapshot = StoredOrchestrationShellSnapshot;
const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);
const StoredThreadSnapshot = StoredOrchestrationThreadSnapshot;
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);
const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  config: ServerConfig,
});
const StoredServerConfigJson = Schema.fromJsonString(StoredServerConfig);
const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});
const StoredVcsRefsJson = Schema.fromJsonString(StoredVcsRefs);
const isStoredQuery = Schema.is(
  Schema.Struct({ environmentId: Schema.String, payload: Schema.String, updatedAt: Schema.Number }),
);
const isQueryBatch = Schema.is(Schema.Struct({ rows: Schema.Number, bytes: Schema.Number }));
const encodeStoredShellSnapshot = Schema.encodeEffect(StoredShellSnapshotJson);
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);
const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);
const decodeStoredServerConfig = Schema.decodeUnknownEffect(StoredServerConfigJson);
const encodeStoredServerConfig = Schema.encodeEffect(StoredServerConfigJson);
const decodeStoredVcsRefs = Schema.decodeUnknownEffect(StoredVcsRefsJson);
const encodeStoredVcsRefs = Schema.encodeEffect(StoredVcsRefsJson);

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

function persistenceError(
  operation:
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "load-server-config"
    | "save-server-config"
    | "load-vcs-refs"
    | "save-vcs-refs"
    | "remove-vcs-refs"
    | "clear-vcs-refs"
    | "clear-environment",
  cause: unknown,
) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

const openDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(catalogError("open", "IndexedDB is unavailable in this browser context.")),
      );
      return;
    }
    try {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(SHELL_STORE_NAME)) {
          request.result.createObjectStore(SHELL_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(THREAD_STORE_NAME)) {
          request.result.createObjectStore(THREAD_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(SERVER_CONFIG_STORE_NAME)) {
          request.result.createObjectStore(SERVER_CONFIG_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(VCS_REFS_STORE_NAME)) {
          request.result.createObjectStore(VCS_REFS_STORE_NAME);
        }
        if (!request.result.objectStoreNames.contains(QUERY_STORE_NAME)) {
          request.result
            .createObjectStore(QUERY_STORE_NAME)
            .createIndex(QUERY_UPDATED_INDEX_NAME, ["environmentId", "updatedAt", "bytes"]);
        }
      });
      request.addEventListener("error", () => {
        resume(Effect.fail(catalogError("open", request.error ?? "Unknown IndexedDB error")));
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("open", cause)));
    }
  });
});

interface DatabaseHandle {
  readonly get: Effect.Effect<IDBDatabase, ConnectionTransientError>;
  readonly invalidate: (database: IDBDatabase) => Effect.Effect<void>;
}

const makeDatabaseHandle = Effect.fn("web.connectionStorage.makeDatabaseHandle")(function* () {
  const lock = yield* Semaphore.make(1);
  let current: IDBDatabase | null = null;
  const forget = (database: IDBDatabase) => {
    if (current === database) current = null;
  };
  const get = Effect.suspend(() =>
    current !== null
      ? Effect.succeed(current)
      : lock.withPermits(1)(
          Effect.gen(function* () {
            if (current !== null) return current;
            const opened = yield* openDatabase();
            current = opened;
            opened.addEventListener("close", () => forget(opened));
            // Another tab upgrading the schema waits on this connection.
            opened.addEventListener("versionchange", () => {
              forget(opened);
              opened.close();
            });
            return opened;
          }),
        ),
  );
  const close = lock.withPermits(1)(
    Effect.sync(() => {
      current?.close();
      current = null;
    }),
  );
  const handle: DatabaseHandle = {
    get,
    invalidate: (database) => Effect.sync(() => forget(database)),
  };
  return { handle, close };
});

// Browsers can omit close events; retry InvalidStateError with a fresh connection.
function withDatabase<A>(
  database: DatabaseHandle,
  use: (opened: IDBDatabase) => Effect.Effect<A, ConnectionTransientError>,
) {
  const closedConnection = Symbol("closedConnection");
  const attempt = Effect.flatMap(database.get, (opened) =>
    use(opened).pipe(
      Effect.catchIf(
        (error) => error.detail.includes("InvalidStateError"),
        (error) =>
          database
            .invalidate(opened)
            .pipe(Effect.andThen(Effect.fail({ [closedConnection]: error } as const))),
      ),
    ),
  );
  return attempt.pipe(
    Effect.catchIf(
      (error): error is { readonly [closedConnection]: ConnectionTransientError } =>
        closedConnection in error,
      () => Effect.flatMap(database.get, use),
    ),
  );
}

function readDatabaseValueOnConnection(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    try {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.addEventListener("error", () => {
        resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
      });
      request.addEventListener("success", () => {
        resume(Effect.succeed(request.result));
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("read", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

function writeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      // Commit failures can fire abort without error; every failed write fires abort.
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).put(value, key);
    } catch (cause) {
      resume(Effect.fail(catalogError("write", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

function removeDatabaseValueOnConnection(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            catalogError("remove", transaction.error ?? "Unknown IndexedDB remove error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      transaction.objectStore(storeName).delete(key);
    } catch (cause) {
      resume(Effect.fail(catalogError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

function removeDatabaseValuesInRangeOnConnection(
  database: IDBDatabase,
  storeName: string,
  range: IDBKeyRange,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(
            catalogError("remove", transaction.error ?? "Unknown IndexedDB cursor error"),
          ),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      const request = transaction.objectStore(storeName).openCursor(range);
      request.addEventListener("error", () => {
        resume(
          Effect.fail(catalogError("remove", request.error ?? "Unknown IndexedDB cursor error")),
        );
      });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (cursor === null) {
          return;
        }
        try {
          cursor.delete();
          cursor.continue();
        } catch (cause) {
          resume(Effect.fail(catalogError("remove", cause)));
        }
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("remove", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

function saveQueryOnConnection(
  database: IDBDatabase,
  environmentId: EnvironmentId,
  key: string,
  payload: string,
  updatedAt: number,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    try {
      const bytes = new TextEncoder().encode(payload).length;
      const transaction = database.transaction(QUERY_STORE_NAME, "readwrite");
      transaction.addEventListener("abort", () => {
        resume(
          Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
        );
      });
      transaction.addEventListener("complete", () => {
        resume(Effect.void);
      });
      const store = transaction.objectStore(QUERY_STORE_NAME);
      if (bytes > QUERY_MAX_PAYLOAD_BYTES) {
        store.delete(queryCacheKey(environmentId, key));
        return;
      }
      store.put({ environmentId, payload, updatedAt, bytes }, queryCacheKey(environmentId, key));
      const batchKey = queryBatchKey(environmentId);
      const batchRequest = store.get(batchKey);
      batchRequest.addEventListener("success", () => {
        const batch: unknown = batchRequest.result;
        const rows = (isQueryBatch(batch) ? batch.rows : 0) + 1;
        const written = (isQueryBatch(batch) ? batch.bytes : 0) + bytes;
        if (
          isQueryBatch(batch) &&
          rows < QUERY_PRUNE_BATCH_ROWS &&
          written < QUERY_PRUNE_BATCH_BYTES
        ) {
          store.put({ rows, bytes: written }, batchKey);
          return;
        }
        store.put({ rows: 0, bytes: 0 }, batchKey);
        const request = store
          .index(QUERY_UPDATED_INDEX_NAME)
          .openKeyCursor(IDBKeyRange.bound([environmentId], [environmentId, []]), "prev");
        let kept = 0;
        let totalBytes = 0;
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (cursor === null) return;
          const [, rowUpdatedAt, rowBytes] = cursor.key as [string, number, number];
          kept += 1;
          totalBytes += rowBytes;
          if (
            kept > QUERY_MAX_ROWS - QUERY_PRUNE_BATCH_ROWS ||
            totalBytes > QUERY_MAX_BYTES - QUERY_PRUNE_BATCH_BYTES ||
            rowUpdatedAt < updatedAt - QUERY_MAX_AGE_MS
          ) {
            store.delete(cursor.primaryKey);
          }
          cursor.continue();
        });
      });
    } catch (cause) {
      resume(Effect.fail(catalogError("write", cause)));
    }
  }).pipe(Effect.withSpan("web.connectionStorage.saveQuery"));
}

function readDatabaseValue(database: DatabaseHandle, storeName: string, key: IDBValidKey) {
  return withDatabase(database, (opened) => readDatabaseValueOnConnection(opened, storeName, key));
}

function writeDatabaseValue(
  database: DatabaseHandle,
  storeName: string,
  key: IDBValidKey,
  value: unknown,
) {
  return withDatabase(database, (opened) =>
    writeDatabaseValueOnConnection(opened, storeName, key, value),
  );
}

function removeDatabaseValue(database: DatabaseHandle, storeName: string, key: IDBValidKey) {
  return withDatabase(database, (opened) =>
    removeDatabaseValueOnConnection(opened, storeName, key),
  );
}

function removeDatabaseValuesInRange(
  database: DatabaseHandle,
  storeName: string,
  range: IDBKeyRange,
) {
  return withDatabase(database, (opened) =>
    removeDatabaseValuesInRangeOnConnection(opened, storeName, range),
  );
}

function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

function queryCacheKey(environmentId: EnvironmentId, key: string) {
  return `${environmentId}:v1:${key}`;
}

function queryBatchKey(environmentId: EnvironmentId) {
  return `${environmentId}:batch`;
}

function vcsRefsCacheKey(environmentId: EnvironmentId, cwd: string) {
  return `${environmentId}:${cwd}`;
}

// MessageChannel yields without nested-timer clamping or background throttling.

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const { handle: database } = yield* Effect.acquireRelease(
      makeDatabaseHandle(),
      (owned) => owned.close,
    );
    const cacheStore = Persistence.EnvironmentCacheStore.of({
      loadShell: Effect.fn("Persistence.EnvironmentCacheStore.loadShell")(function (environmentId) {
        return readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.tap(() => Effect.promise(() => projectFaviconCache.hydrate())),
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeedNone;
            }
            return decodeOrDiscardOrchestrationCache(
              decodeStoredShellSnapshot(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-shell", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId
                    ? Option.some(stored.snapshot)
                    : Option.none(),
                ),
              ),
              removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            );
          }),
          Effect.mapError((cause) => persistenceError("load-shell", cause)),
        );
      }),
      saveShell: Effect.fn("storage.saveShell")(
        function* (environmentId, snapshot) {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded);
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-shell", cause),
        ),
      ),
      loadServerConfig: Effect.fn("Persistence.EnvironmentCacheStore.loadServerConfig")(
        function (environmentId) {
          return readDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId).pipe(
            Effect.flatMap((raw) => {
              if (typeof raw !== "string") {
                return Effect.succeedNone;
              }
              return decodeStoredServerConfig(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-server-config", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId
                    ? Option.some(stored.config)
                    : Option.none(),
                ),
              );
            }),
            Effect.mapError((cause) =>
              cause._tag === "ConnectionPersistenceError"
                ? cause
                : persistenceError("load-server-config", cause),
            ),
          );
        },
      ),
      saveServerConfig: Effect.fn("storage.saveServerConfig")(
        function* (environmentId, config) {
          const encoded = yield* encodeStoredServerConfig({
            schemaVersion: 1,
            environmentId,
            config,
          }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));
          yield* writeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId, encoded);
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-server-config", cause),
        ),
      ),
      loadThread: Effect.fn("Persistence.EnvironmentCacheStore.loadThread")(
        function (environmentId, threadId) {
          return readDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, threadId),
          ).pipe(
            Effect.flatMap((raw) => {
              if (typeof raw !== "string") {
                return Effect.succeedNone;
              }
              return decodeOrDiscardOrchestrationCache(
                decodeStoredThreadSnapshot(raw).pipe(
                  Effect.mapError((cause) => persistenceError("load-thread", cause)),
                  Effect.map((stored) =>
                    stored.environmentId === environmentId && stored.threadId === threadId
                      ? Option.some(stored.snapshot)
                      : Option.none(),
                  ),
                ),
                removeDatabaseValue(
                  database,
                  THREAD_STORE_NAME,
                  threadCacheKey(environmentId, threadId),
                ),
              );
            }),
            Effect.mapError((cause) => persistenceError("load-thread", cause)),
          );
        },
      ),
      saveThread: Effect.fn("storage.saveThread")(
        function* (environmentId, snapshot) {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
            environmentId,
            threadId: snapshot.projection.thread.id,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, snapshot.projection.thread.id),
            encoded,
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-thread", cause),
        ),
      ),
      loadVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.loadVcsRefs")(
        function (environmentId, cwd) {
          return readDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
          ).pipe(
            Effect.flatMap((raw) => {
              if (typeof raw !== "string") {
                return Effect.succeedNone;
              }
              return decodeStoredVcsRefs(raw).pipe(
                Effect.mapError((cause) => persistenceError("load-vcs-refs", cause)),
                Effect.map((stored) =>
                  stored.environmentId === environmentId && stored.cwd === cwd
                    ? Option.some(stored.refs)
                    : Option.none(),
                ),
              );
            }),
            Effect.mapError((cause) =>
              cause._tag === "ConnectionPersistenceError"
                ? cause
                : persistenceError("load-vcs-refs", cause),
            ),
          );
        },
      ),
      saveVcsRefs: Effect.fn("storage.saveVcsRefs")(
        function* (environmentId, cwd, refs) {
          const encoded = yield* encodeStoredVcsRefs({
            schemaVersion: 1,
            environmentId,
            cwd,
            refs,
          }).pipe(Effect.mapError((cause) => persistenceError("save-vcs-refs", cause)));
          yield* writeDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
            encoded,
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ConnectionPersistenceError"
            ? cause
            : persistenceError("save-vcs-refs", cause),
        ),
      ),
      removeVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.removeVcsRefs")(
        function (environmentId, cwd) {
          return removeDatabaseValue(
            database,
            VCS_REFS_STORE_NAME,
            vcsRefsCacheKey(environmentId, cwd),
          ).pipe(Effect.mapError((cause) => persistenceError("remove-vcs-refs", cause)));
        },
      ),
      clearVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.clearVcsRefs")(
        function (environmentId) {
          return removeDatabaseValuesInRange(
            database,
            VCS_REFS_STORE_NAME,
            IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
          ).pipe(Effect.mapError((cause) => persistenceError("clear-vcs-refs", cause)));
        },
      ),
      removeThread: Effect.fn("Persistence.EnvironmentCacheStore.removeThread")(
        function (environmentId, threadId) {
          return removeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, threadId),
          ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause)));
        },
      ),
      clear: Effect.fn("Persistence.EnvironmentCacheStore.clear")(function (environmentId) {
        return Effect.all(
          [
            Effect.promise(() => projectFaviconCache.clearEnvironment(environmentId)),
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              VCS_REFS_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValuesInRange(
              database,
              QUERY_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause)));
      }),
    });

    const queryStore: NonNullable<typeof EnvironmentQueryStore.Service> = {
      load: Effect.fn("EnvironmentQueryStore.load")(
        function* (environmentId, key) {
          const stored = yield* readDatabaseValue(
            database,
            QUERY_STORE_NAME,
            queryCacheKey(environmentId, key),
          );
          const now = yield* Clock.currentTimeMillis;
          return isStoredQuery(stored) &&
            stored.environmentId === environmentId &&
            stored.updatedAt >= now - QUERY_MAX_AGE_MS
            ? Option.some(stored.payload)
            : Option.none();
        },
        Effect.catch(() => Effect.succeedNone),
      ),
      save: (environmentId, key, payload) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            withDatabase(database, (opened) =>
              saveQueryOnConnection(opened, environmentId, key, payload, now),
            ),
          ),
          Effect.catch(() => Effect.logWarning("Offline query database save failed")),
        ),
    };
    return Context.make(Persistence.EnvironmentCacheStore, cacheStore).pipe(
      Context.add(EnvironmentQueryStore, queryStore),
    );
  }),
);
