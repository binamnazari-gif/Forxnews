/**
 * چند؟! — سرویس قیمت
 *
 * تغییر مهم نسبت به نسخه قبل:
 * دو اندپوینت BrsApi داده‌های متفاوتی می‌دهند و هر دو لازم‌اند —
 *   Gold_Currency.php → ارز، طلای ۱۸ عیار، آبشده، سکه، رمزارز
 *   Commodity.php     → انس جهانی طلا و نقره و فلزات
 * نسخه قبلی روی اولین موفقیت return می‌کرد، پس فقط یکی از این دو به اپ
 * می‌رسید و پنل حباب و ماشین‌حساب داده‌ی لازمشان را نداشتند.
 * حالا هر دو گرفته و در یک پاسخ ادغام می‌شوند.
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const KEY      = process.env.BRSAPI_KEY || '';
const PORT     = parseInt(process.env.PORT || '8080', 10);
const HOST     = process.env.HOST || '0.0.0.0';
const POLL_SEC = Math.max(60, parseInt(process.env.POLL_SEC || '180', 10));
const PUBLIC   = path.join(__dirname, 'public');

/* همه‌ی فایل‌های نوشتنی اینجا می‌مانند تا با یک volume حفظ شوند.
   حجم این پوشه سقف ثابت دارد و با گذر زمان بالا نمی‌رود:
   history.json حداکثر HIST_MAX نقطه نگه می‌دارد و قدیمی‌ها حذف می‌شوند. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const SNAPSHOT = path.join(DATA_DIR, 'last-prices.json');
const HISTORY  = path.join(DATA_DIR, 'history.json');

const HIST_EVERY_SEC = 3600;   // یک نقطه در ساعت
const HIST_MAX       = 720;    // ۳۰ روز — سقف سخت، نه بیشتر

/* دو مسیر ممکن برای رسیدن به BrsApi:
   - مستقیم (پیش‌فرض): api.brsapi.ir
   - از طریق واسط: اگر PROXY_BASE ست شود، همه‌ی درخواست‌ها از آنجا می‌روند.
   اگر روزی IP سرور دوباره مسدود شد، فقط PROXY_BASE را ست کنید — کد دست نمی‌خورد. */
const APP_URL = process.env.APP_URL || 'https://chand.faino.ir';
/* هویت درخواست‌ها؛ پنهان نمی‌شویم و آدرس اپ را می‌گذاریم تا هر سایتی
   بخواهد بداند چه کسی می‌خواند، بداند و بتواند تماس بگیرد. */
const UA = `chand-price-app/1.0 (+${APP_URL})`;

const API_BASE   = process.env.API_BASE   || 'https://api.brsapi.ir';
const PROXY_BASE = process.env.PROXY_BASE || '';
const ROUTE      = PROXY_BASE ? 'proxy' : 'direct';

function buildUrl(endpoint) {
  var k = encodeURIComponent(KEY);
  return PROXY_BASE
    ? PROXY_BASE.replace(/\/+$/, '') + '/?endpoint=' + encodeURIComponent(endpoint) + '&key=' + k
    : API_BASE.replace(/\/+$/, '') + endpoint + '?key=' + k;
}

/* required: بدون این یکی پاسخ به درد نمی‌خورد
   optional: نبودش فقط پنل حباب را ناقص می‌کند، نه کل اپ */
const ENDPOINTS = [
  { path: '/Market/Gold_Currency.php', required: true  },
  { path: '/Market/Commodity.php',     required: false }
];

/* ---------- منبع دلخواه ----------
   اگر SOURCE_URLS ست شود، به‌جای BrsApi از همان آدرس‌ها می‌خوانَد.
   آدرس‌ها با کاما جدا می‌شوند و کلید داخل خودشان است. با ‎|optional
   می‌شود گفت که نبودِ یکی نباید کل به‌روزرسانی را شکست بدهد:

     SOURCE_URLS="https://api.example.com/gold?token=X,https://api.example.com/ons?token=Y|optional"

   پاسخ هر شکلی داشته باشد، mapAny آن را به قالب اپ برمی‌گرداند.
   یعنی عوض کردن سرویس فقط یک متغیر محیطی است، نه تغییر کد. */
