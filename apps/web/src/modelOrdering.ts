import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderInstanceOrderable {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly isDefault: boolean;
}

const DEFAULT_DRIVER_ORDER = new Map(
  providerClients.definitions.map((definition, index) => [definition.driverKind, index] as const),
);

export function orderProviderInstances<Entry extends ProviderInstanceOrderable>(
  entries: ReadonlyArray<Entry>,
  providerInstanceOrder: ReadonlyArray<ProviderInstanceId> = [],
): ReadonlyArray<Entry> {
  const entriesById = new Map(entries.map((entry) => [entry.instanceId, entry] as const));
  const ordered: Entry[] = [];
  for (const instanceId of providerInstanceOrder) {
    const entry = entriesById.get(instanceId);
    if (entry === undefined || ordered.includes(entry)) continue;
    ordered.push(entry);
  }

  const orderedIds = new Set(ordered.map((entry) => entry.instanceId));
  const driverOrder = new Map(DEFAULT_DRIVER_ORDER);
  for (const entry of entries) {
    if (!driverOrder.has(entry.driverKind)) driverOrder.set(entry.driverKind, driverOrder.size);
  }
  const originalOrder = new Map(entries.map((entry, index) => [entry.instanceId, index] as const));
  const remaining = entries
    .filter((entry) => !orderedIds.has(entry.instanceId))
    .toSorted((left, right) => {
      const driverDifference =
        (driverOrder.get(left.driverKind) ?? 0) - (driverOrder.get(right.driverKind) ?? 0);
      if (driverDifference !== 0) return driverDifference;
      if (left.isDefault !== right.isDefault)
        return Number(right.isDefault) - Number(left.isDefault);
      return (originalOrder.get(left.instanceId) ?? 0) - (originalOrder.get(right.instanceId) ?? 0);
    });
  return [...ordered, ...remaining];
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const instanceOrder = new Map(
    Arr.map(options?.instanceOrder ?? [], (instanceId, index) => [instanceId, index] as const),
  );
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}
