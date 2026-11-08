import type { IRepo, Transaction } from '../repo/types';
import { PayPalError, PayPalTransaction, getBalance, isPayPalConfigured, searchTransactions } from './client';

/**
 * In sandbox mode Pilot loads the account's transactions and balance on every start, unless
 * PAYPAL_SYNC_TRANSACTIONS=false. Simulate mode never calls PayPal.
 */
const syncSetting = (process.env.PAYPAL_SYNC_TRANSACTIONS || '').trim().toLowerCase();
export const syncEnabled = isPayPalConfigured && !['0', 'false', 'no', 'off'].includes(syncSetting);

const SYNC_EVERY_MS = 10 * 60 * 1000;
const WINDOW_DAYS = 31; // Transaction Search allows at most 31 days per request

export interface SyncState {
  enabled: boolean;
  lastSyncAt: string | null;
  count: number;
  /** Live balance read at the last successful sync, or null if it could not be read. */
  balance: number | null;
  error: string | null;
}

export const syncState: SyncState = { enabled: syncEnabled, lastSyncAt: null, count: 0, balance: null, error: null };

/** Called after every successful sync (used to persist the new data). */
let afterSync: (() => void) | null = null;
export const onSynced = (fn: () => void) => { afterSync = fn; };

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
    const [rows, balance] = await Promise.all([searchTransactions(start, end), getBalance()]);
    const txns = rows.map(toTransaction).filter((t): t is Transaction => t !== null);
    const asOf = new Date().toISOString();
    repo.replaceSource('paypal', txns);
    if (balance !== null) repo.setBalance({ value: balance, source: 'paypal', asOf });
    Object.assign(syncState, { lastSyncAt: asOf, count: txns.length, balance, error: null });
    console.log(`[PayPal] Synced ${txns.length} sandbox transactions, balance ${balance ?? 'unavailable'}`);
    afterSync?.();
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
