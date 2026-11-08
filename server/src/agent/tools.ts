import { z } from 'zod';
import { IRepo, Transaction } from '../repo/types';
import { ymd, startOfToday, addDays, daysBetween, endOfMonth } from '../util/dates';
import { fetchText, markFailed, markOk } from '../status';

export interface PendingAction {
  id: string;
  type: 'paypal_order' | 'autopay';
  description: string;
  amount: number;
  merchant?: string;
  cadence?: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: number;
  /** Set once approved: the PayPal (or DEMO) order id and the approve response, so repeats are idempotent. */
  orderId?: string;
  subscriptionId?: string;
  result?: Record<string, unknown>;
  captured?: { status: string; demo: boolean };
  /** Latest PayPal status (order: CREATED/APPROVED/COMPLETED…, subscription: APPROVAL_PENDING/ACTIVE…). */
  providerStatus?: string;
  /** Status history from Pilot calls, webhooks, live polls or the simulator. */
  timeline?: import('../paypal/events').StatusEntry[];
}

/** Proposals expire after an hour so the in-memory map stays small. */
const ACTION_TTL_MS = 60 * 60 * 1000;

function rememberAction(pendingActions: Map<string, PendingAction>, action: PendingAction): void {
  const cutoff = Date.now() - ACTION_TTL_MS;
  for (const [id, a] of pendingActions) if (a.createdAt < cutoff) pendingActions.delete(id);
  pendingActions.set(action.id, action);
}

export interface ProductInfo {
  title: string;
  price: number;
  currency: string;
  url: string;
  image: string;
  retailer: string;
}

const MOCK_CATALOG: Array<ProductInfo & { keywords: string[] }> = [
  { title: 'PlayStation 5 Pro Console Bundle', price: 999.99, currency: 'USD', url: 'https://www.playstation.com/en-us/ps5/', image: '', retailer: 'PlayStation Direct', keywords: ['ps5', 'playstation', 'sony', 'console'] },
  { title: 'MacBook Air 13" M4', price: 1099.0, currency: 'USD', url: 'https://www.apple.com/macbook-air/', image: '', retailer: 'Apple', keywords: ['macbook', 'laptop', 'mac', 'apple'] },
  { title: 'iPhone 17 Pro', price: 1099.0, currency: 'USD', url: 'https://www.apple.com/iphone/', image: '', retailer: 'Apple', keywords: ['iphone', 'phone', 'apple'] },
  { title: 'Nintendo Switch 2', price: 449.99, currency: 'USD', url: 'https://www.nintendo.com/', image: '', retailer: 'Nintendo', keywords: ['switch', 'nintendo', 'console'] },
  { title: 'AirPods Pro 3', price: 249.0, currency: 'USD', url: 'https://www.apple.com/airpods-pro/', image: '', retailer: 'Apple', keywords: ['airpods', 'earbuds', 'headphones'] },
  { title: 'Samsung 65" QLED 4K TV', price: 899.99, currency: 'USD', url: 'https://www.samsung.com/us/televisions-home-theater/', image: '', retailer: 'Samsung', keywords: ['tv', 'television', 'samsung', 'qled'] },
];

// Seeded fallback prices for common items that are not in the catalog above.
const GENERIC_PRICES: Array<{ keywords: string[]; price: number }> = [
  { keywords: ['bicycle', 'bike', 'ebike', 'e-bike'], price: 549 },
  { keywords: ['jacket', 'coat', 'parka', 'hoodie'], price: 129 },
  { keywords: ['shoes', 'sneakers', 'boots'], price: 110 },
  { keywords: ['sofa', 'couch', 'mattress', 'bed', 'desk', 'chair'], price: 699 },
  { keywords: ['camera', 'drone', 'gopro'], price: 649 },
  { keywords: ['watch', 'smartwatch'], price: 399 },
  { keywords: ['tablet', 'ipad', 'kindle'], price: 449 },
  { keywords: ['car', 'vacation', 'trip', 'flight', 'holiday'], price: 1500 },
];
const DEFAULT_GENERIC_PRICE = 300;