/* گرامر SOURCE_URLS:
     کاما (,)  → منابع جدا که با هم ادغام می‌شوند
     بزرگ‌تر (>) → جایگزین: اگر اولی نشد دومی، اگر نشد سومی
     |optional  → نبودِ این اسلات نباید کل به‌روزرسانی را شکست بدهد

   مثال — طلا از سه منبع (هرکدام جواب داد بس است) و انس از یک منبع اختیاری:
     SOURCE_URLS="https://a/gold>https://b/gold>https://c/gold,https://a/ons|optional"

   در هر چرخه فقط یک درخواست به هر اسلات می‌رود؛ بعدی‌ها فقط وقتی
   امتحان می‌شوند که قبلی شکست خورده باشد. */
const SOURCE_URLS = (process.env.SOURCE_URLS || '')
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => {
    const flags = (x.match(/\|[a-z]+/gi) || []).map((f) => f.slice(1).toLowerCase());
    const body = x.replace(/\|[a-z]+/gi, '');
    return {
      alts: body.split('>').map((u) => u.trim()).filter(Boolean),
      required: !flags.includes('optional'),
      rial: flags.includes('rial')      // صفحه قیمت‌ها را به ریال می‌دهد
    };
  });

const USING_CUSTOM = SOURCE_URLS.length > 0;

/* ---------- تبدیل هر JSON ناشناخته به قالب اپ ---------- */
const K_PRICE = ['price', 'value', 'rate', 'current', 'last', 'amount'];
const K_NAME  = ['name', 'name_fa', 'title', 'fa', 'label', 'persian'];
const K_SYM   = ['symbol', 'slug', 'code', 'key', 'name_en', 'en'];
const K_CHG   = ['change_value', 'change', 'diff', 'change_amount'];
const K_PCT   = ['change_percent', 'percent', 'pct', 'change_percentage'];
const K_UNIT  = ['unit', 'currency'];

function pickKey(o, keys) {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  return parseFloat(v.replace(/[,\s٬]/g, ''));
}

function categorize(name, sym) {
  const t = String(name || '') + ' ' + String(sym || '');
  if (/سکه|طلا|انس|مثقال|آبشده|آب‌شده|عیار|نقره|مظنه|XAU|XAG|GOLD|COIN|SILVER/i.test(t)) return 'gold';
  if (/تتر|بیت|اتریوم|رمزارز|USDT|BTC|ETH/i.test(t)) return 'cryptocurrency';
  return 'currency';
}

