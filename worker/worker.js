/**
 * Budget Copilot · AI tutor proxy (Cloudflare Worker).
 *
 * The site (GitHub Pages) cannot hold an API key: anyone could read it. This Worker adds the course
 * knowledge as the system prompt, calls the AI and streams the answer back (converted to the small
 * event format the chat bubble reads).
 *
 * Two ways to chat:
 *   - bring your own key: the bubble sends X-Provider (gemini, groq, mistral, openrouter, openai,
 *     anthropic), X-Api-Key and optionally X-Model. The key is used for this request only, never stored.
 *   - the owner's key: the bubble sends the access code (X-Access-Code), the Worker uses GEMINI_API_KEY.
 *
 * Cloudflare dashboard → your Worker → Settings → Variables and Secrets (all optional):
 *   GEMINI_API_KEY   (secret) the owner's free key from https://aistudio.google.com
 *   ACCESS_CODE      (secret) a password: only people who type it can use GEMINI_API_KEY
 *   ALLOWED_ORIGINS  comma-separated, default "https://styl1st.github.io"
 *   MODEL            default "gemini-3.8-flash" (owner's key)
 *   FALLBACK_MODEL   default "gemini-3.5-flash-lite", used when Gemini's free quota is used up
 */

const DEFAULT_ORIGINS = 'https://styl1st.github.io';
const MAX_TURNS = 12;            // messages kept from the conversation
const MAX_CHARS = 4000;          // per message
const MAX_CONTEXT = 14000;       // page context sent by the site
const MAX_TOKENS = 2048;         // answer length
const RATE = { max: 20, ownMax: 60, windowMs: 10 * 60 * 1000 };   // per IP, per Worker instance (own keys: friends on one school Wi-Fi share an IP)

/* Every AI the bubble can use. kind = which API shape it speaks. */
const PROVIDERS = {
  gemini: { name: 'Gemini', kind: 'gemini', model: 'gemini-3.8-flash', fallback: 'gemini-3.5-flash-lite' },
  groq: { name: 'Groq', kind: 'openai', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile' },
  mistral: { name: 'Mistral', kind: 'openai', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  openrouter: { name: 'OpenRouter', kind: 'openai', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free' },
  openai: { name: 'OpenAI', kind: 'openai', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-5-mini', reasoning: true },
  anthropic: { name: 'Claude', kind: 'anthropic', url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5' }
};

const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, X-Provider, X-Api-Key, X-Model, X-Gemini-Key, X-Check',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function json(status, obj, origin) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, origin ? cors(origin) : {}) });
}

/* One upstream call, in the shape each API expects. msgs = [{role: 'user'|'assistant', content}]. */
function callAI(p, key, model, msgs, origin) {
  if (p.kind === 'gemini') {
    return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.4 }
      })
    });
  }
  if (p.kind === 'anthropic') {
    return fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, system: SYSTEM, messages: msgs, max_tokens: MAX_TOKENS, temperature: 0.4, stream: true })
    });
  }
  // OpenAI-compatible: OpenAI, Groq, Mistral, OpenRouter
  const body = { model, stream: true, messages: [{ role: 'system', content: SYSTEM }].concat(msgs) };
  if (p.reasoning) body.max_completion_tokens = 4 * MAX_TOKENS;   // reasoning models: no temperature, reasoning counts here
  else { body.max_tokens = MAX_TOKENS; body.temperature = 0.4; }
  const headers = { 'content-type': 'application/json', 'authorization': 'Bearer ' + key };
  if (p === PROVIDERS.openrouter) { headers['HTTP-Referer'] = origin; headers['X-Title'] = 'Budget Copilot'; }
  return fetch(p.url, { method: 'POST', headers, body: JSON.stringify(body) });
}

/* Key check for the bubble's "Connect" button: lists the models this key can use. Listing models is
   free on every provider, so checking a key never spends the student's quota. */
const LISTS = {
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', prefer: /flash(?!-lite)/,
    pick: j => (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, '')).filter(id => /gemini/.test(id) && !/embed|image|tts|live|audio|robotics|computer|native|vision/.test(id)) },
  groq: { url: 'https://api.groq.com/openai/v1/models', prefer: /70b|120b/, pick: j => (j.data || []).map(m => m.id).filter(id => !/whisper|guard|tts|orpheus|playai|distil|compound/.test(id)) },
  mistral: { url: 'https://api.mistral.ai/v1/models', prefer: /small-latest/, pick: j => (j.data || []).filter(m => !m.capabilities || m.capabilities.completion_chat).map(m => m.id).filter(id => !/embed|moderation|ocr|transcri|voxtral/.test(id)) },
  openrouter: { url: 'https://openrouter.ai/api/v1/key', prefer: /free/, pick: () => ['openrouter/free'] },
  openai: { url: 'https://api.openai.com/v1/models', prefer: /mini/, pick: j => (j.data || []).map(m => m.id).filter(id => /^(gpt-|o\d|chatgpt)/.test(id) && !/audio|realtime|tts|transcribe|image|search|embed|instruct|moderation|codex|dall|preview/.test(id)) },
  anthropic: { url: 'https://api.anthropic.com/v1/models?limit=100', prefer: /haiku/, pick: j => (j.data || []).map(m => m.id) }
};
async function checkKey(pid, p, key) {
  const L = LISTS[pid];
  const headers = p.kind === 'gemini' ? { 'x-goog-api-key': key } : p.kind === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + key };
  const res = await fetch(L.url, { headers });
  if (!res.ok) return { status: res.status, detail: await errorDetail(res) };
  let ids = [];
  try { ids = L.pick(await res.json()); } catch (e) { /* keep the default model */ }
  ids = [...new Set(ids)].sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).slice(0, 60);
  const best = ids.includes(p.model) ? p.model : (ids.find(id => L.prefer.test(id)) || ids[0] || p.model);
  return { ok: true, model: best, models: [best].concat(ids.filter(id => id !== best)) };
}

