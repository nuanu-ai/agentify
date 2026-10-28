/**
 * How much of one kind of work each merchant has under way. A caller with no
 * place waits in line for at most the time it is given and is then turned
 * away; places go to callers in the order they came. A caller may name the
 * payer it acts for: one payer holds at most one place and one place in line
 * per merchant, so holding more places takes more payers. A merchant with
 * nothing under way and nobody waiting is forgotten, so the gate holds only
 * merchants with live work, whatever identifiers callers present.
 */

interface Waiter {
  readonly payer: string | undefined;
  readonly admit: (leave: () => void) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Line {
  /** Places taken and not yet given back. */
  active: number;
  /** Places handed out within the last second, where the gate bounds a rate. */
  recent: number;
  /** The payers holding a place now. */
  readonly holding: Set<string>;
  readonly waiting: Waiter[];
}

/**
 * Why a caller got no place: the merchant's places and line stayed taken, or
 * the payer it acts for already has a payment of its own in this line.
 */
export type NoPlace = "full" | "payer";

export interface GateLimits {
  /** How many places one merchant may hold at once. */
  readonly atOnce: number;
  /** How many places one merchant may be handed within any one second, where bounded. */
  readonly perSecond?: number;
  /** How many callers may wait in one merchant's line; one more is turned away at once. */
  readonly waitingAtMost: number;
}

export class MerchantGate {
  readonly #lines = new Map<string, Line>();
  readonly #limits: GateLimits;

  constructor(limits: GateLimits) {
    this.#limits = limits;
  }

  /**
   * A place for one piece of this merchant's work, or why none came within
   * `waitMs`. A payer already waiting in this line is turned away at once, and
   * one holding a place waits until it gives that place back; either is the
   * payer's refusal, unless the merchant's places were taken as well. The
   * function returned gives the place back; calling it twice gives back one
   * place.
   */
  enter(merchantId: string, waitMs: number, payer?: string): Promise<(() => void) | NoPlace> {
    const line = this.#lineOf(merchantId);
    const alreadyWaiting = payer !== undefined && line.waiting.some((one) => one.payer === payer);
    if (
      !alreadyWaiting &&
      this.#admissible(line, payer) &&
      !line.waiting.some((one) => this.#admissible(line, one.payer))
    ) {
      return Promise.resolve(this.#admit(merchantId, line, payer));
    }
    if (alreadyWaiting) return Promise.resolve("payer");
    if (waitMs <= 0 || line.waiting.length >= this.#limits.waitingAtMost) {
      this.#forgetIfIdle(merchantId, line);
      return Promise.resolve("full");
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        payer,
        admit: resolve,
        timer: setTimeout(() => {
          const place = line.waiting.indexOf(waiter);
          if (place >= 0) line.waiting.splice(place, 1);
          this.#forgetIfIdle(merchantId, line);
          resolve(this.#admissible(line, undefined) ? "payer" : "full");
        }, waitMs),
      };
      line.waiting.push(waiter);
    });
  }

  #lineOf(merchantId: string): Line {
    const known = this.#lines.get(merchantId);
    if (known !== undefined) return known;
    const line: Line = { active: 0, recent: 0, holding: new Set(), waiting: [] };
    this.#lines.set(merchantId, line);
    return line;
  }

  /** Whether a caller for `payer` could take a place in this line now. */
  #admissible(line: Line, payer: string | undefined): boolean {
    const { atOnce, perSecond } = this.#limits;
    return (
      line.active < atOnce &&
      (perSecond === undefined || line.recent < perSecond) &&
      (payer === undefined || !line.holding.has(payer))
    );
  }

  #admit(merchantId: string, line: Line, payer: string | undefined): () => void {
    line.active += 1;
    if (payer !== undefined) line.holding.add(payer);
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
      if (payer !== undefined) line.holding.delete(payer);
      this.#next(merchantId, line);
    };
  }

  /** Lets in, in the order they came, the waiters that can take a place now. */
  #next(merchantId: string, line: Line): void {
    let place = 0;
    while (place < line.waiting.length) {
      const waiter = line.waiting[place];
      if (waiter === undefined || !this.#admissible(line, waiter.payer)) {
        place += 1;
        continue;
      }
      line.waiting.splice(place, 1);
      clearTimeout(waiter.timer);
      waiter.admit(this.#admit(merchantId, line, waiter.payer));
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
