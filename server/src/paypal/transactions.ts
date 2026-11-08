import type { IRepo, Transaction } from '../repo/types';
import { PayPalError, PayPalTransaction, isPayPalConfigured, searchTransactions } from './client';

/** Opt-in: pull the sandbox account's real activity into the dashboard next to the seed data. */
export const syncEnabled = ['1', 'true', 'yes'].includes((process.env.PAYPAL_SYNC_TRANSACTIONS || '').trim().toLowerCase());

const SYNC_EVERY_MS = 10 * 60 * 1000;
const WINDOW_DAYS = 31; // Transaction Search allows at most 31 days per request

export interface SyncState {
  enabled: boolean;
  lastSyncAt: string | null;
  count: number;
  error: string | null;
}

export const syncState: SyncState = { enabled: syncEnabled, lastSyncAt: null, count: 0, error: null };

/** Maps a Transaction Search row onto Pilot's transaction shape. Returns null for rows without an amount. */
export function toTransaction(row: PayPalTransaction): Transaction | null {
  const info = row.transaction_info;
  const value = Number(info?.transaction_amount?.value);
  if (!info?.transaction_id || !Number.isFinite(value) || value === 0) return null;
  const name = row.payer_info?.payer_name;
  const payer = name?.alternate_full_name || [name?.given_name, name?.surname].filter(Boolean).join(' ');
  const merchant = row.cart_info?.item_details?.[0]?.item_name || info.transaction_subject || payer || 'PayPal sandbox';
  return {
    id: `pp-${info.transaction_id}`,
    date: (info.transaction_initiation_date ?? new Date().toISOString()).slice(0, 10),
    merchant: merchant.slice(0, 60),
    category: value > 0 ? 'income' : 'shopping',
    amount: Math.round(value * 100) / 100,
    method: 'paypal',
    recurring: false,
    source: 'paypal',
  };
}

export async function syncPayPalTransactions(repo: IRepo): Promise<SyncState> {
  if (!isPayPalConfigured) {
    syncState.error = 'PayPal sandbox is not enabled (set PAYPAL_MODE=sandbox and the credentials).';
    return syncState;
  }
  try {
    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000 + 60_000);
    const rows = await searchTransactions(start, end);
    const txns = rows.map(toTransaction).filter((t): t is Transaction => t !== null);
    repo.replaceSource('paypal', txns);
    Object.assign(syncState, { lastSyncAt: new Date().toISOString(), count: txns.length, error: null });
    console.log(`[PayPal] Synced ${txns.length} sandbox transactions`);
  } catch (err) {
    const notAuthorized = err instanceof PayPalError && (err.status === 403 || err.issue === 'NOT_AUTHORIZED');
    syncState.error = notAuthorized
      ? 'Transaction Search is not enabled for this sandbox app (Developer Dashboard → your app → Features → Transaction search).'
      : err instanceof Error ? err.message : String(err);
    console.warn(`[PayPal] Transaction sync failed, keeping seed data only: ${syncState.error}`);
  }
  return syncState;
}

/** Initial sync plus a refresh every 10 minutes (Transaction Search itself lags up to ~3 hours). */
export function startTransactionSync(repo: IRepo): void {
  if (!syncEnabled) return;
  void syncPayPalTransactions(repo);
  setInterval(() => void syncPayPalTransactions(repo), SYNC_EVERY_MS).unref();
}
