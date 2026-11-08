import fs from 'fs';
import path from 'path';
import type { PendingAction } from './agent/tools';
import type { BalanceInfo, IRepo, Transaction } from './repo/types';

/**
 * Small JSON file store so a restart continues where the last run stopped: proposals with their
 * PayPal status, payments completed in Pilot, the last PayPal sync and the balance.
 *
 * On Render's free plan the disk is reset on every deploy and whenever the service sleeps
 * (after ~15 minutes idle), so there the file only bridges restarts within one instance; on each
 * start the transactions and balance are reloaded from PayPal anyway (see paypal/transactions.ts).
 */
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '.data'));
const FILE = path.join(DATA_DIR, 'state.json');
const VERSION = 1;
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_EVERY_MS = 5_000;

interface Snapshot {
  version: number;
  savedAt: string;
  balance: BalanceInfo;
  transactions: { pilot: Transaction[]; paypal: Transaction[] };
  actions: PendingAction[];
}

export function loadState(repo: IRepo, actions: Map<string, PendingAction>): void {
  let snap: Snapshot;
  try {
    snap = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Snapshot;
  } catch {
    return; // first run or unreadable file: start from seed data
  }
  if (snap.version !== VERSION) return;
  repo.replaceSource('pilot', snap.transactions?.pilot ?? []);
  repo.replaceSource('paypal', snap.transactions?.paypal ?? []);
  if (snap.balance && Number.isFinite(snap.balance.value)) repo.setBalance(snap.balance);
  const cutoff = Date.now() - ACTION_TTL_MS;
  for (const a of snap.actions ?? []) if (a.createdAt >= cutoff) actions.set(a.id, a);
  console.log(`[Store] Restored ${actions.size} proposals and ${snap.transactions?.pilot?.length ?? 0} Pilot payments from ${snap.savedAt}`);
}

let last = '';

export function saveState(repo: IRepo, actions: Map<string, PendingAction>): void {
  const body = {
    balance: repo.balanceInfo(),
    transactions: { pilot: repo.getSource('pilot'), paypal: repo.getSource('paypal') },
    actions: [...actions.values()],
  };
  const json = JSON.stringify(body);
  if (json === last) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, savedAt: new Date().toISOString(), ...body }));
    fs.renameSync(tmp, FILE); // atomic replace, so a crash never leaves half a file
    last = json;
  } catch (err) {
    console.warn('[Store] Could not save state:', err instanceof Error ? err.message : err);
  }
}

/** Saves every few seconds when something changed, and once more on shutdown. */
export function startAutosave(repo: IRepo, actions: Map<string, PendingAction>): () => void {
  const save = () => saveState(repo, actions);
  setInterval(save, SAVE_EVERY_MS).unref();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      save();
      process.exit(0);
    });
  }
  return save;
}

/**
 * Records a completed Pilot purchase as spend and lowers the balance, so the dashboards and the
 * next verdict reflect it right away (Transaction Search can lag hours). Uses the PayPal capture id,
 * so the same payment synced later from PayPal is not counted twice.
 */
export function recordPurchase(repo: IRepo, action: PendingAction, captureId: string | undefined): void {
  const id = `pp-${captureId ?? action.orderId ?? action.id}`;
  const pilot = repo.getSource('pilot');
  if (pilot.some(t => t.id === id)) return;
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  repo.replaceSource('pilot', [...pilot, {
    id,
    date,
    merchant: action.description.slice(0, 60),
    category: 'shopping',
    amount: -Math.abs(action.amount),
    method: 'paypal',
    recurring: false,
    source: 'pilot',
  }]);
  const bal = repo.balanceInfo();
  repo.setBalance({ ...bal, value: bal.value - Math.abs(action.amount) });
}
