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
function reorderPointFor(row, productMinBalance, variantToProduct) {
  const id = (row.meta?.href || '').split('/').pop().split('?')[0];
  if (row.meta?.type === 'product') return productMinBalance.get(id) || 0;
  if (row.meta?.type === 'variant') {
    const productId = variantToProduct.get(id);
    return productId ? (productMinBalance.get(productId) || 0) : 0;
  }
  return 0;
}

async function main() {
  const [{ rows: stock }, { rows: products }, { rows: variants }] = await Promise.all([
    msAll('/report/stock/all'),
    msAll('/entity/product'),
    msAll('/entity/variant')
  ]);

  const productMinBalance = new Map();
  products.forEach(p => { if (p.minimumBalance) productMinBalance.set(p.id, p.minimumBalance); });

  const variantToProduct = new Map();
  variants.forEach(v => {
    const productId = (v.product?.meta?.href || '').split('/').pop().split('?')[0];
    if (productId) variantToProduct.set(v.id, productId);
  });

  const candidates = stock
    .map(row => ({ row, reorderPoint: reorderPointFor(row, productMinBalance, variantToProduct) }))
    .filter(c => c.reorderPoint > 0)
    .filter(c => (c.row.quantity ?? 0) < c.reorderPoint);

  console.log(`Found ${candidates.length} item(s) with a reorder point set and available quantity below it:`);
  candidates.forEach(({ row, reorderPoint }) => {
    const quantity = row.quantity ?? 0;
    const reorderQty = reorderPoint - Math.max(quantity, 0);
    console.log(`  - ${row.name} | available=${quantity} | reorderPoint=${reorderPoint} | order=${reorderQty}`);
  });

  const positions = candidates.map(({ row, reorderPoint }) => {
    const quantity = row.quantity ?? 0;
    const reorderQty = reorderPoint - Math.max(quantity, 0);
    return {
      quantity: reorderQty,
      assortment: {
        meta: {
          href: row.meta.href.split('?')[0],
          type: row.meta.type,
          mediaType: 'application/json'
        }
      }
    };
  });

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
