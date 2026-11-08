import { Router, Request, Response } from 'express';
import { PendingAction } from '../agent/loop';
import { createOrder, createSubscription, captureOrder } from '../paypal/client';
import { recordStatus } from '../paypal/events';
import { refreshFromPayPal, TERMINAL } from '../paypal/live';
import { scheduleSimulatedApproval, simulatedEvent } from '../paypal/simulator';
import { WebhookProcessor } from '../paypal/webhooks';

const NOT_FOUND = {
  error: 'This proposal has expired or the server was restarted. Ask Pilot again for a fresh one.',
  code: 'NOT_FOUND',
};

export function createActionsRouter(pendingActions: Map<string, PendingAction>, processor: WebhookProcessor) {
  const router = Router();

  const statusBody = (action: PendingAction) => ({
    actionId: action.id,
    status: action.providerStatus ?? null,
    captured: !!action.captured,
    demo: !!action.result?.demo,
    timeline: action.timeline ?? [],
  });

  /**
   * Current PayPal status of an approved proposal. For real sandbox objects this reads PayPal live
   * (unless the status is already final); simulated ones report what the simulator recorded.
   */
  router.get('/:id/status', async (req: Request, res: Response) => {
    const action = pendingActions.get(String(req.params.id));
    if (!action) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (action.result && !action.result.demo && !TERMINAL.has(action.providerStatus ?? '')) {
      try {
        await refreshFromPayPal(action);
      } catch (err) {
        console.warn('[Actions] Live status read failed:', err instanceof Error ? err.message : err);
        res.status(502).json({ ...statusBody(action), error: 'Could not read the status from PayPal right now.', code: 'UPSTREAM' });
        return;
      }
    }
    res.json(statusBody(action));
  });

  router.post('/:id/approve', async (req: Request, res: Response) => {
    const action = pendingActions.get(String(req.params.id));
    if (!action) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (action.status === 'declined') {
      res.status(409).json({ error: 'This proposal was declined. Ask Pilot again to start over.', code: 'DECLINED', status: 'declined' });
      return;
    }
    if (action.status === 'approved') {
      // Idempotent: hand back the original result so a second click or tab shows the same order.
      res.status(409).json(action.result
        ? { error: 'Already approved.', code: 'ALREADY_APPROVED', status: 'approved', result: action.result }
        : { error: 'Approval is already in progress.', code: 'IN_PROGRESS', status: 'approved' });
      return;
    }

    action.status = 'approved';

    try {
      let result: Record<string, unknown>;
      if (action.type === 'paypal_order') {
        const order = await createOrder(action.amount, action.description);
        console.log(`[Actions] Order created: ${order.orderId} demo=${order.demo}`);
        action.orderId = order.orderId;
        result = { success: true, ...order };
      } else {
        const sub = await createSubscription(action.merchant ?? action.description, action.amount, action.cadence ?? 'monthly');
        console.log(`[Actions] Subscription created: ${sub.subscriptionId} demo=${sub.demo}`);
        action.subscriptionId = sub.subscriptionId;
        result = { success: true, ...sub };
      }
      action.result = result;
      const demo = !!result.demo;
      recordStatus(action, { status: String(result.status), source: demo ? 'simulated' : 'pilot' });
      // Simulated objects get the webhook PayPal would send once the buyer approves.
      if (demo) scheduleSimulatedApproval(action, processor);
      res.json(result);
    } catch (err) {
      // createOrder/createSubscription already fall back to simulated results; this is a last resort.
      console.error('[Actions] Approve failed:', err);
      action.status = 'pending';
      res.status(502).json({ error: 'Could not create the PayPal action. Please try again.', code: 'UPSTREAM' });
    }
  });

  router.post('/:id/capture', async (req: Request, res: Response) => {
    const action = pendingActions.get(String(req.params.id));
    if (!action) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (action.type !== 'paypal_order') {
      res.status(400).json({ error: 'Only PayPal orders can be captured.', code: 'NOT_AN_ORDER' });
      return;
    }
    const orderId = (req.body as { orderId?: unknown } | undefined)?.orderId;
    if (typeof orderId !== 'string' || !orderId) {
      res.status(400).json({ error: 'orderId required', code: 'ORDER_ID_REQUIRED' });
      return;
    }
    if (action.status !== 'approved' || !action.orderId) {
      res.status(409).json({ error: 'Approve the order before capturing it.', code: 'NOT_APPROVED_IN_PILOT', status: action.status });
      return;
    }
    if (orderId !== action.orderId) {
      res.status(400).json({ error: 'That order id does not belong to this proposal.', code: 'ORDER_MISMATCH' });
      return;
    }
    if (action.captured) {
      res.json({ ...action.captured, message: 'Already captured.' });
      return;
    }

    const result = await captureOrder(orderId);
    if (result.status === 'FAILED') {
      res.status(502).json({ error: result.message ?? 'PayPal could not capture this order.', code: 'CAPTURE_FAILED', ...result });
      return;
    }
    // NOT_APPROVED is a normal step (buyer hasn't approved in PayPal yet): 200 with the status, nothing recorded.
    if (result.status !== 'NOT_APPROVED') {
      if (result.demo) {
        // Same path as PayPal's PAYMENT.CAPTURE.COMPLETED webhook for a real order.
        processor.process(simulatedEvent(action, 'PAYMENT.CAPTURE.COMPLETED'), 'simulated');
      } else {
        recordStatus(action, { status: result.status, source: 'pilot' });
      }
      action.captured = { status: result.status, demo: result.demo };
    }
    res.json(result);
  });

  router.post('/:id/decline', (req: Request, res: Response) => {
    const action = pendingActions.get(String(req.params.id));
    if (!action) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (action.status === 'approved') {
      res.status(409).json({
        error: 'Already approved, so it can no longer be declined here.',
        code: 'ALREADY_APPROVED',
        status: 'approved',
        result: action.result,
      });
      return;
    }
    action.status = 'declined';
    res.json({ success: true, status: 'declined' });
  });

  return router;
}
