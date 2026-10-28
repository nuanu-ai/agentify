/**
 * How much of one kind of work each merchant has under way. A caller with no
 * place waits in line for at most the time it is given and is then turned
 * away; places go to callers in the order they came. A merchant with nothing
 * under way and nobody waiting is forgotten, so the gate holds only merchants
 * with live work, whatever identifiers callers present.
 */

interface Waiter {
  readonly admit: (leave: () => void) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Line {
  /** Places taken and not yet given back. */
  active: number;
  /** Places handed out within the last second, where the gate bounds a rate. */
  recent: number;
  readonly waiting: Waiter[];
}

export interface GateLimits {
  /** How many places one merchant may hold at once. */
  readonly atOnce: number;
  /** How many places one merchant may be handed within any one second, where bounded. */
  readonly perSecond?: number;
}

export class MerchantGate {
  readonly #lines = new Map<string, Line>();
  readonly #limits: GateLimits;

  constructor(limits: GateLimits) {
    this.#limits = limits;
  }

  /**
   * A place for one piece of this merchant's work, or null when none came
   * within `waitMs`. The function returned gives the place back; calling it
   * twice gives back one place.
   */
  enter(merchantId: string, waitMs: number): Promise<(() => void) | null> {
    const line = this.#lineOf(merchantId);
    if (line.waiting.length === 0 && this.#fits(line)) {
      return Promise.resolve(this.#admit(merchantId, line));
    }
    if (waitMs <= 0) {
      this.#forgetIfIdle(merchantId, line);
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        admit: resolve,
        timer: setTimeout(() => {
          const place = line.waiting.indexOf(waiter);
          if (place >= 0) line.waiting.splice(place, 1);
          this.#forgetIfIdle(merchantId, line);
          resolve(null);
        }, waitMs),
      };
      line.waiting.push(waiter);
    });
  }

  #lineOf(merchantId: string): Line {
    const known = this.#lines.get(merchantId);
    if (known !== undefined) return known;
    const line: Line = { active: 0, recent: 0, waiting: [] };
    this.#lines.set(merchantId, line);
    return line;
  }

  #fits(line: Line): boolean {
    const { atOnce, perSecond } = this.#limits;
    return line.active < atOnce && (perSecond === undefined || line.recent < perSecond);
  }

  #admit(merchantId: string, line: Line): () => void {
    line.active += 1;
    if (this.#limits.perSecond !== undefined) {
      line.recent += 1;
      // A second measured from each admission, so a burst at the edge of one
      // second cannot double up with the start of the next.
      setTimeout(() => {
        line.recent -= 1;
        this.#next(merchantId, line);
      }, 1_000).unref();
    }
    let given = false;
    return () => {
      if (given) return;
      given = true;
      line.active -= 1;
      this.#next(merchantId, line);
    };
  }

  #next(merchantId: string, line: Line): void {
    while (line.waiting.length > 0 && this.#fits(line)) {
      const waiter = line.waiting.shift();
      if (waiter === undefined) break;
      clearTimeout(waiter.timer);
      waiter.admit(this.#admit(merchantId, line));
    }
    this.#forgetIfIdle(merchantId, line);
  }

  #forgetIfIdle(merchantId: string, line: Line): void {
    if (
      line.active === 0 &&
      line.recent === 0 &&
      line.waiting.length === 0 &&
      this.#lines.get(merchantId) === line
    ) {
      this.#lines.delete(merchantId);
    }
  }
}
