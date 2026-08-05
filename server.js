require('dotenv').config();
const express = require('express');
const path = require('path');

const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 4000;
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';

if (!TOKEN) {
  console.error('Missing TOKEN in .env — add your MoySklad Bearer token first.');
  process.exit(1);
}

// --- MoySklad fetch helpers (see MOYSKLAD_INTEGRATION_GUIDE.md) ---

async function ms(path, _retries = 3) {
  for (let attempt = 0; attempt <= _retries; attempt++) {
    const r = await fetch(MS_BASE + path, {
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json;charset=utf-8'
      }
    });
    if (r.status === 429 && attempt < _retries) {
      await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
      continue;
    }
    if (!r.ok) throw new Error('MS API ' + r.status + ' ' + path);
    return r.json();
  }
}

async function msAll(endpoint, maxRecords = 10000) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const first = await ms(`${endpoint}${sep}limit=1000&offset=0`);
  const total = first.meta?.size || 0;
  let rows = first.rows || [];

  if (total > 1000) {
    const pages = [];
    for (let offset = 1000; offset < Math.min(total, maxRecords); offset += 1000)
      pages.push(ms(`${endpoint}${sep}limit=1000&offset=${offset}`));
    const settled = await Promise.allSettled(pages);
    settled.forEach(r => { if (r.status === 'fulfilled') rows = rows.concat(r.value.rows || []); });
  }
  return { rows, total };
}

// --- In-memory TTL cache ---

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn).catch(err => { cache.delete(key); throw err; });
  cache.set(key, { time: Date.now(), promise });
  return promise;
}

const getStock = () =>
  cached('stock_all', 3 * 60 * 1000, () => msAll('/report/stock/all').then(r => r.rows || []));

// --- App ---

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/folders', async (req, res) => {
  try {
    const stock = await getStock();
    const names = new Set();
    stock.forEach(row => { if (row.folder?.name) names.add(row.folder.name); });
    res.json({ folders: Array.from(names).sort((a, b) => a.localeCompare(b)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/low-stock', async (req, res) => {
  try {
    const threshold = Number(req.query.threshold);
    const effectiveThreshold = Number.isFinite(threshold) ? threshold : 50;
    const folder = (req.query.folder || '').trim();

    const stock = await getStock();
    const items = stock
      .filter(row => (row.quantity ?? 0) < effectiveThreshold)
      .filter(row => !folder || row.folder?.name === folder)
      .map(row => {
        const quantity = row.quantity ?? 0;
        const reorderQty = effectiveThreshold - Math.max(quantity, 0);
        return {
          name: row.name,
          quantity,
          folder: row.folder?.name || '—',
          price: row.price != null ? row.price / 100 : null,
          reorderQty
        };
      })
      .sort((a, b) => a.quantity - b.quantity);

    res.json({ threshold: effectiveThreshold, folder: folder || null, count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Low stock app running at http://localhost:${PORT}`));
