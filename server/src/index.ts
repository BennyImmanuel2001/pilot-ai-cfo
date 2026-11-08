import './env';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import { InMemoryRepo } from './repo/InMemoryRepo';
import { ElasticRepo } from './repo/ElasticRepo';
import { IRepo } from './repo/types';
import { createChatRouter } from './routes/chat';
import { createActionsRouter } from './routes/actions';
import { createPayPalRouter, eventsHandler, webhookMode } from './routes/paypal';
import { PendingAction, isLLMConfigured } from './agent/loop';
import { checkPayPalCredentials, hasPayPalCredentials, paypalHealth, paypalMode } from './paypal/client';
import { serviceState } from './status';
import { WebhookProcessor } from './paypal/webhooks';
import { onSynced, startTransactionSync, syncState } from './paypal/transactions';
import { loadState, startAutosave } from './store';

const PORT = parseInt(process.env.PORT || '8787', 10);

async function main() {
  // Elastic is optional. init() has its own timeouts and never throws; on failure reads stay in memory.
  let repo: IRepo;
  let elasticRepo: ElasticRepo | null = null;
  if (process.env.ELASTIC_URL) {
    console.log('[Init] Indexing seed transactions in Elastic');
    elasticRepo = new ElasticRepo(process.env.ELASTIC_URL, process.env.ELASTIC_API_KEY || '');
    await elasticRepo.init();
    repo = elasticRepo;
  } else {
    console.log('[Init] Using in-memory repository');
    repo = new InMemoryRepo();
  }

  checkPayPalCredentials();

  const pendingActions = new Map<string, PendingAction>();
  const webhooks = new WebhookProcessor(pendingActions);
  // Continue from the last run (proposals, Pilot payments, last balance), then refresh from PayPal.
  loadState(repo, pendingActions);
  const save = startAutosave(repo, pendingActions);
  onSynced(save);
  startTransactionSync(repo);

  const app = express();

  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json());

  // Routes
  app.use('/api/chat', createChatRouter(repo, pendingActions));
  app.use('/api/actions', createActionsRouter(pendingActions, webhooks, repo, save));
  app.use('/api/paypal', createPayPalRouter(pendingActions, webhooks, repo));
  app.get('/api/events', eventsHandler);

  app.get('/api/health', async (_req, res) => {
    const llmState = serviceState('llm');
    const c3State = serviceState('channel3');
    const paypal = await paypalHealth();
    res.json({
      status: 'ok',
      // `fallback` = configured, but the last call failed and the scripted agent answered.
      llm: !isLLMConfigured ? 'mock' : llmState.ok === false ? 'fallback' : 'configured',
      paypal,
      paypalMode: paypalMode,
      paypalCredentials: hasPayPalCredentials,
      // How PayPal status updates arrive: `simulated` (seed data), `verified` (signed sandbox webhooks) or `unconfigured`.
      paypalWebhooks: webhookMode(),
      liveTransactions: syncState.enabled ? (syncState.error ? 'error' : syncState.lastSyncAt ? 'synced' : 'pending') : 'off',
      // `paypal` = read from the PayPal sandbox account at the last sync; `seed` = demo profile.
      balanceSource: repo.balanceInfo().source,
      elastic: elasticRepo?.isLive ? 'configured' : elasticRepo ? 'fallback' : 'disabled',
      channel3: !process.env.CHANNEL3_API_KEY ? 'mock' : c3State.ok === false ? 'fallback' : 'configured',
      transactions: repo.recentTransactions(Number.MAX_SAFE_INTEGER).length,
    });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Malformed JSON bodies and any unexpected route error come back as JSON, not an HTML 500 page.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.type === 'entity.parse.failed' ? 400 : err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error('[Server] Unhandled error:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(status).json({ error: status === 400 ? 'Request body must be valid JSON' : 'Something went wrong' });
  });

  app.listen(PORT, () => {
    console.log(`\nPilot server running at http://localhost:${PORT}`);
    console.log(`   LLM:     ${isLLMConfigured ? 'configured' : 'mock (set LLM_BASE_URL + LLM_API_KEY)'}`);
    console.log(`   PayPal:  ${paypalMode === 'simulate' ? 'simulated (default; set PAYPAL_MODE=sandbox to call the PayPal sandbox)' : hasPayPalCredentials ? 'sandbox' : 'simulated (PAYPAL_MODE=sandbox but PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing)'}`);
    console.log(`   Webhooks: ${webhookMode() === 'verified' ? 'verified sandbox deliveries at /api/paypal/webhook' : webhookMode() === 'unconfigured' ? 'not set up (set PAYPAL_WEBHOOK_ID); live status uses polling' : 'simulated from seed data'}`);
    console.log(`   Elastic: ${elasticRepo?.isLive ? 'indexed' : elasticRepo ? 'unavailable, using in-memory seed data' : 'in-memory seed data'}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health\n`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