/** A price the user stated in the message: "$300 jacket", "a 1,200 dollar laptop", "for 80 bucks". */
export function parseStatedPrice(text: string): number | undefined {
  const m = text.match(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\b/i)
    ?? text.match(/\b(\d[\d,]*(?:\.\d{1,2})?)\s*(k)?\s*(?:dollars?|usd|bucks)\b/i);
  if (!m) return undefined;
  const value = Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : undefined;
}

/** Removes a stated price and filler so "a $300 jacket" searches for "jacket". */
export function stripPrice(text: string): string {
  return text
    .replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?\s*k?\b/gi, '')
    .replace(/\b\d[\d,]*(?:\.\d{1,2})?\s*k?\s*(?:dollars?|usd|bucks)\b/gi, '')
    .replace(/[?.!]+\s*$/, '')
    .replace(/\s+(for|that costs?|costing|priced at|at)\s*$/i, '')
    .replace(/^\s*(a|an|the|new)\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const CHANNEL3_URL = process.env.CHANNEL3_URL || 'https://api.trychannel3.com/v0/search';
const CHANNEL3_TIMEOUT_MS = 5_000;

/** Live product lookup via Channel3. Returns null on any failure so callers fall back to the mock catalog. */
async function findProductChannel3(query: string): Promise<ProductInfo | null> {
  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetchText(CHANNEL3_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ query, limit: 5 }),
    }, CHANNEL3_TIMEOUT_MS);
    console.log(`[Channel3] search "${query}" -> ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(res.text) as unknown;
    const list = Array.isArray(data)
      ? data
      : (data as { results?: unknown; products?: unknown } | null)?.results ?? (data as { products?: unknown } | null)?.products;
    markOk('channel3');

    // First result with a usable positive price wins.
    for (const item of (Array.isArray(list) ? list : []) as Array<Record<string, unknown> | null>) {
      if (!item || typeof item !== 'object') continue;
      const priceField = item.price as number | string | { price?: number | string; currency?: string } | null | undefined;
      const price = Number(typeof priceField === 'object' && priceField !== null ? priceField.price : priceField);
      if (!Number.isFinite(price) || price <= 0) continue;
      const currency = (typeof priceField === 'object' && priceField?.currency) || 'USD';
      const images = item.images as Array<{ url?: string }> | undefined;
      return {
        title: String(item.title ?? query),
        price: Math.round(price * 100) / 100,
        currency,
        url: String(item.url ?? ''),
        image: String(item.image_url ?? item.image ?? (Array.isArray(images) ? images[0]?.url ?? '' : '')),
        retailer: String(item.brand_name ?? item.retailer ?? item.merchant ?? 'Channel3'),
      };
    }
    console.log(`[Channel3] no priced results for "${query}", using mock catalog`);
    return null;
  } catch (err) {
    markFailed('channel3', err);
    console.warn(`[Channel3] lookup failed, using mock catalog: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export function buildToolDefinitions() {
  return [
    {
      type: 'function' as const,
      function: {
        name: 'query_transactions',
        description: 'Query user transactions. Returns raw rows or aggregated totals.',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category (e.g. groceries, restaurants, utilities, food delivery, transport, shopping, subscriptions, health, entertainment)' },
            from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive)' },
            to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
            groupBy: { type: 'string', enum: ['month', 'category', 'merchant'], description: 'Aggregate results by this field' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'project_cashflow',
        description: 'Projects daily account balance from today to end of month.',
        parameters: {
          type: 'object',
          properties: {
            extraSpend: { type: 'number', description: 'Additional one-time spend to simulate (e.g. price of item being considered)' },
            startInDays: { type: 'number', description: 'Days from today when the extra spend occurs (default 0)' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'find_product',
        description: 'Looks up a product and its current price.',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Product search query (e.g. "PS5", "MacBook Air")' },
            price: { type: 'number', description: 'Price the user stated, if any (e.g. 300 for "a $300 jacket")' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'affordability_verdict',
        description: 'Returns yes/wait/no verdict for a purchase based on cashflow projection.',
        parameters: {
          type: 'object',
          required: ['price'],
          properties: {
            price: { type: 'number', description: 'Purchase price in USD' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'detect_recurring',
        description: 'Returns list of recurring payments detected in the user\'s transaction history.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'propose_paypal_order',
        description: 'Creates a pending PayPal order for user approval. Does NOT charge anything yet.',
        parameters: {
          type: 'object',
          required: ['amount', 'description'],
          properties: {
            amount: { type: 'number', description: 'Order amount in USD' },
            description: { type: 'string', description: 'What is being purchased' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'propose_autopay',
        description: 'Proposes converting a recurring payment to PayPal subscription. Requires user approval.',
        parameters: {
          type: 'object',
          required: ['merchant', 'amount', 'cadence'],
          properties: {
            merchant: { type: 'string', description: 'Merchant name' },
            amount: { type: 'number', description: 'Monthly amount (positive)' },
            cadence: { type: 'string', enum: ['monthly', 'weekly'], description: 'Payment frequency' },
          },
        },
      },
    },
    {
      type: 'function' as const,
      function: {
        name: 'set_dashboard',
        description: 'Sets the dashboard widgets visible to the user. Call exactly once after answering. Widget shapes: kpi{title,value(string),delta?,trend?,sparkline?}; chart{title,kind:bar|line|area|donut,categories[],series[{name,values[]}],format?}; grid{title,columns[{field,headerName,type?:currency|date|text}],rows[],groupBy?[]}; timeline{title,points[{date,balance}],events[{date,label,amount}],safetyLine?}; verdict{item{title,price,image?,retailer?},decision,reasoning[],endOfMonthBalance,actionId?}. Every widget may set span 1-4.',
        parameters: {
          type: 'object',
          required: ['title', 'widgets'],
          properties: {
            title: { type: 'string' },
            subtitle: { type: 'string' },
            widgets: {
              type: 'array',
              items: {
                type: 'object',
                required: ['type'],
                properties: {
                  type: { type: 'string', enum: ['kpi', 'chart', 'grid', 'timeline', 'verdict'] },
                  id: { type: 'string' },
                  span: { type: 'number', enum: [1, 2, 3, 4] },
                  title: { type: 'string' },
                  value: { type: 'string' },
                  delta: { type: 'string' },
                  trend: { type: 'string', enum: ['up', 'down', 'flat'] },
                  sparkline: { type: 'array', items: { type: 'number' } },
                  kind: { type: 'string', enum: ['bar', 'line', 'area', 'donut'] },
                  categories: { type: 'array', items: { type: 'string' } },
                  series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } } } },
                  format: { type: 'string', enum: ['currency', 'number'] },
                  columns: { type: 'array', items: { type: 'object' } },
                  rows: { type: 'array', items: { type: 'object' } },
                  groupBy: { type: 'array', items: { type: 'string' } },
                  points: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, balance: { type: 'number' } } } },
                  events: { type: 'array', items: { type: 'object' } },
                  safetyLine: { type: 'number' },
                  item: { type: 'object' },
                  decision: { type: 'string', enum: ['yes', 'wait', 'no'] },
                  reasoning: { type: 'array', items: { type: 'string' } },
                  endOfMonthBalance: { type: 'number' },
                  actionId: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  ];
}

// ─── Argument schemas (every tool call is validated with zod) ────────────────

const ToolArgs = {
  query_transactions: z.object({
    category: z.string().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    groupBy: z.enum(['month', 'category', 'merchant']).optional(),
  }),
  project_cashflow: z.object({
    extraSpend: z.coerce.number().nonnegative().optional(),
    startInDays: z.coerce.number().int().nonnegative().optional(),
  }),
  find_product: z.object({ query: z.string().min(1), price: z.coerce.number().positive().optional() }),
  affordability_verdict: z.object({ price: z.coerce.number().positive() }),
  detect_recurring: z.object({}).passthrough(),
  propose_paypal_order: z.object({
    amount: z.coerce.number().positive(),
    description: z.string().min(1),
  }),
  propose_autopay: z.object({
    merchant: z.string().min(1),
    amount: z.coerce.number(),
    cadence: z.enum(['monthly', 'weekly']).default('monthly'),
  }),
  set_dashboard: z.object({}).passthrough(),
} as const;

export type ToolName = keyof typeof ToolArgs;

const titleCase = (t: string) => t.replace(/\b[a-z]/g, c => c.toUpperCase());

/**
 * Best mock-catalog match for the query. When nothing matches, returns a generic item named after the
 * query, priced from the user's stated price or a seeded estimate, so a verdict is always possible.
 */
export function findMockProduct(rawQuery: string, statedPrice?: number): ProductInfo & { source: 'mock' | 'estimate' } {
  const query = stripPrice(rawQuery) || rawQuery;
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
  let best: (typeof MOCK_CATALOG)[number] | null = null;
  let bestScore = 0;
  for (const p of MOCK_CATALOG) {
    const titleWords = p.title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && w !== 'pro');
    const keywordHits = words.filter(w => p.keywords.includes(w)).length;
    const titleHits = words.filter(w => titleWords.includes(w)).length;
    // A keyword hit, or two title words, counts as a real match; one generic word ("pro") does not.
    const score = keywordHits || titleHits >= 2 ? keywordHits * 2 + titleHits : 0;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  if (best) {
    const { keywords: _k, ...product } = best;
    return { ...product, price: statedPrice ?? product.price, source: 'mock' };
  }
  const generic = GENERIC_PRICES.find(g => words.some(w => g.keywords.includes(w) || g.keywords.includes(w.replace(/s$/, ''))));
  return {
    title: titleCase(query.slice(0, 60)) || 'Purchase',
    price: statedPrice ?? generic?.price ?? DEFAULT_GENERIC_PRICE,
    currency: 'USD',
    url: '',
    image: '',
    retailer: statedPrice ? 'Price you gave' : 'Estimated typical price',
    source: 'estimate',
  };
}

export function buildToolExecutor(repo: IRepo, pendingActions: Map<string, PendingAction>) {
  return async function executeToolCall(name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
    const schema = ToolArgs[name as ToolName];
    if (!schema) return { error: `Unknown tool: ${name}` };
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return { error: 'Invalid arguments', details: parsed.error.flatten() };
    }
    const args = parsed.data as Record<string, unknown>;

    switch (name as ToolName) {
      case 'query_transactions': {
        const a = args as z.infer<typeof ToolArgs.query_transactions>;
        const result = repo.query(a);
        // Keep tool payloads small for the LLM context window
        return Array.isArray(result) && !a.groupBy ? (result as Transaction[]).slice(-150) : result;
      }

      case 'project_cashflow': {
        const a = args as z.infer<typeof ToolArgs.project_cashflow>;
        return projectCashflow(repo, a.extraSpend, a.startInDays);
      }

      case 'find_product': {
        const a = args as z.infer<typeof ToolArgs.find_product>;
        const statedPrice = a.price ?? parseStatedPrice(a.query);
        const live = await findProductChannel3(stripPrice(a.query) || a.query);
        if (live) return { ...live, price: statedPrice ?? live.price, source: 'channel3' };
        return findMockProduct(a.query, statedPrice);
      }

      case 'affordability_verdict': {
        const { price } = args as z.infer<typeof ToolArgs.affordability_verdict>;
        return computeAffordabilityVerdict(repo, price);
      }

      case 'detect_recurring': {
        return repo.recurringPayments();
      }

      case 'propose_paypal_order': {
        const a = args as z.infer<typeof ToolArgs.propose_paypal_order>;
        const action: PendingAction = {
          id: crypto.randomUUID(),
          type: 'paypal_order',
          description: a.description,
          amount: Math.round(a.amount * 100) / 100,
          status: 'pending',
          createdAt: Date.now(),
        };
        rememberAction(pendingActions, action);
        return action;
      }

      case 'propose_autopay': {
        const a = args as z.infer<typeof ToolArgs.propose_autopay>;
        const action: PendingAction = {
          id: crypto.randomUUID(),
          type: 'autopay',
          description: `Autopay for ${a.merchant}`,
          amount: Math.round(Math.abs(a.amount) * 100) / 100,
          merchant: a.merchant,
          cadence: a.cadence,
          status: 'pending',
          createdAt: Date.now(),
        };
        rememberAction(pendingActions, action);
        return action;
      }

      case 'set_dashboard':
        // The agent loop validates this against DashboardSpec and emits it.
        return rawArgs;
    }
  };
}

/** Average daily non-recurring spend over the last 90 days. */
function dailyDiscretionarySpend(repo: IRepo): number {
  const today = startOfToday();
  const recent = repo.query({ from: ymd(addDays(today, -90)), to: ymd(today) }) as Transaction[];
  const total = recent
    .filter(t => !t.recurring && t.amount < 0)
    .reduce((s, t) => s + t.amount, 0);
  return Math.abs(total) / 90;
}

export function projectCashflow(repo: IRepo, extraSpend?: number, startInDays?: number) {
  const today = startOfToday();
  const daysLeft = daysBetween(today, endOfMonth(today));
  const profile = repo.profile();
  const daily = dailyDiscretionarySpend(repo);
  const bills = repo.upcomingBills(daysLeft);
  const safetyLine = Math.round(profile.monthlyIncome * 0.15);

  const points: Array<{ date: string; balance: number }> = [];
  const events: Array<{ date: string; label: string; amount: number }> = [];
  let running = repo.balance();

  for (let d = 0; d <= daysLeft; d++) {
    const dateStr = ymd(addDays(today, d));

    for (const bill of bills) {
      if (bill.date === dateStr) {
        running += bill.amount;
        events.push({ date: dateStr, label: bill.merchant, amount: bill.amount });
      }
    }

    if (extraSpend && d === Math.min(startInDays ?? 0, daysLeft)) {
      running -= extraSpend;
      events.push({ date: dateStr, label: 'Planned purchase', amount: -extraSpend });
    }

    if (d > 0) running -= daily;

    points.push({ date: dateStr, balance: Math.round(running * 100) / 100 });
  }

  const billsTotal = bills.reduce((s, b) => s + Math.abs(b.amount), 0);
  return {
    points,
    events,
    safetyLine,
    dailyDiscretionary: Math.round(daily * 100) / 100,
    endOfMonthBalance: Math.round(running),
    remainingBills: Math.round(billsTotal * 100) / 100,
  };
}

export function computeAffordabilityVerdict(repo: IRepo, price: number) {
  const profile = repo.profile();
  const today = startOfToday();
  const daysLeft = daysBetween(today, endOfMonth(today));
  const bills = repo.upcomingBills(daysLeft);
  const totalUpcomingBills = bills.reduce((s, b) => s + Math.abs(b.amount), 0);
  const projectedDiscretionary = dailyDiscretionarySpend(repo) * daysLeft;

  const balance = repo.balance();
  const safetyBuffer = profile.monthlyIncome * 0.15;
  const comfortLine = profile.monthlyIncome * 0.3;
  const projectedEoM = balance - totalUpcomingBills - projectedDiscretionary;
  const projectedAfterPurchase = projectedEoM - price;

  const nextPayday = new Date(today.getFullYear(), today.getMonth() + (today.getDate() >= profile.paydayOfMonth ? 1 : 0), profile.paydayOfMonth);
  const daysUntilIncome = daysBetween(today, nextPayday);
  const singleIncome = true; // seed profile has exactly one income source

  let decision: 'yes' | 'wait' | 'no';
  if (projectedAfterPurchase < safetyBuffer) decision = 'no';
  else if (projectedAfterPurchase < comfortLine || (singleIncome && price > balance * 0.25)) decision = 'wait';
  else decision = 'yes';

  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const reasoning: string[] = [
    `Current balance is ${money(balance)}; next paycheck (${money(profile.monthlyIncome)}) lands in ${daysUntilIncome} days.`,
    `Bills still due this month: ${money(totalUpcomingBills)}. Typical day-to-day spend for the rest of the month: ${money(projectedDiscretionary)}.`,
    `Projected end-of-month balance: ${money(projectedEoM)} without the purchase, ${money(projectedAfterPurchase)} with it.`,
    `Safety buffer is ${money(safetyBuffer)} (15% of monthly income).`,
  ];
  if (decision === 'no') {
    reasoning.push(`Buying now leaves you ${money(safetyBuffer - projectedAfterPurchase)} under the buffer. Waiting until payday clears it.`);
  } else if (decision === 'wait') {
    reasoning.push(`It stays above the buffer, but you rely on a single income. Buying after payday on day ${profile.paydayOfMonth} is the safer move.`);
  } else {
    reasoning.push(`You keep ${money(projectedAfterPurchase - comfortLine)} above the comfort line (30% of income).`);
  }

  return {
    decision,
    reasoning,
    endOfMonthBalance: Math.round(projectedAfterPurchase),
    projectedEoMWithoutPurchase: Math.round(projectedEoM),
    safetyBuffer: Math.round(safetyBuffer),
    daysUntilIncome,
  };
}
