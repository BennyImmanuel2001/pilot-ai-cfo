export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  merchant: string;
  category: string;
  amount: number; // negative = spend, positive = income
  method: 'paypal' | 'card' | 'bank';
  recurring: boolean;
  /**
   * `seed` = generated demo data; `paypal` = synced from the PayPal sandbox account (Transaction Search);
   * `pilot` = a payment completed in Pilot (recorded at capture, before Transaction Search shows it).
   */
  source?: TransactionSource;
}

export type TransactionSource = 'seed' | 'paypal' | 'pilot';
export type LiveSource = Exclude<TransactionSource, 'seed'>;

/** Where the current balance came from. */
export interface BalanceInfo {
  value: number;
  source: 'seed' | 'paypal';
  /** When it was read from PayPal (ISO), if it came from PayPal. */
  asOf?: string;
}

export interface UserProfile {
  name: string;
  monthlyIncome: number;
  balance: number;
  paydayOfMonth: number;
}

export interface QueryOptions {
  category?: string;
  from?: string;
  to?: string;
  groupBy?: 'month' | 'category' | 'merchant';
}

export interface GroupedResult {
  key: string;
  total: number;
  count: number;
}

export interface RecurringPayment {
  merchant: string;
  category: string;
  amount: number;
  cadence: 'monthly' | 'weekly';
  method: 'paypal' | 'card' | 'bank';
  dayOfMonth?: number;
}

export interface UpcomingBill {
  merchant: string;
  category: string;
  amount: number;
  date: string;
  method: 'paypal' | 'card' | 'bank';
}

export interface CashflowPoint {
  date: string;
  balance: number;
}

export interface CashflowEvent {
  date: string;
  label: string;
  amount: number;
}

export interface IRepo {
  query(opts: QueryOptions): Transaction[] | GroupedResult[];
  recurringPayments(): RecurringPayment[];
  balance(): number;
  upcomingBills(daysAhead: number): UpcomingBill[];
  profile(): UserProfile;
  recentTransactions(limit: number): Transaction[];
  /** Replaces all transactions from `source` with `txns` (idempotent re-sync). */
  replaceSource(source: LiveSource, txns: Transaction[]): void;
  /** Transactions from a live source (for persistence). */
  getSource(source: LiveSource): Transaction[];
  countBySource(): Record<TransactionSource, number>;
  /** Sets the current balance (from PayPal, or a restored snapshot). */
  setBalance(info: BalanceInfo): void;
  balanceInfo(): BalanceInfo;
}
