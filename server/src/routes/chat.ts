import { Router, Request, Response } from 'express';
import { IRepo } from '../repo/types';
import { PendingAction, runAgent, buildDefaultDashboard } from '../agent/loop';

export function createChatRouter(repo: IRepo, pendingActions: Map<string, PendingAction>) {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { messages } = (req.body ?? {}) as { messages?: Array<{ role: string; content: string }> };

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: 'messages array required' });
      return;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const send = (event: string, data: unknown) => {
      if (clientGone || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Comment frames keep proxies and the client's idle timer alive during slow tool rounds.
    const heartbeat = setInterval(() => {
      if (!clientGone && !res.writableEnded) res.write(': ping\n\n');
    }, 10_000);

    let gotText = false;
    let gotDashboard = false;
    try {
      await runAgent(
        messages,
        repo,
        pendingActions,
        {
          onText: (token) => { gotText = true; send('text', { content: token }); },
          onDashboard: (spec) => { gotDashboard = true; send('dashboard', spec); },
          onAction: (action) => send('action', action),
        },
      );
    } catch (err) {
      console.error('[Chat] Agent error:', err);
      send('text', { content: `${gotText ? '\n\n' : ''}Something went wrong answering that, so here is your overview instead.` });
      gotText = true;
    }

    // Every turn ends with text, a dashboard and done, whatever happened above.
    if (!gotText) send('text', { content: 'Here is your overview.' });
    if (!gotDashboard) {
      try {
        send('dashboard', buildDefaultDashboard(repo));
      } catch (err) {
        console.error('[Chat] Default dashboard failed:', err);
      }
    }

    clearInterval(heartbeat);
    send('done', {});
    res.end();
  });

  // Default dashboard on startup
  router.get('/default-dashboard', (_req: Request, res: Response) => {
    res.json(buildDefaultDashboard(repo));
  });

  return router;
}
