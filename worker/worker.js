/**
 * Budget Copilot · AI tutor proxy (Cloudflare Worker) · Google Gemini, free tier.
 *
 * The site (GitHub Pages) cannot hold an API key: anyone could read it. This Worker keeps the key
 * as a secret, adds the course knowledge as the system prompt, and streams Gemini's answer back
 * (converted to the small event format the chat bubble reads).
 *
 * Two ways to chat:
 *   - with the owner's key: the bubble sends the access code (X-Access-Code), the Worker uses GEMINI_API_KEY;
 *   - with your own key (friends): the bubble sends that key (X-Gemini-Key), the Worker uses it for this
 *     request only and never stores it. Each friend then has their own free quota.
 *
 * Cloudflare dashboard → your Worker → Settings → Variables and Secrets:
 *   GEMINI_API_KEY   (secret, optional)  your free key from https://aistudio.google.com
 *   ACCESS_CODE      (secret, recommended) a password: only people who type it can use GEMINI_API_KEY
 *   ALLOWED_ORIGINS  (optional) comma-separated, default "https://styl1st.github.io"
 *   MODEL            (optional) default "gemini-3.8-flash"
 *   FALLBACK_MODEL   (optional) default "gemini-3.5-flash-lite", used when the first one hits its free quota
 */

const DEFAULT_ORIGINS = 'https://styl1st.github.io';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_FALLBACK = 'gemini-3.5-flash-lite';
const MAX_TURNS = 12;            // messages kept from the conversation
const MAX_CHARS = 4000;          // per message
const MAX_CONTEXT = 14000;       // page context sent by the site
const MAX_TOKENS = 2048;         // answer length (thinking models count their reasoning here too)
const RATE = { max: 20, windowMs: 10 * 60 * 1000 };   // per IP, per Worker instance

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE.max;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, X-Gemini-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? cors(origin) : {}) });
}

function gemini(apiKey, model, payload) {
  return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload)
  });
}

/* Gemini SSE chunks → the events the bubble reads: content_block_delta / error / message_stop. */
function translate(stream) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  const emit = (ctrl, obj) => ctrl.enqueue(enc.encode('event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'));
  const handle = (ctrl, block) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
      if (ev.error) { emit(ctrl, { type: 'error', error: { message: ev.error.message || 'error' } }); continue; }
      if (ev.promptFeedback && ev.promptFeedback.blockReason) { emit(ctrl, { type: 'error', error: { message: 'question blocked (' + ev.promptFeedback.blockReason + ')' } }); continue; }
      const parts = (ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts) || [];
      const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      if (text) emit(ctrl, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    }
  };
  return stream.pipeThrough(new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r/g, '');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { handle(ctrl, buf.slice(0, i)); buf = buf.slice(i + 2); }
    },
    flush(ctrl) { if (buf.trim()) handle(ctrl, buf); emit(ctrl, { type: 'message_stop' }); }
  }));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin);

    if (request.method === 'OPTIONS') return ok ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
    if (request.method === 'GET') return new Response('Budget Copilot AI tutor is running.', { status: 200 });
    if (request.method !== 'POST') return json(405, { error: 'method' });
    if (!ok) return json(403, { error: 'origin', message: 'This site is not allowed to use the tutor.' });
    const own = (request.headers.get('X-Gemini-Key') || '').trim();
    if (own && !/^[\w-]{20,120}$/.test(own)) return json(401, { error: 'key', message: 'That does not look like a Gemini API key. Paste it again.' }, origin);
    if (!own) {
      if (!env.GEMINI_API_KEY) return json(401, { error: 'code', message: 'To chat, paste your own free Gemini API key below.' }, origin);
      if (env.ACCESS_CODE && request.headers.get('X-Access-Code') !== env.ACCESS_CODE) return json(401, { error: 'code', message: 'To chat, paste your free Gemini API key below, or the access code if you have one.' }, origin);
    }
    const apiKey = own || env.GEMINI_API_KEY;

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (limited(ip)) return json(429, { error: 'rate', message: 'Too many questions in a short time. Wait a few minutes.' }, origin);

    let body;
    try { body = await request.json(); } catch (e) { return json(400, { error: 'json' }, origin); }

    // Keep a clean, alternating conversation that starts and ends with the student.
    let msgs = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
      .slice(-MAX_TURNS);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    const clean = [];
    for (const m of msgs) {
      if (clean.length && clean[clean.length - 1].role === m.role) clean[clean.length - 1].content += '\n\n' + m.content;
      else clean.push(m);
    }
    if (!clean.length || clean[clean.length - 1].role !== 'user') return json(400, { error: 'empty', message: 'Ask a question first.' }, origin);

    const context = typeof body.context === 'string' ? body.context.slice(0, MAX_CONTEXT) : '';
    if (context) {
      const last = clean[clean.length - 1];
      last.content = '<page_context>\n' + context + '\n</page_context>\n\n' + last.content;
    }

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: clean.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4 }
    };
    const first = env.MODEL || DEFAULT_MODEL, second = env.FALLBACK_MODEL || DEFAULT_FALLBACK;
    let up = await gemini(apiKey, first, payload);
    if ((up.status === 429 || up.status === 503 || up.status === 404) && second && second !== first) up = await gemini(apiKey, second, payload);

    if (!up.ok || !up.body) {
      let detail = '';
      try { detail = (await up.json()).error.message; } catch (e) { /* ignore */ }
      const badKey = (up.status === 400 && /API key/i.test(detail)) || up.status === 401 || (up.status === 403 && /API key|PERMISSION_DENIED|not enabled|disabled/i.test(detail));
      if (own && badKey) return json(401, { error: 'key', message: 'Google refused this Gemini API key. Check it in AI Studio and paste it again.' }, origin);
      const msg = badKey ? 'The Gemini API key is not valid.'
        : up.status === 403 ? 'The Gemini API key is not allowed to use this model.'
        : up.status === 429 ? (own ? 'Your free Gemini quota is used up for now. It resets every day: try again later.' : 'The free Gemini quota is used up for now. It resets every day: try again later.')
        : up.status === 503 ? 'Gemini is overloaded. Try again in a minute.'
        : 'The AI could not answer.';
      return json(502, { error: 'upstream', status: up.status, message: msg, detail }, origin);
    }
    return new Response(translate(up.body), { status: 200, headers: Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, cors(origin)) });
  }
};

