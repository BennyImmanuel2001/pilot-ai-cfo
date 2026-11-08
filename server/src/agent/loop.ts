import { IRepo, Transaction, GroupedResult } from '../repo/types';
import { DashboardSpec, Widget } from '../spec';
import { SYSTEM_PROMPT } from './systemPrompt';
import {
  buildToolDefinitions,
  buildToolExecutor,
  PendingAction,
  ProductInfo,
  projectCashflow,
  computeAffordabilityVerdict,
  parseStatedPrice,
  findMockProduct,
} from './tools';
import { ymd, startOfToday, addDays } from '../util/dates';
import { fetchText, markFailed, markOk } from '../status';

export type { PendingAction } from './tools';

const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const MAX_ITERATIONS = 6;
const LLM_TIMEOUT_MS = 30_000;
/** Whole-turn budget for the LLM path; past it the scripted agent finishes the turn. */
const TURN_BUDGET_MS = 75_000;

export const isLLMConfigured = !!(LLM_BASE_URL && LLM_API_KEY);

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface AgentCallbacks {
  onText: (token: string) => void;
  onDashboard: (spec: DashboardSpec) => void;
  onAction: (action: PendingAction) => void;
}

interface LLMResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
}

async function callLLM(messages: ChatMessage[], tools: ReturnType<typeof buildToolDefinitions>, timeoutMs: number): Promise<LLMResponse> {
  const url = `${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetchText(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages, tools, tool_choice: 'auto', max_tokens: 4096, temperature: 0.2 }),
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${res.text.slice(0, 300)}`);
  }
  let data: LLMResponse;
  try {
    data = JSON.parse(res.text) as LLMResponse;
  } catch {
    throw new Error(`LLM returned non-JSON: ${res.text.slice(0, 120)}`);
  }
  // Some gateways answer 200 with an { error } body instead of choices.
  if (!Array.isArray(data?.choices) || !data.choices[0]?.message) {
    throw new Error(`LLM returned no choices: ${res.text.slice(0, 200)}`);
  }
  return data;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function streamText(text: string, onText: (t: string) => void) {
  for (const chunk of text.split(/(\s+)/)) {
    if (chunk) {
      onText(chunk);
      await sleep(16);
    }
  }
}

/** Only the user/assistant text turns are accepted from the client. */
function sanitizeHistory(messages: Array<{ role: string; content: string }>): ChatMessage[] {
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 4000) }));
}

/** Attach the proposed order id to any verdict widget that is missing it, so the card can show Approve. */
function linkVerdictToOrder(spec: DashboardSpec, orderId?: string): DashboardSpec {
  if (!orderId) return spec;
  return {
    ...spec,
    widgets: spec.widgets.map(w => (w.type === 'verdict' && !w.actionId ? { ...w, actionId: orderId } : w)),
  };
}

