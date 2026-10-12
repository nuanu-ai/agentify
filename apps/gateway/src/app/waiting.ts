/**
 * Callers parked until an answer arrives on another connection: an agent buying
 * a synchronous product waits for the merchant's handler, and a purchase with a
 * live price waits for the merchant to name it. Parked callers live in this
 * process's memory and do not survive a restart; with a second gateway process
 * an answer could reach the one where nobody waits, so this has to move into
 * the queue before there are two. Waking with nothing is an ordinary answer, a
 * silence for the caller to interpret, not a failure.
 */

interface Waiter<T> {
  readonly resolve: (value: T | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class Waiting<T> {
  readonly #parked = new Map<string, Set<Waiter<T>>>();

  /**
   * Parks under `key` until somebody answers, or answers with nothing when
   * `waitMs` runs out. One answer wakes every caller parked under the key, so a
   * buyer's retry that raced the first request receives the goods as well.
   */
  wait(key: string, waitMs: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const set = this.#parked.get(key) ?? new Set<Waiter<T>>();
      this.#parked.set(key, set);

      const waiter: Waiter<T> = {
        resolve,
        timer: setTimeout(
          () => {
            set.delete(waiter);
            if (set.size === 0) {
              this.#parked.delete(key);
            }
            resolve(null);
          },
          Math.max(waitMs, 0),
        ),
      };
      set.add(waiter);
    });
  }

  /**
   * Answers everybody parked under `key`, and says whether anybody was: a
   * merchant who set stock aside against a price question learns from it
   * whether to release what he held.
   */
  answer(key: string, value: T): boolean {
    return this.#wakeAll(key, value);
  }

  /** Nobody is going to answer these; wake them with nothing. */
  giveUp(key: string): void {
    this.#wakeAll(key, null);
  }

  /** Wakes everybody with nothing. Used when the gateway is shutting down. */
  giveUpAll(): void {
    for (const key of [...this.#parked.keys()]) {
      this.#wakeAll(key, null);
    }
  }

  #wakeAll(key: string, value: T | null): boolean {
    const set = this.#parked.get(key);
    if (set === undefined || set.size === 0) {
      return false;
    }
    this.#parked.delete(key);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
    return true;
  }
}

/**
 * The key a purchase is parked under: the order and the owner the payment layer
 * says paid. Keyed by the order alone, another buyer holding the same order id
 * would share the payer's park, and in the synchronous mode the goods reach an
 * agent through that park and nowhere else.
 */
export function purchaseOf(orderId: string, owner: string): string {
  return `${orderId}#${owner}`;
}
