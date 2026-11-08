import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { PendingAction } from '../agent/tools';
import type { IRepo } from '../repo/types';
import { isPayPalConfigured, paypalMode, verifyWebhookSignature, webhookId } from '../paypal/client';
import { onStatus } from '../paypal/events';
import { refreshFromPayPal } from '../paypal/live';
import { SIMULATABLE, simulatedEvent } from '../paypal/simulator';
import { syncPayPalTransactions, syncState } from '../paypal/transactions';
import { WebhookEvent, WebhookProcessor } from '../paypal/webhooks';

const header = (req: Request, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** How webhooks reach this server: simulated from seed data, verified sandbox deliveries, or not set up. */
export function webhookMode(): 'simulated' | 'verified' | 'unconfigured' {
  if (paypalMode === 'simulate' || !isPayPalConfigured) return 'simulated';
  return webhookId ? 'verified' : 'unconfigured';
}

export function createPayPalRouter(pendingActions: Map<string, PendingAction>, processor: WebhookProcessor, repo: IRepo) {
  const router = Router();

  /**
   * PayPal sandbox webhook receiver. Every delivery is verified with PayPal before it is applied;
   * a non-2xx makes PayPal retry, so verification failures that are our fault return 5xx.
   */
  router.post('/webhook', async (req: Request, res: Response) => {
    if (webhookMode() === 'simulated') {
      res.status(409).json({ error: 'Webhooks are only accepted with PAYPAL_MODE=sandbox and credentials. In simulate mode use POST /api/paypal/simulate.', code: 'SIMULATE_MODE' });
      return;
    }
    if (!webhookId) {
      res.status(503).json({ error: 'PAYPAL_WEBHOOK_ID is not set, so the delivery cannot be verified.', code: 'NO_WEBHOOK_ID' });
      return;
    }
    const parsed = WebhookEvent.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Not a PayPal webhook event', code: 'BAD_EVENT' });
      return;
    }
    let verified: boolean;
    try {
      verified = await verifyWebhookSignature({
        authAlgo: header(req, 'paypal-auth-algo'),
        certUrl: header(req, 'paypal-cert-url'),
        transmissionId: header(req, 'paypal-transmission-id'),
        transmissionSig: header(req, 'paypal-transmission-sig'),
        transmissionTime: header(req, 'paypal-transmission-time'),
      }, req.body);
    } catch (err) {
      console.error('[Webhook] Verification call failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'Could not verify the webhook with PayPal; PayPal will retry.', code: 'VERIFY_FAILED' });
      return;
    }
    if (!verified) {
      console.warn(`[Webhook] Rejected unverified ${parsed.data.event_type} (${parsed.data.id})`);
      res.status(401).json({ error: 'Webhook signature verification failed', code: 'UNVERIFIED' });
      return;
    }
    const result = processor.process(parsed.data, 'webhook');
    console.log(`[Webhook] ${parsed.data.event_type} ${parsed.data.id} matched=${result.matched} duplicate=${result.duplicate}`);
    res.json({ received: true, ...result });
  });

  /** Plays a PayPal webhook for a simulated (DEMO-*) order or subscription. Same processing path as real webhooks. */
  router.post('/simulate', (req: Request, res: Response) => {
    const body = z.object({ actionId: z.string(), eventType: z.string() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Body must be { actionId, eventType }', code: 'BAD_REQUEST' });
      return;
    }
    const action = pendingActions.get(body.data.actionId);
    if (!action) {
      res.status(404).json({ error: 'Unknown or expired action', code: 'NOT_FOUND' });
      return;
    }
    if (!action.result) {
      res.status(409).json({ error: 'Approve the action first.', code: 'NOT_APPROVED_IN_PILOT' });
      return;
    }
    if (!action.result.demo) {
      res.status(409).json({ error: 'This is a real sandbox object; trigger events from PayPal (approve, capture) instead.', code: 'NOT_SIMULATED' });
      return;
    }
    if (!SIMULATABLE[action.type].includes(body.data.eventType)) {
      res.status(400).json({ error: `Event type must be one of: ${SIMULATABLE[action.type].join(', ')}`, code: 'BAD_EVENT_TYPE' });
      return;
    }
    const evt = simulatedEvent(action, body.data.eventType);
    res.json({ event: evt, ...processor.process(evt, 'simulated') });
  });

  /**
   * Called by the browser tab PayPal redirects back to (?paypal=success&token=… / &subscription_id=…).
   * Re-reads the live status so every open Pilot tab updates even when webhooks can't reach localhost.
   */
  router.post('/return', async (req: Request, res: Response) => {
    const body = z.object({ token: z.string().optional(), subscription_id: z.string().optional() }).safeParse(req.body ?? {});
    const token = body.success ? body.data.token : undefined;
    const subscriptionId = body.success ? body.data.subscription_id : undefined;
    const action = subscriptionId
      ? processor.findAction({ kind: 'subscription', id: subscriptionId })
      : token ? processor.findAction({ kind: 'order', id: token }) : undefined;
    if (!action) {
      res.status(404).json({ error: 'No Pilot proposal matches this PayPal return (the server may have restarted).', code: 'NOT_FOUND' });
      return;
    }
    try {
      await refreshFromPayPal(action);
    } catch (err) {
      console.warn('[PayPal] Status refresh after return failed:', err instanceof Error ? err.message : err);
    }
    res.json({ actionId: action.id, status: action.providerStatus ?? null, timeline: action.timeline ?? [] });
  });

  /** Integration status for reviewers: mode, webhook wiring and live data sync. */
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      mode: paypalMode,
      live: isPayPalConfigured,
      webhooks: {
        mode: webhookMode(),
        webhookIdSet: !!webhookId,
        received: processor.received,
        last: processor.lastEvent,
        endpoint: '/api/paypal/webhook',
      },
      transactions: { ...syncState, counts: repo.countBySource() },
    });
  });

  /** Pulls the sandbox account's transactions now (Transaction Search). */
  router.post('/sync', async (_req: Request, res: Response) => {
    if (!isPayPalConfigured) {
      res.status(409).json({ error: 'Live data needs PAYPAL_MODE=sandbox and credentials; simulate mode uses seed data.', code: 'SIMULATE_MODE' });
      return;
    }
    const state = await syncPayPalTransactions(repo);
    res.status(state.error ? 502 : 200).json({ ...state, counts: repo.countBySource() });
  });

  return router;
}

/** GET /api/events: Server-Sent Events stream of PayPal status changes for every open tab. */
export function eventsHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ mode: paypalMode, webhooks: webhookMode() })}\n\n`);

  const off = onStatus(evt => {
    if (!res.writableEnded) res.write(`event: status\ndata: ${JSON.stringify(evt)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  req.on('close', () => {
    off();
    clearInterval(heartbeat);
  });
}
