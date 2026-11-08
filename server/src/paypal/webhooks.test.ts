import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PendingAction } from '../agent/tools';
import { onStatus, type ActionStatusEvent } from './events';
import { simulatedEvent } from './simulator';
import { resourceRef, statusFromEvent, WebhookEvent, WebhookProcessor } from './webhooks';
import { toTransaction } from './transactions';

function action(over: Partial<PendingAction>): PendingAction {
  return { id: 'a1', type: 'paypal_order', description: 'E-Bike', amount: 999, status: 'approved', createdAt: Date.now(), ...over };
}

const evt = (event_type: string, resource: Record<string, unknown>, id = `WH-${Math.random()}`): WebhookEvent =>
  WebhookEvent.parse({ id, event_type, resource });

test('maps each webhook family to the order or subscription it is about', () => {
  assert.deepEqual(resourceRef(evt('CHECKOUT.ORDER.APPROVED', { id: 'O1' })), { kind: 'order', id: 'O1' });
  assert.deepEqual(
    resourceRef(evt('PAYMENT.CAPTURE.COMPLETED', { id: 'C1', supplementary_data: { related_ids: { order_id: 'O1' } } })),
    { kind: 'order', id: 'O1' },
  );
  assert.deepEqual(resourceRef(evt('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-1' })), { kind: 'subscription', id: 'I-1' });
  assert.deepEqual(resourceRef(evt('PAYMENT.SALE.COMPLETED', { billing_agreement_id: 'I-1' })), { kind: 'subscription', id: 'I-1' });
  assert.equal(resourceRef(evt('PAYMENT.CAPTURE.COMPLETED', { id: 'C1' })), null);
  assert.equal(statusFromEvent(evt('CUSTOMER.DISPUTE.CREATED', {})), null);
});

test('an order goes CREATED → APPROVED → COMPLETED and is marked captured', () => {
  const actions = new Map([['a1', action({ orderId: 'O1', providerStatus: 'CREATED', result: { demo: false } })]]);
  const p = new WebhookProcessor(actions);
  const seen: ActionStatusEvent[] = [];
  const off = onStatus(e => seen.push(e));

  assert.deepEqual(p.process(evt('CHECKOUT.ORDER.APPROVED', { id: 'O1' }), 'webhook'), { duplicate: false, matched: true, actionId: 'a1', status: 'APPROVED' });
  p.process(evt('PAYMENT.CAPTURE.COMPLETED', { supplementary_data: { related_ids: { order_id: 'O1' } } }), 'webhook');
  off();

  const a = actions.get('a1')!;
  assert.equal(a.providerStatus, 'COMPLETED');
  assert.deepEqual(a.captured, { status: 'COMPLETED', demo: false });
  assert.deepEqual(a.timeline?.map(t => [t.status, t.source]), [['APPROVED', 'webhook'], ['COMPLETED', 'webhook']]);
  assert.deepEqual(seen.map(e => [e.actionId, e.status, e.captured]), [['a1', 'APPROVED', false], ['a1', 'COMPLETED', true]]);
});

test('ignores redelivered events and events for objects this server did not create', () => {
  const actions = new Map([['a1', action({ orderId: 'O1' })]]);
  const p = new WebhookProcessor(actions);
  const e = evt('CHECKOUT.ORDER.APPROVED', { id: 'O1' }, 'WH-SAME');
  assert.equal(p.process(e, 'webhook').matched, true);
  assert.deepEqual(p.process(e, 'webhook'), { duplicate: true, matched: false });
  assert.equal(p.process(evt('CHECKOUT.ORDER.APPROVED', { id: 'SOMEONE-ELSE' }), 'webhook').matched, false);
  assert.equal(actions.get('a1')!.timeline?.length, 1);
});

test('simulated events have PayPal’s shape and go through the same processor', () => {
  const order = action({ orderId: 'DEMO-ORDER-1', result: { demo: true } });
  const sub = action({ id: 'a2', type: 'autopay', subscriptionId: 'DEMO-SUB-1', result: { demo: true, planId: 'DEMO-PLAN-1' } });
  const p = new WebhookProcessor(new Map([['a1', order], ['a2', sub]]));

  const capture = simulatedEvent(order, 'PAYMENT.CAPTURE.COMPLETED');
  assert.deepEqual(resourceRef(capture), { kind: 'order', id: 'DEMO-ORDER-1' });
  assert.equal(p.process(capture, 'simulated').status, 'COMPLETED');
  assert.equal(p.process(simulatedEvent(sub, 'BILLING.SUBSCRIPTION.ACTIVATED'), 'simulated').status, 'ACTIVE');
  assert.equal(sub.timeline?.at(-1)?.source, 'simulated');
});

test('maps Transaction Search rows to transactions and skips empty ones', () => {
  const t = toTransaction({
    transaction_info: { transaction_id: 'T1', transaction_initiation_date: '2026-11-02T10:00:00+0000', transaction_amount: { value: '-999.00' } },
    cart_info: { item_details: [{ item_name: 'E-Bike' }] },
  });
  assert.deepEqual(t, { id: 'pp-T1', date: '2026-11-02', merchant: 'E-Bike', category: 'shopping', amount: -999, method: 'paypal', recurring: false, source: 'paypal' });
  assert.equal(toTransaction({ transaction_info: { transaction_id: 'T2' } }), null);
});
