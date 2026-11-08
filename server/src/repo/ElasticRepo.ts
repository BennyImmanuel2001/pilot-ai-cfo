import {
  IRepo,
  QueryOptions,
  Transaction,
  GroupedResult,
  RecurringPayment,
  UpcomingBill,
  UserProfile,
} from './types';
import { InMemoryRepo } from './InMemoryRepo';
import { seedTransactions, userProfile } from '../data/seed';
import { fetchText, markFailed, markOk } from '../status';

const ELASTIC_INDEX = 'pilot-transactions';
const TIMEOUT_MS = 5_000;

export class ElasticRepo implements IRepo {
  private url: string;
  private apiKey: string;
  private fallback: InMemoryRepo;
  private ready = false;

  constructor(url: string, apiKey: string) {
    this.url = url.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fallback = new InMemoryRepo();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `ApiKey ${this.apiKey}`;
    return h;
  }

  /** True once the seed data is confirmed indexed. Otherwise every read is served from memory. */
  get isLive(): boolean {
    return this.ready;
  }

  async init(): Promise<void> {
    try {
      // Create the index; 400 resource_already_exists is fine.
      const created = await fetchText(`${this.url}/${ELASTIC_INDEX}`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          mappings: {
            properties: {
              date: { type: 'date' },
              merchant: { type: 'keyword' },
              category: { type: 'keyword' },
              amount: { type: 'double' },
              method: { type: 'keyword' },
              recurring: { type: 'boolean' },
            },
          },
        }),
      }, TIMEOUT_MS);
      if (!created.ok && !created.text.includes('resource_already_exists_exception')) {
        throw new Error(`create index failed: ${created.status} ${created.text.slice(0, 160)}`);
      }

      const lines = seedTransactions.flatMap(t => [
        JSON.stringify({ index: { _index: ELASTIC_INDEX, _id: t.id } }),
        JSON.stringify(t),
      ]).join('\n') + '\n';

      const bulk = await fetchText(`${this.url}/_bulk`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/x-ndjson' },
        body: lines,
      }, TIMEOUT_MS);
      if (!bulk.ok) throw new Error(`bulk index failed: ${bulk.status} ${bulk.text.slice(0, 160)}`);
      if ((JSON.parse(bulk.text) as { errors?: boolean }).errors) throw new Error('bulk index reported item errors');

      this.ready = true;
      markOk('elastic');
      console.log('[Elastic] Indexed', seedTransactions.length, 'transactions');
    } catch (err) {
      markFailed('elastic', err);
      console.warn(`[Elastic] Init failed, serving seed data from memory: ${err instanceof Error ? err.message : err}`);
    }
  }

  profile(): UserProfile {
    return userProfile;
  }

  balance(): number {
    return userProfile.balance;
  }

  query(opts: QueryOptions): Transaction[] | GroupedResult[] {
    // Fall back to in-memory — Elastic aggregations are async and repo interface is sync
    // In production you'd use async aggregation queries via the _search API
    return this.fallback.query(opts);
  }

  replaceSource(source: 'paypal', txns: Transaction[]): void {
    // Reads are served from memory (see query()), so synced sandbox transactions live there too.
    this.fallback.replaceSource(source, txns);
  }

  countBySource(): { seed: number; paypal: number } {
    return this.fallback.countBySource();
  }

  recentTransactions(limit: number): Transaction[] {
    return this.fallback.recentTransactions(limit);
  }

  recurringPayments(): RecurringPayment[] {
    return this.fallback.recurringPayments();
  }

  upcomingBills(daysAhead: number): UpcomingBill[] {
    return this.fallback.upcomingBills(daysAhead);
  }
}
