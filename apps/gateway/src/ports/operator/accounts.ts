/**
 * The reads the workspace's Accounts and one account's page make about the
 * merchants accounts name: the seller name each merchant chose, and how much
 * money history a merchant has, which decides whether its account can be
 * forgotten on the test channel.
 */

/** A merchant an account names, as Accounts draws it; null where it chose no seller name. */
interface NamedMerchant {
  readonly id: string;
  readonly serviceName: string | null;
}

/** What a merchant has that is never deleted to make a test repeatable. */
export interface MoneyHistory {
  readonly orders: number;
  readonly receipts: number;
}

export interface OperatorAccounts {
  /** The merchants among `ids` the channel holds; an identifier it does not hold is left out. */
  merchantsNamed(ids: readonly string[]): Promise<readonly NamedMerchant[]>;
  /** How many orders and receipts one merchant has; none for a merchant the channel does not hold. */
  historyOf(merchantId: string): Promise<MoneyHistory>;
}
