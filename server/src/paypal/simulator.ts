import { randomUUID } from 'crypto';
import type { PendingAction } from '../agent/tools';
import { WebhookEvent, WebhookProcessor } from './webhooks';

/** Delay before the simulated buyer "approves" in PayPal, so the UI shows the waiting state first. */
export const SIMULATED_APPROVAL_MS = Number(process.env.PAYPAL_SIMULATED_APPROVAL_MS ?? 3000);

/**
 * Builds a webhook event with the same shape PayPal sends, for a simulated (DEMO-*) order or
 * subscription. It goes through the same WebhookProcessor as verified sandbox webhooks.
 */
export function simulatedEvent(action: PendingAction, eventType: string): WebhookEvent {
  const now = new Date().toISOString();
  const amount = { currency_code: 'USD', value: action.amount.toFixed(2) };
  let resource: Record<string, unknown>;
  let resourceType: string;
  if (eventType.startsWith('PAYMENT.CAPTURE.')) {
    resourceType = 'capture';
    resource = {
      id: `DEMO-CAPTURE-${randomUUID().slice(0, 8)}`,
      status: eventType.split('.').pop(),
      amount,
      supplementary_data: { related_ids: { order_id: action.orderId } },
      create_time: now,
    };
  } else if (eventType.startsWith('CHECKOUT.ORDER.')) {
    resourceType = 'checkout-order';
    resource = { id: action.orderId, status: eventType.split('.').pop(), intent: 'CAPTURE', purchase_units: [{ amount }], create_time: now };
  } else if (eventType === 'PAYMENT.SALE.COMPLETED') {
    resourceType = 'sale';
    resource = { id: `DEMO-SALE-${randomUUID().slice(0, 8)}`, billing_agreement_id: action.subscriptionId, amount: { total: amount.value, currency: 'USD' }, state: 'completed' };
  } else {
    resourceType = 'subscription';
    // Subscription resource status as PayPal reports it (a failed payment leaves the subscription ACTIVE).
    const status = ({ ACTIVATED: 'ACTIVE', SUSPENDED: 'SUSPENDED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' } as Record<string, string>)[eventType.replace('BILLING.SUBSCRIPTION.', '')] ?? 'ACTIVE';
    resource = { id: action.subscriptionId, plan_id: action.result?.planId, status, create_time: now };
  }
  return { id: `WH-SIM-${randomUUID()}`, event_type: eventType, create_time: now, resource_type: resourceType, summary: `Simulated ${eventType}`, resource };
}

/** Event types a simulated order or subscription can be sent through POST /api/paypal/simulate. */
export const SIMULATABLE: Record<'paypal_order' | 'autopay', string[]> = {
  paypal_order: ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REFUNDED'],
  autopay: ['BILLING.SUBSCRIPTION.ACTIVATED', 'PAYMENT.SALE.COMPLETED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', 'BILLING.SUBSCRIPTION.SUSPENDED', 'BILLING.SUBSCRIPTION.CANCELLED'],
};

/**
 * After a simulated approval, plays the webhook PayPal would send once the buyer approves:
 * CHECKOUT.ORDER.APPROVED for orders, BILLING.SUBSCRIPTION.ACTIVATED for autopay.
 */
export function scheduleSimulatedApproval(action: PendingAction, processor: WebhookProcessor, delayMs = SIMULATED_APPROVAL_MS): void {
  const eventType = action.type === 'paypal_order' ? 'CHECKOUT.ORDER.APPROVED' : 'BILLING.SUBSCRIPTION.ACTIVATED';
  const timer = setTimeout(() => {
    // Skip if the order was already captured or the status moved on in the meantime.
    if (action.captured || (action.providerStatus && !['CREATED', 'APPROVAL_PENDING'].includes(action.providerStatus))) return;
    processor.process(simulatedEvent(action, eventType), 'simulated');
  }, delayMs);
  timer.unref?.();
}