export async function runAgent(
  history: Array<{ role: string; content: string }>,
  repo: IRepo,
  pendingActions: Map<string, PendingAction>,
  callbacks: AgentCallbacks,
): Promise<void> {
  const userMessages = sanitizeHistory(history);

  if (!isLLMConfigured || !userMessages.some(m => m.role === 'user')) {
    return runMockAgent(userMessages, repo, pendingActions, callbacks);
  }

  const tools = buildToolDefinitions();
  const executor = buildToolExecutor(repo, pendingActions);
  const today = ymd(startOfToday());
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nToday is ${today}. The user's name is ${repo.profile().name}.` },
    ...userMessages,
  ];
  const deadline = Date.now() + TURN_BUDGET_MS;

  let dashboardEmitted = false;
  let validationRetries = 0;
  let proposedOrderId: string | undefined;
  let anyText = false;
  const emittedActions: PendingAction[] = [];

  /**
   * Hands the rest of the turn to the scripted agent, which always produces text, a dashboard and
   * (where relevant) an action. Actions the model already proposed are reused rather than duplicated.
   */
  const finishWithScripted = async (keepModelText: boolean) => {
    const remap = new Map<string, string>();
    let first = true;
    await runMockAgent(userMessages, repo, pendingActions, {
      onText: keepModelText
        ? () => {}
        : (t) => {
            callbacks.onText(first && anyText ? `\n\n${t}` : t);
            first = false;
          },
      onAction: (a) => {
        const same = emittedActions.find(e => e.type === a.type && e.amount === a.amount);
        if (same) {
          remap.set(a.id, same.id);
          pendingActions.delete(a.id);
        } else {
          callbacks.onAction(a);
        }
      },
      onDashboard: (spec) => callbacks.onDashboard({
        ...spec,
        widgets: spec.widgets.map(w => (w.type === 'verdict' && w.actionId && remap.has(w.actionId) ? { ...w, actionId: remap.get(w.actionId) } : w)),
      }),
    });
    dashboardEmitted = true;
    anyText = true; // either the model's text was kept or the scripted text was streamed
  };

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response: LLMResponse;
    try {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) throw new Error('turn time budget exhausted');
      response = await callLLM(messages, tools, Math.min(LLM_TIMEOUT_MS, remaining));
      markOk('llm');
    } catch (err) {
      markFailed('llm', err);
      console.error(`[Agent] LLM call failed on round ${iteration + 1}: ${err instanceof Error ? err.message : err}`);
      if (!dashboardEmitted) {
        // Keep the demo alive: the scripted agent answers (or finishes) this turn.
        await finishWithScripted(false);
        return;
      }
      break;
    }

    const message = response.choices[0].message;

    if (message.content) {
      anyText = true;
      await streamText(message.content, callbacks.onText);
    }

    if (!message.tool_calls?.length) break;

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });

    for (const toolCall of message.tool_calls) {
      const name = toolCall.function?.name ?? '';
      let args: Record<string, unknown> = {};
      try {
        const parsedArgs = JSON.parse(toolCall.function?.arguments || '{}') as unknown;
        if (parsedArgs && typeof parsedArgs === 'object') args = parsedArgs as Record<string, unknown>;
      } catch {
        args = {};
      }

      console.log(`[Agent] tool ${name}`, JSON.stringify(args).slice(0, 160));
      let result: unknown;
      try {
        result = await executor(name, args);
      } catch (err) {
        // A failing tool becomes an error the model can react to, not a dead stream.
        console.error(`[Agent] tool ${name} threw:`, err);
        result = { error: `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      let toolContent = JSON.stringify(result ?? null);

      if (name === 'set_dashboard') {
        if (dashboardEmitted) {
          toolContent = JSON.stringify({ ok: true, note: 'Dashboard already set for this turn.' });
        } else {
          const parsed = DashboardSpec.safeParse(result);
          const usable = parsed.success && parsed.data.widgets.length > 0;
          if (parsed.success && usable) {
            callbacks.onDashboard(linkVerdictToOrder(parsed.data, proposedOrderId));
            dashboardEmitted = true;
            toolContent = JSON.stringify({ ok: true });
          } else if (validationRetries < 1) {
            validationRetries++;
            console.warn('[Agent] DashboardSpec invalid, asking the model to fix it once');
            toolContent = JSON.stringify({
              error: 'DashboardSpec validation failed. Fix these issues and call set_dashboard again.',
              issues: parsed.success
                ? ['widgets: at least one widget is required']
                : parsed.error.issues.slice(0, 10).map(i => `${i.path.join('.')}: ${i.message}`),
            });
          } else {
            console.warn('[Agent] DashboardSpec invalid after retry, using the scripted dashboard');
            await finishWithScripted(anyText);
            toolContent = JSON.stringify({ ok: true, note: 'Fallback dashboard shown.' });
          }
        }
      } else if (name.startsWith('propose_') && result && typeof result === 'object' && 'id' in result) {
        const action = result as PendingAction;
        if (action.type === 'paypal_order') proposedOrderId = action.id;
        emittedActions.push(action);
        callbacks.onAction(action);
      }

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolContent });
    }

    // set_dashboard is the last step. With text and a dashboard out, the turn is complete;
    // one more round is only worth it to get a sentence of text.
    if (dashboardEmitted && anyText) break;
  }

  if (dashboardEmitted && !anyText) {
    await streamText('Here is what I found. The dashboard has the details.', callbacks.onText);
  }
  if (!dashboardEmitted) {
    // The model answered but never produced a usable dashboard: show the scripted one for this question.
    console.warn('[Agent] no dashboard from the model, using the scripted dashboard');
    await finishWithScripted(anyText);
  }
}

// ─── Helpers shared by the mock agent and the default dashboard ─────────────

const money = (n: number, cents = false) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;

const monthLabel = (key: string) =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });

const TXN_COLUMNS = [
  { field: 'date', headerName: 'Date', type: 'date' as const },
  { field: 'merchant', headerName: 'Merchant', type: 'text' as const },
  { field: 'category', headerName: 'Category', type: 'text' as const },
  { field: 'method', headerName: 'Method', type: 'text' as const },
  { field: 'amount', headerName: 'Amount', type: 'currency' as const },
];

function monthKeys(count: number): string[] {
  const t = startOfToday();
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
    keys.push(ymd(d).slice(0, 7));
  }
  return keys;
}

function spendByMonth(repo: IRepo, keys: string[], category?: string): number[] {
  const rows = repo.query({ category, from: `${keys[0]}-01`, to: ymd(startOfToday()) }) as Transaction[];
  return keys.map(k =>
    Math.round(Math.abs(rows.filter(r => r.amount < 0 && r.date.startsWith(k)).reduce((s, r) => s + r.amount, 0))),
  );
}

// ─── Generic spend questions (any category, any period) ─────────────────────

interface SpendTopic {
  label: string;
  categories: string[]; // empty = all spending
}

const SPEND_TOPICS: Array<SpendTopic & { words: RegExp }> = [
  { label: 'food delivery', categories: ['food delivery'], words: /deliver|doordash|uber eats|grubhub/ },
  { label: 'eating out', categories: ['restaurants', 'food delivery'], words: /eating out|dining|takeout|take-out/ },
  { label: 'restaurants', categories: ['restaurants'], words: /restaurant/ },
  { label: 'groceries', categories: ['groceries'], words: /grocer/ },
  { label: 'food', categories: ['groceries', 'restaurants', 'food delivery'], words: /\bfood\b|\beat(ing)?\b|\bmeals?\b/ },
  { label: 'transport', categories: ['transport'], words: /transport|\buber\b|\blyft\b|\bgas\b|fuel|rides?\b|commut/ },
  { label: 'rent', categories: ['rent'], words: /\brent\b|housing/ },
  { label: 'utilities', categories: ['utilities'], words: /utilit|electric|internet|broadband|phone bill/ },
  { label: 'subscriptions', categories: ['subscriptions'], words: /subscription|streaming|netflix|spotify/ },
  { label: 'shopping', categories: ['shopping'], words: /shopping|amazon|clothes|clothing/ },
  { label: 'health', categories: ['health'], words: /health|medical|pharmacy|doctor/ },
  { label: 'entertainment', categories: ['entertainment'], words: /entertainment|movies?|concerts?|games?\b/ },
];

/** Known category (with aliases), or whatever follows "spend on" so unknown ones get an honest empty answer. */
function detectSpendTopic(text: string): SpendTopic | null {
  const known = SPEND_TOPICS.find(t => t.words.test(text));
  if (known) return { label: known.label, categories: known.categories };
  const m = text.match(/\b(?:spen[dt]|spending|paid|pay)\s+(?:on|for)\s+([a-z][a-z &-]{1,30}?)(?=\s+(?:in|during|over|since|this|last|for)\b|[?.!,]|$)/);
  const word = m?.[1]?.trim();
  return word ? { label: word, categories: [word] } : null;
}

interface DateRange {
  from: string;
  to: string;
  label: string;
  isDefault: boolean;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, nine: 9, twelve: 12 };

function parseRange(text: string): DateRange {
  const today = startOfToday();
  const todayStr = ymd(today);
  const monthsBack = (n: number): DateRange => ({
    from: ymd(new Date(today.getFullYear(), today.getMonth() - (n - 1), 1)),
    to: todayStr,
    label: n === 1 ? 'this month' : `in the last ${n} months`,
    isDefault: n === 6,
  });

  const year = text.match(/\b(19|20)\d{2}\b/)?.[0];
  if (year) {
    const end = `${year}-12-31`;
    return { from: `${year}-01-01`, to: end < todayStr ? end : todayStr, label: `in ${year}`, isDefault: false };
  }
  if (/\bthis month\b/.test(text)) return monthsBack(1);
  if (/\blast month\b/.test(text)) {
    return {
      from: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: ymd(new Date(today.getFullYear(), today.getMonth(), 0)),
      label: 'last month',
      isDefault: false,
    };
  }
  if (/\bthis year\b/.test(text)) return { from: `${today.getFullYear()}-01-01`, to: todayStr, label: 'this year', isDefault: false };
  if (/\b(last|past) year\b/.test(text)) return { ...monthsBack(12), label: 'in the last 12 months' };
  const n = text.match(/\b(?:last|past)\s+(\d{1,2}|one|two|three|four|five|six|nine|twelve)\s+months?\b/)?.[1];
  if (n) {
    const count = Math.min(Math.max(NUMBER_WORDS[n] ?? Number(n), 1), 24);
    return monthsBack(count);
  }
  return monthsBack(6);
}

function monthKeysBetween(from: string, to: string): string[] {
  const keys: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  while (keys.length < 24) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > endKey) break;
    keys.push(key);
    if (++m > 12) { m = 1; y++; }
  }
  return keys;
}

const titleCase = (t: string) => t.replace(/\b[a-z]/g, c => c.toUpperCase());

async function answerSpendQuestion(repo: IRepo, topic: SpendTopic, range: DateRange, callbacks: AgentCallbacks): Promise<void> {
  const cats = topic.categories.length ? topic.categories : [undefined];
  const byId = new Map<string, Transaction>();
  for (const category of cats) {
    for (const t of repo.query({ category, from: range.from, to: range.to }) as Transaction[]) {
      if (t.amount < 0 && t.category !== 'income') byId.set(t.id, t);
    }
  }
  const rows = Array.from(byId.values()).sort((a, b) => b.date.localeCompare(a.date));
  const total = Math.abs(rows.reduce((s, t) => s + t.amount, 0));
  const keys = monthKeysBetween(range.from, range.to);
  const monthly = keys.map(k => Math.round(Math.abs(rows.filter(r => r.date.startsWith(k)).reduce((s, r) => s + r.amount, 0))));
  const label = topic.label === 'total' ? 'total' : topic.label;
  const title = topic.label === 'total' ? 'Spending' : `${titleCase(topic.label)} spending`;
  const subtitle = `${titleCase(range.label.replace(/^in /, ''))}`;

  if (rows.length === 0) {
    const history = repo.query({}) as Transaction[];
    const dates = history.map(t => t.date).sort();
    const first = dates[0];
    const lastDate = dates[dates.length - 1];
    const recentCats = (repo.query({ from: monthKeys(6)[0] + '-01', to: ymd(startOfToday()), groupBy: 'category' }) as GroupedResult[])
      .filter(c => c.total < 0)
      .sort((a, b) => a.total - b.total)
      .slice(0, 6);
    const coverage = first && lastDate ? `${monthLabel(first)} to ${monthLabel(lastDate)}` : 'no dates yet';
    await streamText(
      `I don't see any **${label}** spending ${range.label}. ` +
      (first ? `Your transaction history covers ${coverage}, so there is nothing to total for that period. ` : '') +
      (recentCats.length ? `In the last 6 months your biggest categories were ${recentCats.slice(0, 3).map(c => c.key).join(', ')}.` : ''),
      callbacks.onText,
    );
    callbacks.onDashboard({
      title,
      subtitle: `${subtitle} · no matching transactions`,
      widgets: [
        { type: 'kpi', span: 1, title: `Spent ${range.label}`, value: '$0', delta: 'no matching transactions', trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Transactions', value: '0', trend: 'flat' },
        { type: 'kpi', span: 2, title: 'History available', value: coverage, trend: 'flat' },
        { type: 'chart', span: 2, kind: 'bar', title: `${titleCase(label)} by month`, format: 'currency', categories: [], series: [] },
        {
          type: 'chart', span: 2, kind: 'donut', title: 'Top categories, last 6 months', format: 'currency',
          categories: recentCats.map(c => c.key),
          series: [{ name: 'Spend', values: recentCats.map(c => Math.round(Math.abs(c.total))) }],
        },
        { type: 'grid', span: 4, title: 'Matching transactions', columns: TXN_COLUMNS, rows: [] },
      ],
    });
    return;
  }

  const byMerchant = new Map<string, number>();
  for (const t of rows) byMerchant.set(t.merchant, (byMerchant.get(t.merchant) ?? 0) + Math.abs(t.amount));
  const merchants = Array.from(byMerchant.entries()).sort((a, b) => b[1] - a[1]);
  const top = merchants.slice(0, 6);
  const avg = total / Math.max(keys.length, 1);

  await streamText(
    `You spent **${money(total)}** on ${label === 'total' ? 'everything' : `**${label}**`} ${range.label} across ${rows.length} transactions` +
    (keys.length > 1 ? `, about **${money(avg)} a month**. ` : '. ') +
    `The biggest share went to **${top[0][0]}** (${money(top[0][1])}).`,
    callbacks.onText,
  );
  callbacks.onDashboard({
    title,
    subtitle,
    widgets: [
      { type: 'kpi', span: 1, title: `Spent ${range.label}`, value: money(total), trend: 'flat', sparkline: monthly.length > 1 ? monthly : undefined },
      { type: 'kpi', span: 1, title: 'Average per month', value: money(avg), delta: `${keys.length} month${keys.length === 1 ? '' : 's'}`, trend: 'flat' },
      { type: 'kpi', span: 1, title: 'Transactions', value: String(rows.length), trend: 'flat' },
      { type: 'kpi', span: 1, title: 'Top merchant', value: top[0][0], delta: money(top[0][1]), trend: 'flat' },
      { type: 'chart', span: 2, kind: 'bar', title: `${titleCase(label)} by month`, format: 'currency', categories: keys.map(monthLabel), series: [{ name: 'Spend', values: monthly }] },
      { type: 'chart', span: 2, kind: 'donut', title: 'By merchant', format: 'currency', categories: top.map(([m]) => m), series: [{ name: 'Spend', values: top.map(([, v]) => Math.round(v)) }] },
      { type: 'grid', span: 4, title: 'Transactions', columns: TXN_COLUMNS, rows: rows.slice(0, 150).map(t => ({ ...t })), groupBy: topic.categories.length > 1 ? ['category'] : undefined },
    ],
  });
}

// ─── Mock agent (no LLM key) ────────────────────────────────────────────────

function extractProductQuery(text: string): string {
  const m = text.match(/afford (?:a |an |the )?(.+?)[?.!]*$/i) ?? text.match(/(?:buy|get|purchase) (?:a |an |the )?(.+?)[?.!]*$/i);
  return (m?.[1] ?? text).trim();
}

async function runMockAgent(
  userMessages: ChatMessage[],
  repo: IRepo,
  pendingActions: Map<string, PendingAction>,
  callbacks: AgentCallbacks,
): Promise<void> {
  const executor = buildToolExecutor(repo, pendingActions);
  const last = (userMessages.filter(m => m.role === 'user').pop()?.content ?? '').toLowerCase();
  const profile = repo.profile();
  const today = startOfToday();

  await sleep(350);

  // 1. Affordability verdict
  if (/\bafford\b|\bps5\b|\b(should|can|could) i (buy|get|purchase)\b|\bworth buying\b/.test(last)) {
    const query = extractProductQuery(last);
    const statedPrice = parseStatedPrice(last);
    const found = await executor('find_product', { query, price: statedPrice }) as (ProductInfo & { source?: string }) | { error: string };
    // Channel3, the mock catalog, or a seeded estimate: always a product with a positive price.
    const product: ProductInfo & { source?: string } =
      'price' in found && Number.isFinite(found.price) && found.price > 0 ? found : findMockProduct(query, statedPrice);
    const verdict = computeAffordabilityVerdict(repo, product.price);
    const cashflow = projectCashflow(repo, product.price);
    const action = await executor('propose_paypal_order', { amount: product.price, description: product.title }) as PendingAction;

    const label = verdict.decision === 'no' ? '**No**' : verdict.decision === 'wait' ? '**Wait**' : '**Yes**';
    const text =
      `${label}. The ${product.title} ${product.source === 'estimate' ? `is about **${money(product.price, true)}** (${statedPrice ? 'the price you gave' : 'a typical price; I could not look up a live one'})` : `costs **${money(product.price, true)}**`}. ` +
      `After your remaining bills and normal spending, you'd end the month at **${money(verdict.endOfMonthBalance)}**` +
      `${verdict.endOfMonthBalance < 0 ? ' overdrawn' : ''}, against a **${money(verdict.safetyBuffer)}** safety buffer. ` +
      (verdict.decision === 'yes'
        ? 'You can approve the PayPal order below.'
        : `Payday is ${verdict.daysUntilIncome} days away. If you still want it now, you can override and approve the PayPal order below.`);

    await streamText(text, callbacks.onText);
    callbacks.onAction(action);
    callbacks.onDashboard({
      title: 'Affordability check',
      subtitle: `${product.title} · ${product.retailer}`,
      widgets: [
        { type: 'kpi', span: 1, title: 'Price', value: money(product.price, true), delta: product.retailer, trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Month-end without it', value: money(verdict.projectedEoMWithoutPurchase), delta: 'bills and normal spend', trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Month-end with it', value: `${verdict.endOfMonthBalance < 0 ? '-' : ''}${money(verdict.endOfMonthBalance)}`, delta: `-${money(product.price)}`, trend: 'down', sparkline: cashflow.points.map(p => p.balance) },
        { type: 'kpi', span: 1, title: 'Safety buffer', value: money(verdict.safetyBuffer), delta: '15% of income', trend: verdict.endOfMonthBalance >= verdict.safetyBuffer ? 'up' : 'down' },
        {
          type: 'verdict', span: 2,
          item: { title: product.title, price: product.price, image: product.image || undefined, retailer: product.retailer },
          decision: verdict.decision, reasoning: verdict.reasoning, endOfMonthBalance: verdict.endOfMonthBalance, actionId: action.id,
        },
        {
          type: 'timeline', span: 2, title: 'Balance to month end, if you buy today',
          points: cashflow.points, events: cashflow.events, safetyLine: cashflow.safetyLine,
        },
      ],
    });
    return;
  }

  // 2. Food spend over the last 6 months (other periods go through the generic spend answer below)
  const range = parseRange(last);
  if (/food|grocer|restaurant|dining|\beat|delivery/.test(last) && range.isDefault) {
    const keys = monthKeys(6);
    const groceries = spendByMonth(repo, keys, 'groceries');
    const restaurants = spendByMonth(repo, keys, 'restaurants');
    const delivery = spendByMonth(repo, keys, 'food delivery');
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
    const total = sum(groceries) + sum(restaurants) + sum(delivery);
    const monthlyTotals = keys.map((_, i) => groceries[i] + restaurants[i] + delivery[i]);

    const rows = (repo.query({ from: `${keys[0]}-01`, to: ymd(today) }) as Transaction[])
      .filter(t => ['groceries', 'restaurants', 'food delivery'].includes(t.category))
      .sort((a, b) => b.date.localeCompare(a.date));

    const diningShare = Math.round(((sum(restaurants) + sum(delivery)) / Math.max(total, 1)) * 100);
    await streamText(
      `Over the last 6 months you spent **${money(total)}** on food, about **${money(total / 6)} a month**. ` +
      `Groceries were **${money(sum(groceries))}**, restaurants **${money(sum(restaurants))}** and delivery **${money(sum(delivery))}**. ` +
      `Eating out is ${diningShare}% of your food budget.`,
      callbacks.onText,
    );
    callbacks.onDashboard({
      title: 'Food spending',
      subtitle: `${monthLabel(keys[0])} to ${monthLabel(keys[5])}`,
      widgets: [
        { type: 'kpi', span: 1, title: 'Total food spend', value: money(total), delta: '6 months', trend: 'flat', sparkline: monthlyTotals },
        { type: 'kpi', span: 1, title: 'Average per month', value: money(total / 6), trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Groceries', value: money(sum(groceries)), sparkline: groceries, trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Eating out', value: money(sum(restaurants) + sum(delivery)), delta: `${diningShare}% of food`, trend: 'up', sparkline: restaurants.map((v, i) => v + delivery[i]) },
        {
          type: 'chart', span: 3, kind: 'bar', title: 'Food spend by month', format: 'currency',
          categories: keys.map(monthLabel),
          series: [
            { name: 'Groceries', values: groceries },
            { name: 'Restaurants', values: restaurants },
            { name: 'Delivery', values: delivery },
          ],
        },
        {
          type: 'chart', span: 1, kind: 'donut', title: 'Split', format: 'currency',
          categories: ['Groceries', 'Restaurants', 'Delivery'],
          series: [{ name: 'Spend', values: [sum(groceries), sum(restaurants), sum(delivery)] }],
        },
        { type: 'grid', span: 4, title: 'Food transactions', columns: TXN_COLUMNS, rows: rows.slice(0, 120).map(t => ({ ...t })), groupBy: ['category'] },
      ],
    });
    return;
  }

  // 3. Autopay advisor (checked before projection because "bills" overlaps)
  if (/autopay|recurring|bills?\b|subscri/.test(last) && !/project/.test(last)) {
    const all = repo.recurringPayments();
    const notOnPayPal = all.filter(r => r.method !== 'paypal');
    const electricity = all.find(r => /electric/i.test(r.merchant));
    const candidate = electricity ?? notOnPayPal.find(r => r.category === 'utilities') ?? notOnPayPal[0];
    const totalMonthly = all.reduce((s, r) => s + Math.abs(r.amount), 0);

    let action: PendingAction | undefined;
    if (candidate) {
      action = await executor('propose_autopay', { merchant: candidate.merchant, amount: Math.abs(candidate.amount), cadence: candidate.cadence }) as PendingAction;
    }

    const elecHistory = electricity
      ? (repo.query({ category: 'utilities', from: ymd(addDays(today, -365)), to: ymd(today) }) as Transaction[])
          .filter(t => t.merchant === electricity.merchant)
      : [];

    await streamText(
      `You have **${all.length} recurring payments** totaling **${money(totalMonthly, true)} a month**. ` +
      (candidate
        ? `**${candidate.merchant}** is the best candidate for autopay: it's due around day ${candidate.dayOfMonth} every month and the last bill was **${money(candidate.amount, true)}**. ` +
          `I've drafted a PayPal subscription for it. Nothing is created until you approve.`
        : ''),
      callbacks.onText,
    );
    if (action) callbacks.onAction(action);

    const widgets: Widget[] = [
      { type: 'kpi', span: 1, title: 'Recurring payments', value: String(all.length), trend: 'flat' },
      { type: 'kpi', span: 1, title: 'Monthly committed', value: money(totalMonthly), delta: `${Math.round((totalMonthly / profile.monthlyIncome) * 100)}% of income`, trend: 'flat' },
      { type: 'kpi', span: 1, title: 'Paid via PayPal', value: String(all.filter(r => r.method === 'paypal').length), trend: 'flat' },
      { type: 'kpi', span: 1, title: 'Not on PayPal yet', value: String(notOnPayPal.length), trend: 'up' },
    ];
    if (elecHistory.length) {
      widgets.push({
        type: 'chart', span: 2, kind: 'line', title: `${electricity!.merchant}: last 12 bills`, format: 'currency',
        categories: elecHistory.map(t => monthLabel(t.date)),
        series: [{ name: 'Bill', values: elecHistory.map(t => Math.abs(t.amount)) }],
      });
    }
    widgets.push({
      type: 'chart', span: 2, kind: 'bar', title: 'Monthly cost by payment', format: 'currency',
      categories: all.map(r => r.merchant),
      series: [{ name: 'Monthly', values: all.map(r => Math.abs(r.amount)) }],
    });
    widgets.push({
      type: 'grid', span: 4, title: 'Recurring payments',
      columns: [
        { field: 'merchant', headerName: 'Merchant', type: 'text' },
        { field: 'category', headerName: 'Category', type: 'text' },
        { field: 'dayOfMonth', headerName: 'Due day', type: 'text' },
        { field: 'method', headerName: 'Method', type: 'text' },
        { field: 'amount', headerName: 'Amount', type: 'currency' },
      ],
      rows: all.map(r => ({ ...r })),
    });

    callbacks.onDashboard({ title: 'Autopay advisor', subtitle: 'Recurring payments you could move to PayPal', widgets });
    return;
  }

  // 4. Cash-flow projection
  if (/project|forecast|cash ?flow|expense|month end|end of (the )?month/.test(last)) {
    const cf = projectCashflow(repo);
    const keys = monthKeys(1);
    const spentSoFar = spendByMonth(repo, keys)[0];
    const projectedSpend = spentSoFar + cf.remainingBills + cf.dailyDiscretionary * (cf.points.length - 1);
    const cats = (repo.query({ from: `${keys[0]}-01`, to: ymd(today), groupBy: 'category' }) as GroupedResult[])
      .filter(c => c.total < 0)
      .sort((a, b) => a.total - b.total);

    await streamText(
      `You're on track to spend about **${money(projectedSpend)}** this month. ` +
      `So far you've spent **${money(spentSoFar)}**, with **${money(cf.remainingBills, true)}** in bills still due and roughly **${money(cf.dailyDiscretionary)}/day** in everyday spending. ` +
      `That puts your month-end balance at **${money(cf.endOfMonthBalance)}**, ${cf.endOfMonthBalance >= cf.safetyLine ? 'above' : 'below'} your ${money(cf.safetyLine)} safety line.`,
      callbacks.onText,
    );
    callbacks.onDashboard({
      title: 'This month, projected',
      subtitle: today.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      widgets: [
        { type: 'timeline', span: 3, title: 'Daily balance to month end', points: cf.points, events: cf.events, safetyLine: cf.safetyLine },
        { type: 'kpi', span: 1, title: 'Projected month spend', value: money(projectedSpend), delta: `of ${money(profile.monthlyIncome)} income`, trend: projectedSpend > profile.monthlyIncome ? 'up' : 'flat', sparkline: cf.points.map(p => p.balance) },
        { type: 'kpi', span: 1, title: 'Spent so far', value: money(spentSoFar), trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Bills still due', value: money(cf.remainingBills), trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Daily run-rate', value: money(cf.dailyDiscretionary), trend: 'flat' },
        { type: 'kpi', span: 1, title: 'Month-end balance', value: money(cf.endOfMonthBalance), trend: cf.endOfMonthBalance >= cf.safetyLine ? 'up' : 'down' },
        {
          type: 'chart', span: 2, kind: 'donut', title: 'Where it went this month', format: 'currency',
          categories: cats.map(c => c.key),
          series: [{ name: 'Spend', values: cats.map(c => Math.round(Math.abs(c.total))) }],
        },
        {
          type: 'grid', span: 2, title: 'Upcoming this month',
          columns: [
            { field: 'date', headerName: 'Date', type: 'date' },
            { field: 'label', headerName: 'Payment', type: 'text' },
            { field: 'amount', headerName: 'Amount', type: 'currency' },
          ],
          rows: cf.events.map(e => ({ ...e })),
        },
      ],
    });
    return;
  }

  // 5. Any other spending question, including categories or periods with no data
  const spendTopic = detectSpendTopic(last);
  if (spendTopic || /spen[dt]|spending|how much (did|have|do) i|cost me|paid (for|on)/.test(last)) {
    await answerSpendQuestion(repo, spendTopic ?? { label: 'total', categories: [] }, range, callbacks);
    return;
  }

  // 6. Fallback: overview
  await streamText(
    `Here's your overview, ${profile.name.split(' ')[0]}. Balance is **${money(repo.balance())}** and income is **${money(profile.monthlyIncome)}/month**. ` +
    `Ask me whether you can afford something, how much you spend on a category, or to project this month.`,
    callbacks.onText,
  );
  callbacks.onDashboard(buildDefaultDashboard(repo));
}

// ─── Default overview dashboard ─────────────────────────────────────────────

export function buildDefaultDashboard(repo: IRepo): DashboardSpec {
  const profile = repo.profile();
  const keys = monthKeys(6);
  const monthly = spendByMonth(repo, keys);
  const thisMonthSpend = monthly[monthly.length - 1];
  const lastMonthSpend = monthly[monthly.length - 2] ?? 0;
  const cats = (repo.query({ from: `${keys[0]}-01`, to: ymd(startOfToday()), groupBy: 'category' }) as GroupedResult[])
    .filter(c => c.total < 0)
    .sort((a, b) => a.total - b.total)
    .slice(0, 7);
  const cf = projectCashflow(repo);
  const savingsRate = Math.round(((profile.monthlyIncome - lastMonthSpend) / profile.monthlyIncome) * 100);

  return {
    title: 'Overview',
    subtitle: 'Your money at a glance',
    widgets: [
      { type: 'kpi', span: 1, title: 'Balance', value: money(repo.balance()), delta: `${money(cf.endOfMonthBalance)} at month end`, trend: 'flat', sparkline: cf.points.map(p => p.balance) },
      { type: 'kpi', span: 1, title: 'Monthly income', value: money(profile.monthlyIncome), delta: 'single source', trend: 'flat' },
      { type: 'kpi', span: 1, title: 'Spent this month', value: money(thisMonthSpend), delta: `${money(lastMonthSpend)} last month`, trend: 'flat', sparkline: monthly },
      { type: 'kpi', span: 1, title: 'Savings rate', value: `${savingsRate}%`, delta: 'last full month', trend: savingsRate >= 10 ? 'up' : 'down' },
      { type: 'chart', span: 2, kind: 'bar', title: 'Monthly spending', format: 'currency', categories: keys.map(monthLabel), series: [{ name: 'Spending', values: monthly }] },
      { type: 'chart', span: 2, kind: 'donut', title: 'Top categories, 6 months', format: 'currency', categories: cats.map(c => c.key), series: [{ name: 'Spend', values: cats.map(c => Math.round(Math.abs(c.total))) }] },
      { type: 'grid', span: 4, title: 'Recent transactions', columns: TXN_COLUMNS, rows: repo.recentTransactions(40).map(t => ({ ...t })) },
    ],
  };
}