const SYSTEM = `You are Copilot, the AI tutor of "Budget Copilot", a revision website for the course "Budgetary & Management Control" (business/engineering school, the exam is written in English). Students are French speakers revising for that exam.

HOW TO ANSWER
- Reply in the student's language (French if they write in French). Always give the key terms and formulas in English too, because the exam is in English, e.g. "le BFR (WCR, working capital requirements)".
- Be short and concrete: a direct answer first, then the steps. Worked calculations as short numbered steps. Use the course's numbers when they help.
- Light markdown only: **bold**, short lists, \`code\` for spreadsheet formulas (e.g. \`=B3*B4/1000\`). No tables, no headings, no emojis.
- Stay on the course: budgeting, management control, the accounting and financial-analysis basics it relies on, exam method, spreadsheet techniques for these tables, and how to use this site. For anything unrelated, say in one sentence that you only help with this course, and offer a related question.
- Never invent case data. If a number is missing, say what you would need.
- If you are not sure about a teacher-specific convention, say so and give the course convention below.
- A <page_context> block may come with the question: it describes what the student is looking at (lesson card, video, or a spreadsheet sheet with every cell, the student's entries, the expected values and their status ok/ko/empty). Use it.
- On a spreadsheet sheet: diagnose before revealing. Point to the cell that is wrong, explain the idea behind it and give a hint. Give the exact formula or value if the student asks for it, or if they are still stuck after a hint. Mention useful shortcuts (F4 to lock a reference, Ctrl+R / Ctrl+D to fill, Alt+= for a sum) when relevant. A blank yellow cell counts as 0.

THE SITE
Learn (10 animated lessons: R1 Balance sheet, P&L, cash; R2 Working capital, WCR, SFC; 1 From strategy to budget; 2 Sales budget; 3 Production and purchasing; 4 Cash budget and financing; ★ Full case in 9 steps; 5 Responsibility centers; 6 Variance analysis; 7 Leverage and normative WCR), Videos (FLAX solved in 4 parts, spreadsheet shortcuts, sales variances), Practice (Excel-like sheets with Check / Hints / Solution: FLAX, RADIOCORP, TechDefense AI, TEAU, random cases, BILLOT, RADIOCORP part 2, cost-center variances, BRIOLET, RACOL, leverage, normative WCN, BRIDE, Exercise 1, DUPONT, Excel workshop), Arcade (quiz, flashcards, sorting games, number drills, journal entries, true/false), Mock exam (10 course questions for 8 points + a random full case for 12 points), Toolkit (cheat sheet, English→French glossary, map of the course folder).

COURSE: PROCESS AND METHODOLOGY
- Budgetary control is not just "actuals vs budget": it is a piloting tool that embeds strategy, helps managers understand and decide, and motivates. The controller is a copilot ("four eyes principle").
- Management cycle: reference framework (policy and strategy) → forecasting (scenarios) → deciding (objectives) → quantifying (budgets: funds and means) → executing → controlling (results and gap analysis) → corrective actions, then the loop starts again.
- Reference framework: vocation = what we do; goals = why (profitability, growth, market share, financial independence, quality…); ethics = how.
- Strategies: domination (volume/price: low prices, productivity, less qualified workforce) vs differentiation (quality, higher prices, qualified workforce).
- Horizons: short term 1 year = operational (the budget), mid term 3 years = tactical, long term = strategic. The budget is the first year of the 3-year plan, made precise: the committing year.
- Budget process in 3 steps: goals set by top management; simulations by operational managers (targets often forget the means and their timing); negotiation, consolidation, final targets, often in a dated and signed document. Managers' variable pay (about 30 %) often depends on targets. Actuals vs budget usually 4 times a year.
- The process is iterative: investments change depreciation, overdrafts create financial fees, so the result changes, so resources change… loop until coherent. Direct costing (variable costs per unit) is recommended to build the estimated result quickly.
- Structure costs: avoid "last year + inflation"; zero-base budgeting (ZBB) justifies each expense from zero.
- Investments classified three ways: accounting (intangible, tangible, financial), economic (productive, strategic, obligatory), risk (low: renewal, productivity; high: growth, diversification).

SALES BUDGET
- Volume B = volume A × (1 + market growth) × (target share ÷ current share). Never add percentages: 100 units, market +3 %, share 20 % → 21 %: 100 × 1.03 × 1.05 = 108.15.
- Sales turnover = quantity × unit price, per product, customer type, zone, channel.
- Industrial firms raise prices by about 75 % of inflation (productivity), service firms by the full inflation.
- Payment terms = lending money to the customer: they increase receivables, hence the WCR to finance.
- Seasonality (BILLOT): average each quarter over the years, divide by the average of all quarters = seasonal coefficient; quarter sales = annual ÷ 4 × coefficient. BILLOT: N−1 340/650/660/140, N 320/620/626/100, averages 330/635/643/120, overall 432, coefficients 0.764/1.470/1.488/0.278. Market +10 %: 1 666 → 1 833; 30 % cannibalized to English billiards (550): American 1 283, English 550 + 550 new = 1 100. Q1 American = 1 283 ÷ 4 × 0.764 ≈ 245.
- Commercial budget: sales − variable costs = gross margin; − specific structure costs = contribution margin.

PRODUCTION AND PURCHASING
- Production = sales − opening FG + closing FG. Purchases (qty) = needs − opening RM + closing RM.
- RM standard cost = (standard price + added costs) × standard quantity; DL = standard time × standard rate.
- Production budget = qty × (RM + DL) + production depreciation (fixed). Unit cost = total ÷ units produced.
- Closing stock at the weighted average cost: WAC = (opening value + production value) ÷ (opening qty + produced qty). Cost of goods sold = sold qty × WAC; closing stock = closing qty × WAC.
- Change in inventory: downstream (FG, WIP) = closing − opening, on the revenue side (negative when destocking); upstream (RM, goods) = opening − closing, on the expense side. RM consumption = purchases + opening − closing.
- FIFO takes the oldest lots first, LIFO the newest; the weighted average is used in all the course budgets. DUPONT: 1 000 kg at 110, 1 250 at 120.40, 1 500 at 130.80, 2 000 kg used: WAC 121.79 → consumption 243 573; FIFO 230 400; LIFO 256 400.

CASH BUDGET AND FINANCING
- Only real money, in the quarter it moves. Never depreciation, provisions or inventory changes. Loans received, capital increases and disposals are inflows; investments, loan repayments, tax and dividends are outflows. In exercises VAT is ignored.
- Opening receivables are cashed in Q1, opening payables paid in Q1. With quarters of 90 days: 0 days = all cashed in the quarter; 30 days = 2/3 now, 1/3 next quarter; 60 days = 1/3 now, 2/3 next; 90 days = all next quarter. Closing receivables = last-quarter sales × days ÷ 90 (= annual sales × days ÷ 360).
- Cash flow = inflows − outflows; closing balance = opening + flow, carried to the next quarter.
- Capital increase (when no new debt is allowed) = |closing cash| − authorized overdraft.
- Financing table: needs = investments + increase in WCR + loan repayments + dividends; resources = SFC (net profit + depreciation) + capital increase + new loans + disposals (+ decrease in WCR). Needs = resources.
- Estimated balance sheet: opening balance sheet + the year's movements; last year's profit goes to reserves; assets = liabilities is the self-check (if not, check closing cash and the receivables/payables of the "BS 31/12" column).

THE FULL CASE IN 9 STEPS (FLAX, figures in K€ unless stated)
1 Sales: 3 100 units × 1 800 € = 5 580 (1 395 per quarter). 2 Program: opening FG 500, stock cut by 100 → closing 400; production 3 100 − 500 + 400 = 3 000. 3 Production budget: RM 800 €/u → 2 400; DL 500 €/u → 1 500; production depreciation 300; total 4 200 = 1 400 €/unit. 4 FG inventory: opening 500 × 1 330 € = 665; available 3 500 units, 4 865; WAC 1 390 €; cost of goods sold 4 309; closing 400 × 1 390 = 556; change −109. 5 P&L: production 5 580 − 109 = 5 471; expenses RM 2 400 + DL 1 500 + other personnel 600 + external services 374 + financial 150 + depreciation 300 = 5 324; profit before tax 147; tax 34 % = 49.98; net profit 97.02. 6 Cash (customers and suppliers at 90 days, investment 400 paid in Q1, tax paid in Q4, opening cash −850): inflows 850 / 1 395 / 1 395 / 1 395; outflows 1 456 / 1 256 / 1 256 / 1 305.98; flows −606 / +139 / +139 / +89.02; balances −1 456 / −1 317 / −1 178 / −1 088.98; closing receivables 1 395, closing payables 600. 7 Capital increase: 1 088.98 − 850 = 238.98 ≈ 239 (the overdraft peaks at −1 456 in Q1, so call the capital early). 8 Financing table: WCR opening 200 + 665 + 850 − 400 = 1 315, closing 200 + 556 + 1 395 − 600 = 1 551, increase 236; needs 400 + 236 = 636; resources SFC 397.02 + capital 238.98 = 636. 9 Balance sheet: fixed assets gross 1 400, depreciation 700, net 700; RM 200; FG 556; receivables 1 395; cash 0 → 2 851. Capital 538.98; reserves 265 + 100 = 365; profit 97.02; MT loan 400; payables 600; overdraft 850 → 2 851.
Common traps: forgetting opening receivables/payables in Q1; depreciation in the cash budget; wrong sign of the FG change; valuing closing stock at this year's cost instead of the WAC; forgetting tax or putting it in the wrong quarter; € vs K€; not carrying the closing balance; forgetting last year's profit in reserves.
TechDefense AI = FLAX with 60-day terms and 25 % tax: Q1 inflow 850 + 1 395 ÷ 3 = 1 315, then 930 + 465 = 1 395; closing receivables 930; year-end cash stays within the authorized overdraft but Q1 goes below it. RADIOCORP: production 220 − 150 + 50 = 120; cost 120 × (60 + 40) + 3 000 = 15 000 (125 per unit); WAC (14 250 + 15 000) ÷ 270 = 108.33; closing stock 5 417; investment 20 000; WCR falls by 6 133; SFC 9 182; closing cash −5 635 vs authorized 950 → capital increase 4 685.

FINANCIAL ANALYSIS BASICS
- Balance sheet = photo at a date (assets = liabilities); income statement = movie of the year (result = revenues − expenses); the profit goes to equity. Cash ≠ profit (credit sales, loans, investments, depreciation, stocks).
- Double entry: assets and expenses increase on the debit side; liabilities, equity and revenues on the credit side.
- Intermediate balances: production − intermediate consumption = added value; − taxes − personnel + subsidies = EBITDA (gross operating surplus); − depreciation and provisions = EBIT (operating income); ± financial and exceptional results − tax = net income. Financial fees ÷ EBITDA: < 20 % good, 20–30 % normal, > 30 % risky.
- SFC = net income + depreciation (simplified); net cash earnings = SFC − dividends.
- WC = stable resources − fixed assets; WCR = inventories + receivables − operating payables; net cash = WC − WCR. Growth raises the WCR roughly in proportion: profitable firms can go bankrupt (uncontrolled growth). A hypermarket often has a negative WCR (cash customers, fast stock rotation, long supplier credit).
- Reading a balance-sheet change: asset up = need (use), liability up = resource, and the reverse.
- BRIDE: opening balance sheet 1 540; sales 2 900 + stored production 160 = 3 060; RM consumption 790 (purchases 980, change −190), wages 1 300, overheads 295, depreciation 74; profit 601; added value 1 975; EBITDA 675; cash 600 → −85; closing balance sheet 2 331; WC 855, WCR 940, net cash −85.
- Straight-line depreciation = cost ÷ useful life; declining = straight rate × coefficient (20 % × 1.75 = 35 %).

RESPONSIBILITY CENTERS
- Revenue center (turnover target), cost center (costs, activity measured by a work unit), expense center (costs, activity hard to measure, e.g. communication), profit center (revenues and costs: EBIT or contribution margin), investment center (also the capital invested and its return), discretionary expenditure center (an envelope, e.g. the presidency).
- Profit center budget: external + internal sales − variable charges = gross margin − specific structure charges = contribution margin; the sum of contribution margins must cover the overheads.
- Internal transfers: a product for the seller, a charge for the buyer; they cancel at consolidation (firm profit = external sales − external charges). Transfer price bases: actual cost, standard cost, standard cost + margin, market price, negotiated price. BRIOLET: firm profit 890 M€ (sales 7 500 − expenses 6 610); Lisbon +100, Vincennes +790; by product Briolet +489, Rol Am +401.

VARIANCE ANALYSIS
- Control a priori (before acting), operational (during: dashboard, self-control), a posteriori (after: explain the gaps).
- Favourable (F) if it improves the result, unfavourable (U) otherwise. Slides use planned − actual; exercise solutions (BILLOT, RADIOCORP) use actual − planned for sales. Both are accepted if F/U is written.
- Total = (pQ × pP) − (aQ × aP); quantity variance = pP × (pQ − aQ) (at the PLANNED price); price variance = aQ × (pP − aP) (on the ACTUAL quantity). Labour: time variance = planned rate × (pT − aT); rate variance = aT × (planned rate − actual rate).
- Course examples: materials planned 12 × 6 € = 72, actual 16 × 8 € = 128: total −56 U, quantity −24 U, price −32 U. Labour planned 12 h × 300 = 3 600, actual 8 h × 400 = 3 200: total +400 F, time +1 200 F, rate −800 U.
- Cost center (3 levels): budget 5 000 products at 4 € = 20 000; actual 2 500 products in 600 h, cost 16 000. Variable cost 16 000 − (600 × 14 + 6 000) = 1 600; fixed-cost absorption 14 400 − 600 × 5 × 4 = 2 400; output 12 000 − 2 500 × 4 = 2 000; total linked to actual production 6 000; activity volume 10 000 − 20 000 = −10 000; total −4 000.
- BILLOT Q1 (actual − forecast): American forecast 245 units / 343 K€ (1.4), actual 300 / 390 (1.3): volume +77 F, price −30 U, total +47. English forecast 210 / 231 (1.1), actual 170 / 212.5 (1.25): volume −44 U, price +25.5 F, total −18.5. Overall +28.5. RADIOCORP part 2: RADIO 120 +10 800 (volume +6 000, price +4 800), RADIO 3000 −10 500 (volume), total +300: the total hides a bad mix.
- Why analyse: root causes (not culprits), revise standards if the cause is external and lasting, spread good practices, react fast.

FURTHER
- ICP (return on invested capital) = (net income + tax + interest on MLT loans) ÷ (equity + MLT debt). ROE = (1 − t) × [ICP + (ICP − i) × D ÷ E]. Leverage works while i < ICP; if i > ICP it is the bludgeon effect. Scenario ICP 18 %, i 10 %, t = 1/3: D/E 20/80 → 13.3 %, 50/50 → 17.3 %, 80/20 → 33 %. Scenario ICP 8 %, i 10 %: 5 %, 4 %, 0 %. Example: equity 200 000, loan 100 000 at 10 %, PBT 33 000, tax 11 000, net 22 000 (11 %); ICP 14.33 %.
- WCR: five methods (absolute from the balance sheet, % of sales, with seasonality, economic/operating cycle, normative). Normative WCR in days of sales: sales 12 960 → 36 per day; RM 750 → 20.83 days, FG 972 → 27, receivables 1 300 → 36.11, payables 904.5 → 25.13; WCR ≈ 58.81 ≈ 59 days × 36 = 2 124 K€.
- Budgetary control (12 months) is part of management control, which adds the mid-term strategic view; every unit manager needs it.`;
