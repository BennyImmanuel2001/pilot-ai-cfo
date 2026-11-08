import { EventEmitter } from 'events';
import type { PendingAction } from '../agent/tools';

/**
 * Where a PayPal status came from:
 * - `webhook`   a signature-verified PayPal sandbox webhook
 * - `poll`      a live GET of the order/subscription from the PayPal sandbox
 * - `pilot`     a PayPal API response to a call Pilot made (create, capture)
 * - `simulated` generated from seed data in PAYPAL_MODE=simulate (same shape as a real webhook)
 */
export type StatusSource = 'webhook' | 'poll' | 'pilot' | 'simulated';

export interface StatusEntry {
  status: string;
  label: string;
  source: StatusSource;
  eventType?: string;
  at: string;
}

export interface ActionStatusEvent extends StatusEntry {
  actionId: string;
  kind: 'order' | 'subscription';
  resourceId: string;
  demo: boolean;
  /** True once the order's payment is captured (by Pilot, a webhook or a poll). */
  captured: boolean;
}

const MAX_TIMELINE = 20;
const bus = new EventEmitter();
bus.setMaxListeners(200);

export function onStatus(listener: (event: ActionStatusEvent) => void): () => void {
  bus.on('status', listener);
  return () => bus.off('status', listener);
}

const ORDER_LABELS: Record<string, string> = {
  CREATED: 'Waiting for the buyer to approve in PayPal',
  PAYER_ACTION_REQUIRED: 'Waiting for the buyer to approve in PayPal',
  SAVED: 'Order saved in PayPal',
  APPROVED: 'Buyer approved in PayPal. Ready to capture',
  VOIDED: 'Order voided in PayPal',
  COMPLETED: 'Payment captured',
  PENDING: 'Capture pending at PayPal',
  DENIED: 'Payment denied by PayPal',
  REFUNDED: 'Payment refunded',
};

const SUBSCRIPTION_LABELS: Record<string, string> = {
  APPROVAL_PENDING: 'Waiting for the subscriber to approve in PayPal',
  APPROVED: 'Approved in PayPal, activating',
  ACTIVE: 'Autopay active',
  SUSPENDED: 'Autopay suspended in PayPal',
  CANCELLED: 'Autopay cancelled in PayPal',
  EXPIRED: 'Autopay expired',
  PAYMENT_FAILED: 'A scheduled payment failed',
};

export function statusLabel(kind: 'order' | 'subscription', status: string): string {
  return (kind === 'order' ? ORDER_LABELS : SUBSCRIPTION_LABELS)[status] ?? `PayPal status: ${status}`;
}

export const kindOf = (action: PendingAction): 'order' | 'subscription' => (action.type === 'paypal_order' ? 'order' : 'subscription');

/**
 * Records a PayPal status on the action and pushes it to every open /api/events stream.
 * Polls only record changes; webhooks and simulated events are always recorded (they are events).
 * Returns false when nothing changed.
 */
export function recordStatus(
  action: PendingAction,
  entry: { status: string; source: StatusSource; label?: string; eventType?: string; at?: string },
): boolean {
  if (entry.source === 'poll' && action.providerStatus === entry.status) return false;
  const kind = kindOf(action);
  const full: StatusEntry = {
    status: entry.status,
    label: entry.label ?? statusLabel(kind, entry.status),
    source: entry.source,
    eventType: entry.eventType,
    at: entry.at ?? new Date().toISOString(),
  };
  action.providerStatus = entry.status;
  action.timeline = [...(action.timeline ?? []), full].slice(-MAX_TIMELINE);
  if (kind === 'order' && entry.status === 'COMPLETED' && !action.captured) {
    action.captured = { status: 'COMPLETED', demo: !!action.result?.demo };
  }
  const resourceId = (kind === 'order' ? action.orderId : action.subscriptionId) ?? '';
  bus.emit('status', {
    ...full,
    actionId: action.id,
    kind,
    resourceId,
    demo: !!action.result?.demo,
    captured: !!action.captured,
  } satisfies ActionStatusEvent);
  return true;
}