function mapAny(data) {
  const out = { currency: [], gold: [], cryptocurrency: [] };
  const seen = new Set();

  function addRow(o, keyHint) {
    const price = toNumber(pickKey(o, K_PRICE));
    if (!Number.isFinite(price)) return false;
    const name = pickKey(o, K_NAME) || keyHint;
    const sym  = String(pickKey(o, K_SYM) || keyHint || name || '').toUpperCase().replace(/\s+/g, '_');
    if (!sym || seen.has(sym)) return false;
    seen.add(sym);
    out[categorize(name, sym)].push({
      symbol: sym,
      name: String(name || sym),
      price: price,
      unit: pickKey(o, K_UNIT) || 'تومان',
      change_value: toNumber(pickKey(o, K_CHG)) || 0,
      change_percent: toNumber(pickKey(o, K_PCT)) || 0
    });
    return true;
  }

  function walk(node, keyHint, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((x) => walk(x, undefined, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (addRow(node, keyHint)) return;               // خودش یک ردیف قیمت بود
    for (const k of Object.keys(node)) walk(node[k], k, depth + 1);
  }

  walk(data, undefined, 0);
  if (!out.currency.length) delete out.currency;
  if (!out.gold.length) delete out.gold;
  if (!out.cryptocurrency.length) delete out.cryptocurrency;
  return out;
}

/* ---------- خواندن عدد از صفحه‌ی HTML ----------
   وقتی سرویس JSON نمی‌دهد و فقط صفحه‌ی وب دارد: متن صفحه را می‌گیریم،
   دنبال برچسب فارسی هر قلم می‌گردیم و اولین عدد بعد از آن را برمی‌داریم.
   درخواست با هویت مشخص و حداکثر یک بار در هر چرخه فرستاده می‌شود. */
const HTML_TARGETS = [
  { sym:'USD',           cat:'currency', name:'دلار',
    labels:[/دلار\s*آمریکا/, /دلار\s*امریکا/, /\bدلار\b(?!\s*(کانادا|استرالیا|سنگاپور|هنگ))/] },
  { sym:'EUR',           cat:'currency', name:'یورو',            labels:[/یورو/] },
  { sym:'AED',           cat:'currency', name:'درهم امارات',     labels:[/درهم/] },
  { sym:'USDT_IRT',      cat:'cryptocurrency', name:'تتر',       labels:[/تتر/] },
  { sym:'IR_GOLD_18K',   cat:'gold', name:'طلای ۱۸ عیار',
    labels:[/طلای?\s*[1۱][8۸]\s*عیار/, /گرم\s*طلای?\s*[1۱][8۸]/] },
  { sym:'IR_GOLD_MELTED',cat:'gold', name:'طلای آب‌شده',
    labels:[/مثقال\s*طلا/, /طلای?\s*آب\s*شده/, /آبشده/, /مظنه/] },
  { sym:'IR_COIN_EMAMI', cat:'gold', name:'سکه امامی',
    labels:[/سکه\s*امامی/, /سکه\s*تمام/, /امامی/] },
  { sym:'IR_COIN_BAHAR', cat:'gold', name:'سکه بهار آزادی',      labels:[/بهار\s*آزادی/] },
  { sym:'IR_COIN_HALF',  cat:'gold', name:'نیم سکه',             labels:[/نیم\s*سکه/] },
  { sym:'IR_COIN_QUARTER',cat:'gold', name:'ربع سکه',            labels:[/ربع\s*سکه/] },
  { sym:'XAUUSD',        cat:'gold', name:'انس طلا', usd:true,
    labels:[/انس\s*(جهانی\s*)?طلا/, /اونس\s*طلا/] }
];

function faDigitsToEn(t) {
  return t.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
          .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function htmlToText(html) {
  return faDigitsToEn(String(html))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' | ')
    .replace(/&nbsp;|&zwnj;/g, ' ')
    .replace(/\u200c/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/(\s*\|\s*)+/g, ' | ');
}

/* اولین عددِ معنادار بعد از برچسب */
function numberAfter(text, from, window) {
  const chunk = text.slice(from, from + (window || 220));
  const m = chunk.match(/-?\d{1,3}(?:[,٬]\d{3})+(?:\.\d+)?|-?\d{4,}(?:\.\d+)?/);
  if (!m) return NaN;
  return parseFloat(m[0].replace(/[,٬]/g, ''));
}

function mapHtml(html, opts) {
  const text = htmlToText(html);
  const out = { currency: [], gold: [], cryptocurrency: [] };
  const toToman = opts && opts.rial ? 0.1 : 1;

  for (const t of HTML_TARGETS) {
    let price = NaN;
    for (const re of t.labels) {
      const m = text.match(re);
      if (!m || m.index === undefined) continue;
      const v = numberAfter(text, m.index + m[0].length);
      if (Number.isFinite(v) && v > 0) { price = v; break; }
    }
    if (!Number.isFinite(price)) continue;
    out[t.cat].push({
      symbol: t.sym,
      name: t.name,
      price: t.usd ? price : price * toToman,   // انس دلاری است و تبدیل نمی‌شود
      unit: t.usd ? 'دلار' : 'تومان',
      change_value: 0,
      change_percent: 0
    });
  }

  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

/* اگر پاسخ از قبل قالب BrsApi را دارد دست نمی‌خورد، وگرنه ترجمه می‌شود */
function adapt(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const arrays = Object.keys(data).filter((k) => Array.isArray(data[k]));
    const looksNative = arrays.some((k) =>
      data[k].some((it) => it && it.symbol !== undefined && it.price !== undefined));
    if (looksNative) return data;
  }
  return mapAny(data);
}

if (!KEY) {
  console.error('!!! BRSAPI_KEY تعریف نشده — قیمت جدیدی گرفته نمی‌شود.');
  console.error('!!! در تنظیمات محیطی سرویس آن را ست کنید.');
}

if (typeof fetch !== 'function') {
  console.error('نسخه Node شما (' + process.version + ') fetch ندارد. حداقل Node 18 لازم است.');
  process.exit(1);
}

let cache = { body: null, at: 0, ok: false, sources: [] };
let stats = { polls: 0, fails: 0, hits: 0, since: Date.now() };
let lastError = null;

function note(endpoint, stage, message, snippet) {
  lastError = {
    at: new Date().toISOString(),
    endpoint: endpoint,
    stage: stage,
    message: message,
    snippet: snippet ? String(snippet).slice(0, 200) : undefined
  };
  console.error(lastError.at, '[' + stage + ']', endpoint, '—', message);
  if (snippet) console.error('  پاسخ:', String(snippet).slice(0, 200));
}

try {
  const saved = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  if (saved && saved.body) {
    cache = { body: saved.body, at: saved.at || 0, ok: true, sources: saved.sources || [] };
    console.log('نسخه ذخیره‌شده بارگذاری شد');
  }
} catch (e) { /* اولین اجرا */ }

/* ---------- تاریخچه ----------
   فقط سه عدد خامِ لازم ذخیره می‌شود، نه درصد حباب. اگر روزی فرمول عوض شد،
   تاریخچه‌ی گذشته همچنان معتبر می‌ماند و اپ خودش دوباره حساب می‌کند. */
let history = [];
try {
  const raw = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  if (Array.isArray(raw)) history = raw.slice(-HIST_MAX);
  console.log('تاریخچه بارگذاری شد —', history.length, 'نقطه');
} catch (e) { /* هنوز چیزی نیست */ }

function findItem(data, syms, re) {
  for (const k of Object.keys(data)) {
    if (!Array.isArray(data[k])) continue;
    for (const it of data[k]) {
      if (!it) continue;
      if (syms.includes(it.symbol)) return it;
      if (re && re.test(it.name || '')) return it;
    }
  }
  return null;
}

function recordHistory(data) {
  const now = Math.floor(Date.now() / 1000);
  const last = history[history.length - 1];
  if (last && now - last.t < HIST_EVERY_SEC) return;

  const oz  = findItem(data, ['XAUUSD', 'GOLD_OUNCE'], /انس\s*طلا/);
  const usd = findItem(data, ['USD'], /^دلار$/);
  const mel = findItem(data, ['IR_GOLD_MELTED'], /آب\s*شده|آبشده/);
  if (!oz || !usd || !mel) return;

  const num = (x) => parseFloat(String(x).replace(/,/g, ''));
  const o = num(oz.price), u = num(usd.price), m = num(mel.price);
  if (![o, u, m].every(Number.isFinite)) return;

  history.push({
    t: now,
    o: Math.round(o * 100) / 100,   // انس به دلار
    u: Math.round(u),               // دلار به تومان
    m: Math.round(m)                // مثقال آبشده به تومان
  });

  // سقف سخت: هرگز بیشتر از HIST_MAX نقطه
  if (history.length > HIST_MAX) history = history.slice(-HIST_MAX);

  const tmp = HISTORY + '.tmp';
  fs.writeFile(tmp, JSON.stringify(history), (err) => {
    if (err) return console.error('نوشتن تاریخچه ناموفق —', err.message);
    fs.rename(tmp, HISTORY, () => {});
  });
  console.log('  نقطه تاریخچه ثبت شد —', history.length, 'از', HIST_MAX);
}

function countItems(d) {
  if (Array.isArray(d)) return d.length;
  if (!d || typeof d !== 'object') return 0;
  return Object.keys(d).reduce(
    (n, k) => n + (Array.isArray(d[k]) ? d[k].length : 0), 0
  );
}

/* ادغام دو پاسخ: کلیدهای مشترک به هم می‌چسبند، بقیه اضافه می‌شوند */
function merge(into, from) {
  if (!from || typeof from !== 'object' || Array.isArray(from)) return into;
  for (const k of Object.keys(from)) {
    if (!Array.isArray(from[k])) continue;
    if (Array.isArray(into[k])) {
      const seen = new Set(into[k].map((x) => x && x.symbol));
      for (const item of from[k]) if (!seen.has(item && item.symbol)) into[k].push(item);
    } else {
      into[k] = from[k].slice();
    }
  }
  return into;
}

async function grab(endpoint, opts) {
  const url = /^https?:\/\//i.test(endpoint) ? endpoint : buildUrl(endpoint);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 15000);
  let text = '';
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache'
      }
    });
    clearTimeout(to);
    text = await r.text();

    if (!r.ok) { note(endpoint, 'http', 'HTTP ' + r.status, text); return null; }

    let shaped;
    try {
      const data = JSON.parse(text);
      if (data && data.successful === false) {
        note(endpoint, 'upstream', data.error_message || 'Blocked', text);
        return null;
      }
      shaped = adapt(data);
    } catch (e) {
      // JSON نبود — احتمالاً صفحه‌ی HTML است
      shaped = mapHtml(text, opts);
      if (!countItems(shaped)) {
        note(endpoint, 'parse', 'نه JSON بود نه عددی در صفحه پیدا شد', text);
        return null;
      }
    }
    const n = countItems(shaped);
    if (!n) { note(endpoint, 'empty', 'پاسخ قلمی نداشت یا قابل تفسیر نبود', text); return null; }

    return { data: shaped, n };
  } catch (e) {
    clearTimeout(to);
    const cause = e && e.cause ? e.cause : null;
    const code = (cause && cause.code) || (e && e.code) || '';
    const m = [e && e.message, cause && cause.message, code].filter(Boolean).join(' — ');
    let stage = 'network';
    if (/abort/i.test(m)) stage = 'timeout';
    else if (/ENOTFOUND|EAI_AGAIN/i.test(m)) stage = 'dns';
    else if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(m)) stage = 'connect';
    else if (/certificate|TLS|SSL/i.test(m)) stage = 'tls';
    note(endpoint, stage, m);
    return null;
  }
}

