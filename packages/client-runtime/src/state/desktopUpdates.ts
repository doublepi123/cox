export function createDesktopUpdateStore<State>(
  connect: (receive: (state: State) => void) => (() => void) | undefined,
) {
  let snapshot: State | null = null;
  let disconnect: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const receive = (state: State) => {
    snapshot = state;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    receive,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) disconnect = connect(receive);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          disconnect?.();
          disconnect = undefined;
          snapshot = null;
        }
      };
    },
  };
}
