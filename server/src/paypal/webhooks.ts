import { z } from 'zod';
import type { PendingAction } from '../agent/tools';
import { recordStatus, StatusSource } from './events';

/** Event types Pilot subscribes to (used by `npm run paypal:webhooks -- create <url>`). */
export const WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.ORDER.COMPLETED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
] as const;

export const WebhookEvent = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  create_time: z.string().optional(),
  resource_type: z.string().optional(),
  summary: z.string().optional(),
  resource: z.record(z.unknown()).default({}),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export interface ResourceRef {
  kind: 'order' | 'subscription';
  id: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Which Pilot order/subscription a webhook is about. */
export function resourceRef(evt: WebhookEvent): ResourceRef | null {
  const r = evt.resource;
  if (evt.event_type.startsWith('CHECKOUT.ORDER.')) {
    const id = str(r.id);
    return id ? { kind: 'order', id } : null;
  }
  if (evt.event_type.startsWith('PAYMENT.CAPTURE.')) {
    const related = (r.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
    const id = str(related?.order_id);
    return id ? { kind: 'order', id } : null;
  }
  if (evt.event_type.startsWith('BILLING.SUBSCRIPTION.')) {
    const id = str(r.id);
    return id ? { kind: 'subscription', id } : null;
  }
  if (evt.event_type === 'PAYMENT.SALE.COMPLETED') {
    const id = str(r.billing_agreement_id);
    return id ? { kind: 'subscription', id } : null;
  }
  return null;
}

/** The status a webhook moves the order/subscription to, and a human label for the UI. */
export function statusFromEvent(evt: WebhookEvent): { status: string; label?: string } | null {
  switch (evt.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': return { status: 'APPROVED' };
    case 'CHECKOUT.ORDER.COMPLETED': return { status: 'COMPLETED' };
    case 'PAYMENT.CAPTURE.COMPLETED': return { status: 'COMPLETED' };
    case 'PAYMENT.CAPTURE.PENDING': return { status: 'PENDING' };
    case 'PAYMENT.CAPTURE.DENIED': return { status: 'DENIED' };
    case 'PAYMENT.CAPTURE.REFUNDED': return { status: 'REFUNDED' };
    case 'BILLING.SUBSCRIPTION.ACTIVATED': return { status: 'ACTIVE' };
    case 'BILLING.SUBSCRIPTION.SUSPENDED': return { status: 'SUSPENDED' };
    case 'BILLING.SUBSCRIPTION.CANCELLED': return { status: 'CANCELLED' };
    case 'BILLING.SUBSCRIPTION.EXPIRED': return { status: 'EXPIRED' };
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': return { status: 'PAYMENT_FAILED' };
    case 'PAYMENT.SALE.COMPLETED': return { status: 'ACTIVE', label: 'Autopay payment received' };
    default: return null;
  }
}

export interface ProcessResult {
  /** The event was seen before (PayPal retries deliveries until it gets a 2xx). */
  duplicate: boolean;
  /** The event refers to an order/subscription created by this server. */
  matched: boolean;
  actionId?: string;
  status?: string;
}

const MAX_SEEN = 1000;

/**
 * Applies PayPal webhook events (verified real ones, or simulated ones built from seed data)
 * to the in-memory proposals. Idempotent per event id.
 */
export class WebhookProcessor {
  private seen = new Set<string>();
  received = 0;
  lastEvent: { type: string; at: string; source: StatusSource; matched: boolean } | null = null;

  constructor(private readonly actions: Map<string, PendingAction>) {}

  findAction(ref: ResourceRef): PendingAction | undefined {
    for (const a of this.actions.values()) {
      if (ref.kind === 'order' && a.orderId === ref.id) return a;
      if (ref.kind === 'subscription' && a.subscriptionId === ref.id) return a;
    }
    return undefined;
  }

  process(evt: WebhookEvent, source: StatusSource): ProcessResult {
    if (this.seen.has(evt.id)) return { duplicate: true, matched: false };
    this.seen.add(evt.id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string);
    this.received++;

    const ref = resourceRef(evt);
    const next = statusFromEvent(evt);
    const action = ref ? this.findAction(ref) : undefined;
    this.lastEvent = { type: evt.event_type, at: new Date().toISOString(), source, matched: !!action };
    if (!action || !next) return { duplicate: false, matched: false };

    recordStatus(action, { status: next.status, label: next.label, source, eventType: evt.event_type, at: evt.create_time });
    return { duplicate: false, matched: true, actionId: action.id, status: next.status };
  }
}