function activeSources() {
  return USING_CUSTOM
    ? SOURCE_URLS.map((x) => ({ alts: x.alts, required: x.required, rial: x.rial }))
    : ENDPOINTS.map((e) => ({ alts: [e.path], required: e.required, rial: false }));
}

/* یک اسلات: جایگزین‌ها را به ترتیب امتحان می‌کند تا یکی جواب بدهد */
async function grabSlot(slot) {
  for (let i = 0; i < slot.alts.length; i++) {
    const got = await grab(slot.alts[i], { rial: slot.rial });
    if (got) {
      if (i > 0) console.log('  منبع جایگزین', i + 1, 'جواب داد');
      return { got, used: slot.alts[i] };
    }
  }
  return null;
}

async function poll() {
  if (!USING_CUSTOM && !KEY) { note('-', 'config', 'BRSAPI_KEY تعریف نشده است'); return false; }
  stats.polls++;

  const list = activeSources();
  // هر اسلات جدا؛ داخل اسلات، جایگزین‌ها به ترتیب
  const results = await Promise.all(list.map((slot) => grabSlot(slot)));

  const merged = {};
  const sources = [];
  let total = 0;

  for (let i = 0; i < list.length; i++) {
    const r = results[i];
    if (!r) continue;
    merge(merged, r.got.data);
    sources.push({
      endpoint: r.used.replace(/([?&](key|token|apikey)=)[^&]*/gi, '$1***'),
      items: r.got.n
    });
    total += r.got.n;
  }

  const requiredOk = list.every((e, i) => !e.required || results[i]);

  if (!requiredOk || !total) {
    stats.fails++;
    console.error(new Date().toISOString(), 'به‌روزرسانی ناموفق — نسخه قبلی حفظ شد');
    return false;
  }

  const body = JSON.stringify(merged);
  cache = { body, at: Date.now(), ok: true, sources };
  lastError = null;
  fs.writeFile(SNAPSHOT, JSON.stringify({ body, at: cache.at, sources }), () => {});

  console.log(
    new Date().toISOString(), 'به‌روز شد —', countItems(merged), 'قلم از',
    sources.map((s) => s.endpoint.replace('/Market/', '').split('/').pop().slice(0, 40)).join(' + ')
  );

  recordHistory(merged);

  // هشدار اگر داده‌ی لازم پنل‌ها نیامده باشد
  const miss = [];
  if (!/GOLD_18K|۱۸ عیار|18 عیار/.test(body)) miss.push('طلای ۱۸ عیار');
  if (!/XAUUSD|انس/.test(body)) miss.push('انس جهانی');
  if (!/"USD"/.test(body)) miss.push('دلار');
  if (miss.length) console.warn('  ⚠ در داده نیست:', miss.join('، '), '— پنل‌های اپ ناقص می‌شوند');

  return true;
}

