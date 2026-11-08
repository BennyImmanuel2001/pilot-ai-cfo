import {
  IRepo,
  QueryOptions,
  Transaction,
  GroupedResult,
  RecurringPayment,
  UpcomingBill,
  UserProfile,
} from './types';
import { seedTransactions, userProfile } from '../data/seed';
import { startOfToday, daysBetween, ymd } from '../util/dates';

export class InMemoryRepo implements IRepo {
  private transactions: Transaction[];
  private seed: Transaction[];
  private live: Transaction[] = [];
  private _profile: UserProfile;

  constructor() {
    this.seed = seedTransactions;
    this.transactions = seedTransactions;
    this._profile = userProfile;
  }

  replaceSource(_source: 'paypal', txns: Transaction[]): void {
    this.live = txns.map(t => ({ ...t, source: 'paypal' as const }));
    this.transactions = [...this.seed, ...this.live];
  }

  countBySource(): { seed: number; paypal: number } {
    return { seed: this.seed.length, paypal: this.live.length };
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
      const cat = opts.category.toLowerCase();
      txns = txns.filter(t => t.category.toLowerCase().includes(cat));
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
