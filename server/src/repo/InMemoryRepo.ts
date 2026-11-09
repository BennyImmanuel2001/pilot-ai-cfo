import {
  IRepo,
  QueryOptions,
  Transaction,
  GroupedResult,
  RecurringPayment,
  UpcomingBill,
  UserProfile,
  BalanceInfo,
  LiveSource,
  TransactionSource,
} from './types';
import { seedTransactions, userProfile } from '../data/seed';
import { startOfToday, daysBetween, ymd } from '../util/dates';

/**
 * Everyday words a model (or user) uses for a group of categories. "food" must cover groceries,
 * restaurants and delivery, not just the "food delivery" category whose name happens to contain it.
 */
const CATEGORY_ALIASES: Record<string, string[]> = {
  food: ['groceries', 'restaurants', 'food delivery'],
  'food and drink': ['groceries', 'restaurants', 'food delivery'],
  dining: ['restaurants', 'food delivery'],
  'eating out': ['restaurants', 'food delivery'],
  takeout: ['food delivery', 'restaurants'],
  grocery: ['groceries'],
  bills: ['rent', 'utilities', 'subscriptions'],
  housing: ['rent'],
  travel: ['transport'],
  gas: ['transport'],
  fuel: ['transport'],
  medical: ['health'],
};

export function categoryAliases(category: string): string[] {
  const key = category.trim().toLowerCase();
  return CATEGORY_ALIASES[key] ?? [key];
}

export class InMemoryRepo implements IRepo {
  private transactions: Transaction[];
  private seed: Transaction[];
  private live: Record<LiveSource, Transaction[]> = { paypal: [], pilot: [] };
  private _profile: UserProfile;
  private _balance: BalanceInfo;

  constructor() {
    this.seed = seedTransactions;
    this.transactions = seedTransactions;
    this._profile = { ...userProfile };
    this._balance = { value: userProfile.balance, source: 'seed' };
  }

  replaceSource(source: LiveSource, txns: Transaction[]): void {
    this.live[source] = txns.map(t => ({ ...t, source }));
    // A payment Pilot recorded at capture is the same PayPal transaction once Transaction Search
    // catches up; keep Pilot's record (it is the buyer-side spend) and drop the duplicate.
    const pilotIds = new Set(this.live.pilot.map(t => t.id));
    this.transactions = [...this.seed, ...this.live.pilot, ...this.live.paypal.filter(t => !pilotIds.has(t.id))];
  }

  getSource(source: LiveSource): Transaction[] {
    return [...this.live[source]];
  }

  countBySource(): Record<TransactionSource, number> {
    return { seed: this.seed.length, paypal: this.live.paypal.length, pilot: this.live.pilot.length };
  }

  setBalance(info: BalanceInfo): void {
    this._balance = { ...info, value: Math.round(info.value * 100) / 100 };
    this._profile = { ...this._profile, balance: this._balance.value };
  }

  balanceInfo(): BalanceInfo {
    return { ...this._balance };
  }

  profile(): UserProfile {
    return this._profile;
  }

  balance(): number {
    return this._profile.balance;
  }

  query(opts: QueryOptions): Transaction[] | GroupedResult[] {
    let txns = [...this.transactions];

    if (opts.category) {
      const wanted = categoryAliases(opts.category);
      txns = txns.filter(t => {
        const c = t.category.toLowerCase();
        return wanted.some(w => c.includes(w));
      });
    }
    if (opts.from) txns = txns.filter(t => t.date >= opts.from!);
    if (opts.to) txns = txns.filter(t => t.date <= opts.to!);

    if (!opts.groupBy) return txns;

    const groups = new Map<string, { total: number; count: number }>();

    if (opts.groupBy === 'month') {
      for (const t of txns) {
        const key = t.date.slice(0, 7);
        const g = groups.get(key) ?? { total: 0, count: 0 };
        g.total += t.amount;
        g.count++;
        groups.set(key, g);
      }
    } else if (opts.groupBy === 'category') {
      for (const t of txns) {
        const key = t.category;
        const g = groups.get(key) ?? { total: 0, count: 0 };
        g.total += t.amount;
        g.count++;
        groups.set(key, g);
      }
    } else if (opts.groupBy === 'merchant') {
      for (const t of txns) {
        const key = t.merchant;
        const g = groups.get(key) ?? { total: 0, count: 0 };
        g.total += t.amount;
        g.count++;
        groups.set(key, g);
      }
    }

    return Array.from(groups.entries())
      .map(([key, { total, count }]) => ({ key, total, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  recentTransactions(limit = 30): Transaction[] {
    return [...this.transactions]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, limit);
  }

  recurringPayments(): RecurringPayment[] {
    // Detect by recurring flag and deduplicate by merchant
    const seen = new Map<string, RecurringPayment>();
    const recurring = this.transactions.filter(t => t.recurring && t.amount < 0);

    // Transactions are sorted ascending, so the last write keeps the latest amount.
    for (const t of recurring) {
      seen.set(t.merchant, {
        merchant: t.merchant,
        category: t.category,
        amount: t.amount,
        cadence: 'monthly',
        method: t.method,
        dayOfMonth: parseInt(t.date.slice(8, 10), 10),
      });
    }
    return Array.from(seen.values());
  }

  upcomingBills(daysAhead = 30): UpcomingBill[] {
    const today = startOfToday();
    const bills: UpcomingBill[] = [];
    const recurring = this.recurringPayments();

    for (const r of recurring) {
      if (!r.dayOfMonth) continue;
      // Find next occurrence that hasn't been paid yet (strictly after today)
      for (let monthOffset = 0; monthOffset <= 1; monthOffset++) {
        const candidateDate = new Date(today.getFullYear(), today.getMonth() + monthOffset, r.dayOfMonth);
        const diffDays = daysBetween(today, candidateDate);
        if (diffDays > 0 && diffDays <= daysAhead) {
          bills.push({
            merchant: r.merchant,
            category: r.category,
            amount: r.amount,
            date: ymd(candidateDate),
            method: r.method,
          });
          break;
        }
      }
    }

    return bills.sort((a, b) => a.date.localeCompare(b.date));
  }
}
