import type { PendingAction } from '../agent/tools';
import { getOrderStatus, getSubscriptionStatus, isPayPalConfigured } from './client';
import { kindOf, recordStatus } from './events';

/** Statuses after which polling stops. */
export const TERMINAL = new Set(['COMPLETED', 'VOIDED', 'DENIED', 'REFUNDED', 'ACTIVE', 'CANCELLED', 'EXPIRED', 'SUSPENDED']);

/**
 * Reads the live status of a real sandbox order/subscription from PayPal and records it if it changed.
 * Simulated (DEMO-*) results have no PayPal object, so they are left to the simulator.
 */
export async function refreshFromPayPal(action: PendingAction): Promise<boolean> {
  if (action.result?.demo || !isPayPalConfigured) return false;
  const kind = kindOf(action);
  const id = kind === 'order' ? action.orderId : action.subscriptionId;
  if (!id) return false;
  const status = kind === 'order' ? await getOrderStatus(id) : await getSubscriptionStatus(id);
  return recordStatus(action, { status, source: 'poll' });
}
