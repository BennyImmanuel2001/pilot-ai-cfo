/**
 * Manage the sandbox app's webhooks.
 *
 *   npm run paypal:webhooks -- list
 *   npm run paypal:webhooks -- create https://<public-api-host>/api/paypal/webhook
 *   npm run paypal:webhooks -- delete <webhook-id>
 *
 * Needs PAYPAL_MODE=sandbox, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.
 * After `create`, put the printed id in PAYPAL_WEBHOOK_ID and restart the server.
 */
import '../env';
import { isPayPalConfigured, paypalFetch } from '../paypal/client';
import { WEBHOOK_EVENT_TYPES } from '../paypal/webhooks';

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (!isPayPalConfigured) {
    throw new Error('Set PAYPAL_MODE=sandbox, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.');
  }

  if (command === 'list') {
    const data = await paypalFetch('/v1/notifications/webhooks', 'GET');
    const hooks = (data.webhooks ?? []) as Array<{ id: string; url: string; event_types: Array<{ name: string }> }>;
    if (!hooks.length) console.log('No webhooks registered for this sandbox app.');
    for (const h of hooks) console.log(`${h.id}  ${h.url}  (${h.event_types.length} event types)`);
    return;
  }

  if (command === 'create') {
    if (!arg || !/^https:\/\//.test(arg)) {
      throw new Error('PayPal only delivers to public https URLs, e.g. https://pilot-api.onrender.com/api/paypal/webhook or an ngrok/cloudflared tunnel to localhost:8787.');
    }
    const data = await paypalFetch('/v1/notifications/webhooks', 'POST', {
      url: arg,
      event_types: WEBHOOK_EVENT_TYPES.map(name => ({ name })),
    });
    console.log(`Created webhook ${String(data.id)} for ${arg}`);
    console.log(`\nAdd this to .env and restart the server:\nPAYPAL_WEBHOOK_ID=${String(data.id)}`);
    return;
  }

  if (command === 'delete') {
    if (!arg) throw new Error('Usage: npm run paypal:webhooks -- delete <webhook-id>');
    await paypalFetch(`/v1/notifications/webhooks/${encodeURIComponent(arg)}`, 'DELETE');
    console.log(`Deleted webhook ${arg}`);
    return;
  }

  console.log('Usage: npm run paypal:webhooks -- list | create <https-url> | delete <webhook-id>');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
