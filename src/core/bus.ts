// Minimal typed event bus. Listeners are isolated: one throwing never breaks the rest.

type Listener<T> = (payload: T) => void;

export class Bus<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as Listener<Events[K]>)(payload);
      } catch (e) {
        console.error(`[bus] listener for ${String(event)} threw`, e);
      }
    }
  }
}
