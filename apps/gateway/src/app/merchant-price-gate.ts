/** The worker handles four envelopes; unpaid questions get no extra backlog. */
const PRICE_QUESTIONS_AT_ONCE = 4;
/** A loose burst bound, independent of how quickly a merchant answers. */
const PRICE_QUESTIONS_PER_SECOND = 16;

interface MerchantWork {
  active: number;
  windowAt: number;
  admitted: number;
}

/** Bounds price work per merchant; a buyer thinking about a price holds no place. */
export class MerchantPriceGate {
  readonly #merchants = new Map<string, MerchantWork>();

  enter(merchantId: string, at: number): (() => void) | null {
    const work = this.#merchants.get(merchantId) ?? { active: 0, windowAt: at, admitted: 0 };
    if (at - work.windowAt >= 1000) {
      work.windowAt = at;
      work.admitted = 0;
    }
    if (work.active >= PRICE_QUESTIONS_AT_ONCE || work.admitted >= PRICE_QUESTIONS_PER_SECOND) {
      return null;
    }
    work.active += 1;
    work.admitted += 1;
    this.#merchants.set(merchantId, work);
    return () => {
      work.active -= 1;
    };
  }
}
