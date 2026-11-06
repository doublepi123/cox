import type { ModelServiceTestResult } from "@t3tools/contracts";

interface ModelTestState {
  readonly running: boolean;
  readonly total: number;
  readonly active: ReadonlySet<string>;
  readonly results: ReadonlyMap<string, ModelServiceTestResult>;
  readonly error: string | null;
}

const initial = (): ModelTestState => ({
  running: false,
  total: 0,
  active: new Set(),
  results: new Map(),
  error: null,
});

export function createModelServiceTestRunner() {
  let state = initial();
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ModelTestState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation++;
    publish({ ...state, running: false, active: new Set() });
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel,
    clear: () => {
      generation++;
      publish(initial());
    },
    async run(
      modelIds: readonly string[],
      revision: number,
      test: (id: string) => Promise<ModelServiceTestResult>,
    ) {
      if (state.running || !modelIds.length) return;
      const current = ++generation;
      const ids = [...new Set(modelIds)];
      let next = 0;
      publish({ ...initial(), running: true, total: ids.length });
      const worker = async () => {
        while (next < ids.length) {
          if (generation !== current) return;
          const id = ids[next++]!;
          publish({ ...state, active: new Set([...state.active, id]) });
          try {
            const result = await test(id);
            if (generation !== current) return;
            if (result.modelId !== id || result.revision !== revision)
              throw new Error("The model service changed. Test its current settings again.");
            const active = new Set(state.active);
            active.delete(id);
            publish({ ...state, active, results: new Map([...state.results, [id, result]]) });
          } catch {
            if (generation !== current) return;
            cancel();
            publish({
              ...state,
              error:
                "The model test could not finish. Check the connection and saved settings, then retry.",
            });
            return;
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (generation === current) publish({ ...state, running: false, active: new Set() });
    },
  };
}
