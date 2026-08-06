require('dotenv').config();

const TOKEN = process.env.TOKEN;
const MS_BASE = 'https://api.moysklad.ru/api/remap/1.2';
const STORE_ID = 'acc89668-dc19-11f0-0a80-1b4c00271378'; // yuzhnie Varota
const ORGANIZATION_ID = 'acc70c4d-dc19-11f0-0a80-1b4c00271375'; // pd

if (!TOKEN) {
  console.error('Missing TOKEN env var.');
  process.exit(1);
}

async function ms(path, options = {}, _retries = 3) {
  for (let attempt = 0; attempt <= _retries; attempt++) {
    const r = await fetch(MS_BASE + path, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept': 'application/json;charset=utf-8',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (r.status === 429 && attempt < _retries) {
      await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
      continue;
    }
    if (!r.ok) throw new Error('MS API ' + r.status + ' ' + path + ' ' + await r.text());
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

// The "Reorder Point" shown in the Stock UI lives on the product entity as
// `minimumBalance`. Variants don't carry their own value — they inherit it
// from their parent product — so a variant -> product lookup is needed.
function reorderPointFor(id, type, productMinBalance, variantToProduct) {
  if (type === 'product') return productMinBalance.get(id) || 0;
  if (type === 'variant') {
    const productId = variantToProduct.get(id);
    return productId ? (productMinBalance.get(productId) || 0) : 0;
  }
  return 0;
}

async function main() {
  // report/stock/bystore breaks quantity down per warehouse — needed because
  // this order only replenishes yuzhnie Varota, not company-wide stock.
  // Fetched sequentially: this MoySklad plan's concurrent-request limit
  // rejects them with a 403 when fired in parallel.
  const { rows: byStore } = await msAll('/report/stock/bystore');
  const { rows: products } = await msAll('/entity/product');
  const { rows: variants } = await msAll('/entity/variant');
  const { rows: assortment } = await msAll('/entity/assortment');

  const nameMap = new Map();
  assortment.forEach(a => { if (a.meta?.href) nameMap.set(a.meta.href.split('?')[0], a.name); });

  const productMinBalance = new Map();
  products.forEach(p => { if (p.minimumBalance) productMinBalance.set(p.id, p.minimumBalance); });

  const variantToProduct = new Map();
  variants.forEach(v => {
    const productId = (v.product?.meta?.href || '').split('/').pop().split('?')[0];
    if (productId) variantToProduct.set(v.id, productId);
  });

  const candidates = [];
  byStore.forEach(row => {
    const href = row.meta.href.split('?')[0];
    const id = href.split('/').pop();
    const type = row.meta.type;
    const reorderPoint = reorderPointFor(id, type, productMinBalance, variantToProduct);
    if (reorderPoint <= 0) return;

    const storeEntry = row.stockByStore.find(s => s.meta.href.includes(STORE_ID));
    const available = storeEntry ? storeEntry.stock - storeEntry.reserve : 0;
    if (available >= reorderPoint) return;

    candidates.push({
      href,
      type,
      name: nameMap.get(href) || id,
      available,
      reorderPoint,
      reorderQty: reorderPoint - Math.max(available, 0)
    });
  });

  console.log(`Found ${candidates.length} item(s) below their reorder point in yuzhnie Varota:`);
  candidates.forEach(c => {
    console.log(`  - ${c.name} | available=${c.available} | reorderPoint=${c.reorderPoint} | order=${c.reorderQty}`);
  });

  const positions = candidates.map(c => ({
    quantity: c.reorderQty,
    assortment: {
      meta: {
        href: c.href,
        type: c.type,
        mediaType: 'application/json'
      }
    }
  }));

  if (!positions.length) {
    console.log('Nothing to order.');
    return;
  }

  const body = {
    organization: {
      meta: {
        href: `${MS_BASE}/entity/organization/${ORGANIZATION_ID}`,
        type: 'organization',
        mediaType: 'application/json'
      }
    },
    store: {
      meta: {
        href: `${MS_BASE}/entity/store/${STORE_ID}`,
        type: 'store',
        mediaType: 'application/json'
      }
    },
    positions
  };

  const created = await ms('/entity/internalorder', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  console.log(`Created internal order ${created.name} with ${positions.length} position(s).`);
  console.log(created.meta.uuidHref);
}

main().catch(err => {
  console.error('Failed to create internal order:', err.message);
  process.exit(1);
});
