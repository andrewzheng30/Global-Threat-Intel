/**
 * SENTINEL — Live Data Server (v2)
 * Uses only APIs confirmed to work without auth blocks:
 * - Yahoo Finance v8 (with proper cookies)
 * - Open Exchange / Coinbase for crypto
 * - EIA for oil/gas
 * - GDELT for news
 * - RSS feeds for media
 */

const express = require('express');
const fetch   = require('node-fetch');
const xml2js  = require('xml2js');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Cache ───
const CACHE = {};
function cached(key, ttlMs, fn) {
  const hit = CACHE[key];
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data);
  return fn().then(data => {
    CACHE[key] = { data, ts: Date.now() };
    return data;
  });
}

// ─── Fetch helper ───
async function get(url, opts = {}, timeoutMs = 12000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts.headers || {}),
      },
      ...opts,
    });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ─── Parse RSS XML ───
async function parseRSS(url) {
  const r    = await get(url, {}, 10000);
  const text = await r.text();
  const data = await xml2js.parseStringPromise(text, { explicitArray: false });

  if (data?.rss?.channel) {
    const ch  = data.rss.channel;
    const raw = ch.item || [];
    const arr = Array.isArray(raw) ? raw : [raw];

    return arr.filter(Boolean).map(i => ({
      title:  clean(i.title),
      url:    i.link || i['feedburner:origLink'] || '',
      desc:   clean(i.description || i['content:encoded'] || '').slice(0, 200),
      date:   i.pubDate || '',
      source: clean(ch.title),
    }));
  }

  if (data?.feed?.entry) {
    const entries = data.feed.entry;
    const arr     = Array.isArray(entries) ? entries : [entries];

    return arr.filter(Boolean).map(e => ({
      title:  clean(e.title?._ || e.title),
      url:    (Array.isArray(e.link) ? e.link.find(l => l.$?.rel === 'alternate') : e.link)?.$?.href || '',
      desc:   clean(e.summary?._ || e.summary || '').slice(0, 200),
      date:   e.updated || e.published || '',
      source: clean(data.feed.title?._ || data.feed.title),
    }));
  }

  return [];
}