/* Upstream SSE → the events the bubble reads: content_block_delta / error / message_stop. */
function translate(stream, kind) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = '';
  const emit = (ctrl, obj) => ctrl.enqueue(enc.encode('event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n'));
  const text = (ctrl, t) => { if (t) emit(ctrl, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }); };
  const fail = (ctrl, m) => emit(ctrl, { type: 'error', error: { message: m || 'error' } });
  const handle = (ctrl, block) => {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
      if (ev.error) { fail(ctrl, ev.error.message || String(ev.error)); continue; }
      if (kind === 'gemini') {
        if (ev.promptFeedback && ev.promptFeedback.blockReason) { fail(ctrl, 'question blocked (' + ev.promptFeedback.blockReason + ')'); continue; }
        const parts = (ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts) || [];
        text(ctrl, parts.filter(x => !x.thought).map(x => x.text || '').join(''));
      } else if (kind === 'anthropic') {
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') text(ctrl, ev.delta.text);
      } else {
        const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (d && typeof d.content === 'string') text(ctrl, d.content);
      }
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

async function errorDetail(res) {
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; return String((e && (e.message || e)) || j.message || j.detail || t).slice(0, 300); }
    catch (e) { return t.slice(0, 300); }
  } catch (e) { return ''; }
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

    // Who pays for this answer: the visitor's own key, or the owner's key behind the access code.
    const h = n => (request.headers.get(n) || '').trim();
    let pid = h('X-Provider').toLowerCase(), key = h('X-Api-Key');
    if (!key && h('X-Gemini-Key')) { pid = 'gemini'; key = h('X-Gemini-Key'); }   // older version of the bubble
    const own = !!key;
    let p, model;
    if (own) {
      p = PROVIDERS[pid];
      if (!p) return json(401, { error: 'key', message: 'Pick an AI in the list.' }, origin);
      if (!/^[\w.\-]{16,300}$/.test(key)) return json(401, { error: 'key', message: 'That does not look like a ' + p.name + ' API key. Paste it again.' }, origin);
      const m = h('X-Model');
      if (m && !/^[\w.:\/\-]{1,100}$/.test(m)) return json(400, { error: 'model', message: 'That model name is not valid.' }, origin);
      model = m || p.model;
    } else {
      if (!env.GEMINI_API_KEY) return json(401, { error: 'code', message: 'To chat, pick an AI below and paste your own API key.' }, origin);
      if (env.ACCESS_CODE && h('X-Access-Code') !== env.ACCESS_CODE) return json(401, { error: 'code', message: 'To chat, pick an AI below and paste your own API key, or the access code if you have one.' }, origin);
      p = PROVIDERS.gemini; key = env.GEMINI_API_KEY; model = env.MODEL || p.model;
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (limited(ip + (own ? ':own' : ''), own ? RATE.ownMax : RATE.max)) return json(429, { error: 'rate', message: 'Too many questions in a short time. Wait a few minutes.' }, origin);

    if (h('X-Check')) {
      if (!own) return json(200, { ok: true, provider: 'gemini', model, models: [model] }, origin);
      const r = await checkKey(pid, p, key);
      if (r.ok) return json(200, { ok: true, provider: pid, model: r.model, models: r.models }, origin);
      const refused = r.status === 401 || r.status === 403 || (r.status === 400 && /api[ _-]?key|credential|authenticat/i.test(r.detail));
      if (refused) return json(401, { error: 'key', status: r.status, message: p.name + ' refused this API key' + (r.detail ? ' (' + r.detail.slice(0, 140) + ')' : '') + '.' }, origin);
      return json(200, { ok: true, provider: pid, model: p.model, models: [p.model], warn: p.name + ' could not list models (' + r.status + ').' }, origin);
    }

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

    let up = await callAI(p, key, model, clean, origin);
    // Gemini's free quota is per model: switch to the lighter one when the first is used up.
    const second = own ? p.fallback : (env.FALLBACK_MODEL || p.fallback);
    if (p.kind === 'gemini' && !h('X-Model') && [429, 503, 404].includes(up.status) && second && second !== model) up = await callAI(p, key, second, clean, origin);

    if (!up.ok || !up.body) {
      const s = up.status, detail = await errorDetail(up);
      const badKey = s === 401 || (s === 400 && /api[ _-]?key|credential|authenticat/i.test(detail)) || (s === 403 && /api[ _-]?key|permission|denied|not enabled|disabled|unauthori[sz]ed/i.test(detail));
      if (badKey) return json(401, { error: own ? 'key' : 'upstream', status: s, message: p.name + ' refused this API key' + (detail ? ' (' + detail.slice(0, 140) + ')' : '') + '. Check it and paste it again.', detail }, origin);
      const msg = s === 404 ? p.name + ' does not know the model "' + model + '". Pick another model.'
        : s === 413 ? 'This question is too big for this model\'s free limit. Untick "Copilot sees" or pick another model.'
        : s === 429 ? (own ? 'Your ' + p.name + ' quota or rate limit is reached. Wait a bit, or try again tomorrow.' : 'The free Gemini quota is used up for now. It resets every day: try again later.')
        : s === 402 ? 'No credit left on this ' + p.name + ' account.'
        : s === 503 || s === 529 ? p.name + ' is overloaded. Try again in a minute.'
        : p.name + ' could not answer (' + s + ')' + (detail ? ': ' + detail : '.');
      return json(502, { error: 'upstream', status: s, message: msg, detail }, origin);
    }
    return new Response(translate(up.body, p.kind), { status: 200, headers: Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, cors(origin)) });
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
