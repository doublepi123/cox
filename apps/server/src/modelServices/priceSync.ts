import { ModelServiceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { redactServerSettingsForClient, ServerSettingsService } from "../serverSettings.ts";
import { fetchModelsDevCatalog, syncModelPriceFromModelsDev } from "./modelsDev.ts";

export const syncModelServicePrices = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const current = redactServerSettingsForClient(yield* settings.getSettings);
  const services = Object.entries(current.modelServices).filter(
    ([, service]) => service.enabled && service.models.length > 0,
  );
  if (!services.length) return;
  const catalog = yield* fetchModelsDevCatalog;
  for (const [id, service] of services) {
    const models = service.models.map((model) =>
      syncModelPriceFromModelsDev(model, catalog, service.baseUrl),
    );
    if (models.some((model, index) => model !== service.models[index])) {
      yield* settings
        .updateSettings({
          modelServices: { [ModelServiceId.make(id)]: { ...service, models } },
        })
        .pipe(Effect.ignore);
    }
  }
});

export const layerModelServicePriceSync = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    yield* settings.ready.pipe(
      Effect.andThen(
        syncModelServicePrices.pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 day"))),
      ),
      Effect.forkScoped,
    );
  }),
);