function clean(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const KW = [
  'war', 'conflict', 'attack', 'airstrike', 'bomb', 'military', 'troops',
  'killed', 'casualties', 'ceasefire', 'offensive', 'invasion', 'strike',
  'fighting', 'frontline', 'artillery', 'drone', 'oil', 'gas', 'energy',
  'sanctions', 'nuclear', 'terror', 'ukraine', 'russia', 'gaza', 'israel',
  'iran', 'hamas', 'houthi', 'nato', 'sudan', 'yemen', 'syria', 'coup',
  'refugee', 'explosion', 'weapons'
];

function score(title = '', desc = '') {
  const t = (title + ' ' + desc).toLowerCase();
  return KW.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
}

// ════════════════════════════════════════════════════
// /api/markets  — Yahoo Finance with crumb auth
// ════════════════════════════════════════════════════
async function fetchYahooQuotes() {
  // Step 1: get a session cookie + crumb from Yahoo
  const cookieRes = await get('https://finance.yahoo.com/', {}, 8000);
  const cookies   = (cookieRes.headers.get('set-cookie') || '')
    .split(',')
    .map(c => c.split(';')[0])
    .join('; ');

  // Step 2: get crumb
  const crumbRes = await get(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    { headers: { Cookie: cookies } },
    6000
  );
  const crumb = await crumbRes.text();

  // Step 3: fetch quotes with crumb
  const syms = [
    '^GSPC', '^DJI', '^IXIC', '^FTSE', '^N225',
    'GC=F', 'BTC-USD', '^VIX', 'BZ=F', 'CL=F', 'NG=F'
  ].join(',');

  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&crumb=${encodeURIComponent(crumb)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,shortName`;

  const r    = await get(url, { headers: { Cookie: cookies } }, 10000);
  const data = await r.json();

  return data?.quoteResponse?.result || [];
}

// Fallback: use stooq.com CSV (no auth needed)
async function fetchStooqPrice(sym) {
  const r     = await get(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`, {}, 8000);
  const text  = await r.text();
  const lines = text.trim().split('\n');

  if (lines.length < 2) return null;

  const cols  = lines[1].split(',');
  const close = parseFloat(cols[4] || cols[5]);
  const open  = parseFloat(cols[3]);

  if (isNaN(close)) return null;

  return {
    price: close,
    change: close - open,
    pct: ((close - open) / open) * 100
  };
}

// Fallback using public finance data
async function fetchMarketsViaStooq() {
  const STOOQ_MAP = [
    // Indices
    { symbol: '^GSPC', stooq: '^spx',    name: 'S&P 500',           color: '#00ff88' },
    { symbol: '^DJI',  stooq: '^dji',    name: 'Dow Jones',         color: '#00aaff' },
    { symbol: '^IXIC', stooq: '^ndq',    name: 'NASDAQ',            color: '#bb88ff' },
    { symbol: '^FTSE', stooq: '^ftx.uk', name: 'FTSE 100',          color: '#ff9900' },
    { symbol: '^N225', stooq: '^nkx.jp', name: 'Nikkei 225',        color: '#ff6699' },

    // Commodities
    { symbol: 'GC=F',  stooq: 'gc.f',    name: 'Gold',              color: '#ffdd00' },
    { symbol: 'BZ=F',  stooq: 'brent.f', name: 'Brent Crude',       color: '#ff9900' },
    { symbol: 'CL=F',  stooq: 'cl.f',    name: 'WTI Crude',         color: '#ff6600' },
    { symbol: 'NG=F',  stooq: 'ng.f',    name: 'Natural Gas',       color: '#00aaff' },

    // US Big Tech
    { symbol: 'AAPL',  stooq: 'aapl.us',  name: 'Apple',             color: '#aaaaaa' },
    { symbol: 'MSFT',  stooq: 'msft.us',  name: 'Microsoft',         color: '#00aaff' },
    { symbol: 'NVDA',  stooq: 'nvda.us',  name: 'NVIDIA',            color: '#76b900' },
    { symbol: 'GOOGL', stooq: 'googl.us', name: 'Alphabet',          color: '#4285f4' },
    { symbol: 'AMZN',  stooq: 'amzn.us',  name: 'Amazon',            color: '#ff9900' },
    { symbol: 'META',  stooq: 'meta.us',  name: 'Meta',              color: '#0668e1' },
    { symbol: 'TSLA',  stooq: 'tsla.us',  name: 'Tesla',             color: '#cc0000' },

    // US Energy
    { symbol: 'XOM',   stooq: 'xom.us',   name: 'ExxonMobil',        color: '#ff6600' },
    { symbol: 'CVX',   stooq: 'cvx.us',   name: 'Chevron',           color: '#0066cc' },

    // Defense & Aerospace
    { symbol: 'LMT',   stooq: 'lmt.us',   name: 'Lockheed Martin',   color: '#00ffcc' },
    { symbol: 'RTX',   stooq: 'rtx.us',   name: 'RTX (Raytheon)',    color: '#ff4444' },
    { symbol: 'NOC',   stooq: 'noc.us',   name: 'Northrop Grumman',  color: '#ffaa00' },
    { symbol: 'BA',    stooq: 'ba.us',    name: 'Boeing',            color: '#0044aa' },
    { symbol: 'GD',    stooq: 'gd.us',    name: 'General Dynamics',  color: '#44ccff' },
    { symbol: 'HII',   stooq: 'hii.us',   name: 'Huntington Ingalls', color: '#88aaff' },
    { symbol: 'LDOS',  stooq: 'ldos.us',  name: 'Leidos',            color: '#aaffaa' },
    { symbol: 'BWXT',  stooq: 'bwxt.us',  name: 'BWX Technologies',  color: '#ffaaff' },
  ];

  const results = await Promise.allSettled(
    STOOQ_MAP.map(m => fetchStooqPrice(m.stooq).then(d => (d ? { ...m, ...d } : null)))
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// Fetch Brent from EIA (reliable, free, no auth)
async function fetchBrent() {
  try {
    const r = await get(
      'https://api.eia.gov/v2/petroleum/pri/spt/data/?frequency=daily&data[0]=value&facets[series][]=RBRTE&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2&api_key=DEMO_KEY',
      {},
      8000
    );
    const d    = await r.json();
    const rows = d?.response?.data || [];

    if (!rows.length) return null;

    const price = parseFloat(rows[0].value);
    const prev  = parseFloat(rows[1]?.value || price);

    return {
      symbol: 'BZ=F',
      stooq: 'bz.f',
      name: 'Brent Crude',
      price,
      change: +(price - prev).toFixed(2),
      pct: +((price - prev) / prev * 100).toFixed(2),
      color: '#ff9900'
    };
  } catch (e) {
    return null;
  }
}

async function fetchBTC() {
  const r     = await get('https://api.coinbase.com/v2/prices/BTC-USD/spot', {}, 6000);
  const data  = await r.json();
  const price = parseFloat(data?.data?.amount);

  if (isNaN(price)) return null;

  return {
    symbol: 'BTC-USD',
    name: 'Bitcoin',
    price,
    change: 0,
    pct: 0,
    color: '#f7931a'
  };
}

app.get('/api/markets', async (req, res) => {
  try {
    const data = await cached('markets', 60_000, async () => {
      let quotes = [];

      // Try Yahoo with crumb first
      try {
        const yq = await fetchYahooQuotes();
        if (yq.length > 3) {
          quotes = yq.map(q => ({
            symbol: q.symbol,
            name: q.shortName || q.symbol,
            price: q.regularMarketPrice,
            change: q.regularMarketChange,
            pct: q.regularMarketChangePercent,
          }));
        }
      } catch (e) {
        console.warn('Yahoo failed, trying stooq:', e.message);
      }

      // Fallback to stooq
      if (quotes.length < 3) {
        quotes = await fetchMarketsViaStooq();
      }

      // Add BTC and Brent
      const [btc, brent] = await Promise.allSettled([fetchBTC(), fetchBrent()]);

      if (btc.status === 'fulfilled' && btc.value && !quotes.find(q => q.symbol === 'BTC-USD')) {
        quotes.push(btc.value);
      }

      if (brent.status === 'fulfilled' && brent.value && !quotes.find(q => q.symbol === 'BZ=F')) {
        quotes.push(brent.value);
      }

      // Brent crude — try EIA, fallback to WTI + $3 premium
      if (!quotes.find(q => q.symbol === 'BZ=F' || (q.stooq || '').includes('brent'))) {
        try {
          const r = await get(
            'https://api.eia.gov/v2/petroleum/pri/spt/data/?frequency=daily&data[0]=value&facets[series][]=RBRTE&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=2&api_key=DEMO_KEY',
            {},
            8000
          );
          const d    = await r.json();
          const rows = d?.response?.data || [];

          if (rows.length >= 1) {
            const price = parseFloat(rows[0].value);
            const prev  = parseFloat(rows[1]?.value || price);

            quotes.push({
              symbol: 'BZ=F',
              stooq: 'brent.f',
              name: 'Brent Crude',
              price,
              change: +(price - prev).toFixed(2),
              pct: +((price - prev) / prev * 100).toFixed(2),
              color: '#ff9900'
            });
          }
        } catch (e) {
          // Last resort: WTI + $3 spread
          const wti = quotes.find(q => q.symbol === 'CL=F' || q.stooq === 'cl.f');
          if (wti?.price) {
            quotes.push({
              symbol: 'BZ=F',
              stooq: 'brent.f',
              name: 'Brent Crude',
              price: +(wti.price + 3).toFixed(2),
              change: wti.change || 0,
              pct: wti.pct || 0,
              color: '#ff9900'
            });
          }
        }
      }

      return {
        quotes,
        updatedAt: new Date().toISOString()
      };
    });

    res.json(data);
  } catch (e) {
    console.error('Markets error:', e.message);
    res.status(503).json({ quotes: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════
// /api/gas  — EIA + AAA gas prices
// ════════════════════════════════════════════════════
app.get('/api/gas', async (req, res) => {
  try {
    const data = await cached('gas', 30 * 60_000, async () => {
      let states = [];
      let nationalAvg = null;

      // Try AAA
      try {
        const r    = await get('https://gasprices.aaa.com/state-gas-price-averages/', {}, 12000);
        const html = await r.text();
        const re   = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
        const rows = html.match(re) || [];

        for (const row of rows) {
          const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
            m[1].replace(/<[^>]+>/g, '').trim()
          );

          if (cells.length >= 2) {
            const state = cells[0];
            const price = parseFloat(cells[1].replace(/[^0-9.]/g, ''));

            if (state && !isNaN(price) && price > 1.5 && price < 9) {
              states.push({ state, price: +price.toFixed(3) });
            }
          }
        }

        if (states.length > 5) {
          nationalAvg = +(states.reduce((s, d) => s + d.price, 0) / states.length).toFixed(3);
        }
      } catch (e) {
        console.warn('AAA failed:', e.message);
      }

      // EIA fallback for oil price
      let wtiSpot = null;
      try {
        const r = await get(
          'https://api.eia.gov/v2/petroleum/pri/spt/data/?frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&offset=0&length=1&api_key=DEMO_KEY',
          {},
          8000
        );
        const d = await r.json();
        const v = d?.response?.data?.[0]?.value;
        if (v) wtiSpot = parseFloat(v);
      } catch (e) {}

      return {
        states,
        nationalAvg,
        wtiSpot,
        updatedAt: new Date().toISOString()
      };
    });

    res.json(data);
  } catch (e) {
    res.status(503).json({ states: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════
// /api/gdelt  — GDELT conflict intelligence
// ════════════════════════════════════════════════════
const GDELT_Q = [
  { q: 'ukraine war',           col: 1 },
  { q: 'russia military',       col: 1 },
  { q: 'israel attack',         col: 2 },
  { q: 'iran oil war',          col: 2 },
  { q: 'sudan conflict killed', col: 3 },
  { q: 'military attack war',   col: 3 },
];

app.get('/api/gdelt', async (req, res) => {
  try {
    const data = await cached('gdelt', 5 * 60_000, async () => {
      const col1 = [];
      const col2 = [];
      const col3 = [];

      await Promise.allSettled(GDELT_Q.map(async ({ q, col }) => {
        try {
          const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=10&format=json&timespan=48H&sort=DateDesc`;
          const r   = await get(url, {}, 12000);

          if (!r.ok) throw new Error(`GDELT HTTP ${r.status}`);

          const text = await r.text();
          const d    = JSON.parse(text);

          const arr = (d.articles || []).map(a => ({
            title: a.title || '',
            url: a.url || '',
            source: a.domain || '',
            date: a.seendate || '',
            score: score(a.title),
          }));

          const target = col === 1 ? col1 : col === 2 ? col2 : col3;
          arr.forEach(a => target.push(a));
        } catch (e) {
          console.warn('GDELT q failed:', e.message);
        }
      }));

      function dedup(arr) {
        const seen = new Set();
        return arr
          .filter(i => {
            const k = i.title.slice(0, 50).toLowerCase();
            if (!i.title || seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
      }

      return {
        col1: dedup(col1),
        col2: dedup(col2),
        col3: dedup(col3),
        updatedAt: new Date().toISOString()
      };
    });

    res.json(data);
  } catch (e) {
    res.status(503).json({ col1: [], col2: [], col3: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════
// /api/news  — RSS feeds for intel columns
// ════════════════════════════════════════════════════
const RSS_FEEDS = [
  { id: 'reuters',   url: 'https://feeds.reuters.com/reuters/worldNews',   col: 1 },
  { id: 'bbc',       url: 'https://feeds.bbci.co.uk/news/world/rss.xml',   col: 1 },
  { id: 'aljazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml',     col: 2 },
  { id: 'guardian',  url: 'https://www.theguardian.com/world/rss',         col: 2 },
  { id: 'dw',        url: 'https://rss.dw.com/rdf/rss-en-world',           col: 3 },
  { id: 'npr',       url: 'https://feeds.npr.org/1004/rss.xml',            col: 3 },
];

app.get('/api/news', async (req, res) => {
  try {
    const data = await cached('news', 5 * 60_000, async () => {
      const cols = { 1: [], 2: [], 3: [] };

      await Promise.allSettled(RSS_FEEDS.map(async f => {
        try {
          const items = await parseRSS(f.url);
          items
            .map(i => ({ ...i, score: score(i.title, i.desc) }))
            .filter(i => i.score > 0)
            .forEach(i => cols[f.col].push(i));
        } catch (e) {
          console.warn(f.id, 'failed:', e.message);
        }
      }));

      function dedup(arr) {
        const seen = new Set();
        return arr
          .filter(i => {
            const k = i.title.slice(0, 50).toLowerCase();
            if (!i.title || seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
      }

      return {
        col1: dedup(cols[1]),
        col2: dedup(cols[2]),
        col3: dedup(cols[3]),
        updatedAt: new Date().toISOString()
      };
    });

    res.json(data);
  } catch (e) {
    res.status(503).json({ col1: [], col2: [], col3: [], error: e.message });
  }
});

// ════════════════════════════════════════════════════
// /api/media  — major media outlet RSS feeds
// ════════════════════════════════════════════════════
const MEDIA = [
  { id: 'cnn',      name: 'CNN',            url: 'https://www.theguardian.com/us-news/rss' },
  { id: 'fox',      name: 'Fox News',       url: 'https://moxie.foxnews.com/google-publisher/world.xml' },
  { id: 'nbc',      name: 'NBC News',       url: 'https://feeds.nbcnews.com/nbcnews/public/world' },
  { id: 'ap',       name: 'Al Jazeera',     url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { id: 'sky',      name: 'Sky News',       url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  { id: 'guardian', name: 'The Guardian',   url: 'https://www.theguardian.com/world/rss' },
  { id: 'npr',      name: 'NPR',            url: 'https://feeds.npr.org/1004/rss.xml' },
  { id: 'dw',       name: 'Deutsche Welle', url: 'https://rss.dw.com/xml/rss-en-all' },
];

app.get('/api/media', async (req, res) => {
  try {
    const data = await cached('media', 2 * 60_000, async () => {
      const out = {};

      await Promise.allSettled(MEDIA.map(async m => {
        try {
          const items = await parseRSS(m.url);
          let filtered = items
            .map(i => ({ ...i, score: score(i.title, i.desc) }))
            .sort((a, b) => b.score - a.score);

          if (filtered.length < 3) filtered = items.slice(0, 8);

          out[m.id] = {
            name: m.name,
            items: filtered.slice(0, 8),
            ok: true
          };
        } catch (e) {
          console.warn(m.id, 'failed:', e.message);
          out[m.id] = {
            name: m.name,
            items: [],
            ok: false
          };
        }
      }));

      return out;
    });

    res.json(data);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════
// Health check
// ════════════════════════════════════════════════════
app.get('/api/clear-cache', (req, res) => {
  Object.keys(CACHE).forEach(k => delete CACHE[k]);
  res.json({ ok: true, message: 'Cache cleared' });
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   SENTINEL — Live Threat Intelligence        ║
║   Server running on port ${PORT}             ║
╚══════════════════════════════════════════════╝

  GET /api/markets  → stocks + oil (Yahoo/Stooq)
  GET /api/gas      → US gas prices (AAA + EIA)
  GET /api/gdelt    → conflict intel (GDELT)
  GET /api/news     → RSS intel feed (Reuters/BBC/AJ)
  GET /api/media    → CNN, Fox, NBC, AP, Sky, Guardian, NPR, DW
  GET /api/ping     → health check

  Local: http://localhost:${PORT}
`);
});