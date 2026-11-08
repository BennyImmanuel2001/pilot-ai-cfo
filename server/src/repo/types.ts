export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  merchant: string;
  category: string;
  amount: number; // negative = spend, positive = income
  method: 'paypal' | 'card' | 'bank';
  recurring: boolean;
  /** `seed` = generated demo data; `paypal` = synced from the PayPal sandbox account (Transaction Search). */
  source?: 'seed' | 'paypal';
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
  replaceSource(source: 'paypal', txns: Transaction[]): void;
  countBySource(): { seed: number; paypal: number };
}