/* ---------- حالت عیب‌یابی: node server.js check ---------- */
if (process.argv[2] === 'check') {
  console.log('Node:', process.version);
  console.log('منبع:', USING_CUSTOM ? 'SOURCE_URLS (دلخواه)' : ('BrsApi — ' + (ROUTE === 'proxy' ? PROXY_BASE : API_BASE)));
  console.log('کلید:', KEY ? (KEY.slice(0, 4) + '***' + KEY.slice(-3)) : '(تعریف نشده!)');
  console.log('در حال تست هر دو اندپوینت...\n');
  poll().then((ok) => {
    if (ok) {
      console.log('\nمنابع:', JSON.stringify(cache.sources));
      console.log('✓ سرویس را با `node server.js` بالا بیاورید.');
      process.exit(0);
    }
    const e = lastError || {};
    console.log('\n✗ ناموفق. مرحله:', e.stage, '—', e.message);
    if (e.snippet) console.log('  پاسخ:', e.snippet);
    process.exit(1);
  });
  return;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
  '.ico':  'image/x-icon'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('پیدا نشد'); return; }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': (isHtml || rel === '/sw.js') ? 'no-cache' : 'public, max-age=86400'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS'
    }).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('فقط GET');
    return;
  }

  if (url.startsWith('/api/prices')) {
    stats.hits++;
    if (!cache.body) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store'
      }).end(JSON.stringify({ error: 'هنوز قیمتی دریافت نشده' }));
      return;
    }
    const age = Math.round((Date.now() - cache.at) / 1000);
    /* پاسخ از حافظه می‌آید و ارزان است؛ اجازه‌ی کش دادن به مرورگر یا CDN
       فقط باعث می‌شود کاربر عدد کهنه ببیند. */
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'pragma': 'no-cache',
      'expires': '0',
      'x-age': String(age)
    });
    res.end(cache.body);
    return;
  }

  if (url.startsWith('/api/history')) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'pragma': 'no-cache'
    }).end(JSON.stringify({
      everySeconds: HIST_EVERY_SEC,
      max: HIST_MAX,
      points: history
    }));
    return;
  }

  if (url.startsWith('/api/health')) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }).end(JSON.stringify({
      ok: cache.ok,
      ageSeconds: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null,
      pollSeconds: POLL_SEC,
      dailyUpstreamCalls: Math.round(86400 / POLL_SEC) * activeSources().length,
      route: USING_CUSTOM ? 'custom' : ROUTE,
      sources: cache.sources,
      historyPoints: history.length,
      historyMax: HIST_MAX,
      dataBytes: dataDirBytes(),
      lastError: lastError,
      ...stats,
      uptimeSeconds: Math.round(process.uptime())
    }));
    return;
  }

  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`چند؟! روی http://${HOST}:${PORT} بالا آمد`);
  console.log(`هر ${POLL_SEC} ثانیه — ${Math.round(86400 / POLL_SEC) * activeSources().length} درخواست در روز`);
  console.log(USING_CUSTOM
    ? `منبع: ${SOURCE_URLS.length} آدرس دلخواه (SOURCE_URLS)`
    : `منبع: BrsApi — ${ROUTE === 'proxy' ? PROXY_BASE : API_BASE}`);
  console.log(`پوشه داده: ${DATA_DIR} — تاریخچه حداکثر ${HIST_MAX} نقطه (حدود ${Math.round(HIST_MAX * 42 / 1024)} کیلوبایت)`);
  poll();
  setInterval(poll, POLL_SEC * 1000);
});

function dataDirBytes() {
  try {
    return fs.readdirSync(DATA_DIR).reduce((n, f) => {
      try { return n + fs.statSync(path.join(DATA_DIR, f)).size; } catch (e) { return n; }
    }, 0);
  } catch (e) { return null; }
}

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
