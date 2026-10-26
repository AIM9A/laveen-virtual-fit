const SALLA_API = 'https://api.salla.dev/admin/v2';
const MERCHANT_ID = '2110593632';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

async function getStoredTokens() {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Redis is not configured');
  }

  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      'GET',
      `salla:merchant:${MERCHANT_ID}:tokens`
    ]),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error('Redis connection failed');
  }

  const json = await response.json();

  if (json.error) {
    throw new Error('Redis read failed');
  }

  if (!json.result) {
    return null;
  }

  return typeof json.result === 'string'
    ? JSON.parse(json.result)
    : json.result;
}

function httpsUrl(value) {
  if (typeof value !== 'string') return '';

  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function imagesOf(product) {
  const images = [];

  function add(value) {
    if (value && typeof value === 'object') {
      add(value.url);
      add(value.image);
      add(value.original);
      return;
    }

    const url = httpsUrl(value);

    if (url && !images.includes(url)) {
      images.push(url);
    }
  }

  add(product.thumbnail);
  add(product.main_image);
  add(product.image);

  if (Array.isArray(product.images)) {
    product.images.forEach(add);
  }

  return images;
}

function isAbaya(product) {
  return /عباي[ةه]|abaya/i.test(
    String(product.name || '')
  );
}

function cleanProduct(product) {
  const images = imagesOf(product);

  const productUrl = httpsUrl(
    product.urls?.customer || product.url
  );

  return {
    id: product.id,
    name: product.name || 'عباية',
    sku: product.sku || '',
    image: images[0] || '',
    images,
    product_url: productUrl
  };
}

async function fetchPage(accessToken, page, keyword) {
  const url = new URL(`${SALLA_API}/products`);

  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '50');
  url.searchParams.set('status', 'sale');

  if (keyword) {
    url.searchParams.set('keyword', keyword);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const error = new Error('Salla API rejected request');
    error.status = response.status;
    throw error;
  }

  const json = await response.json();

  if (!Array.isArray(json.data)) {
    throw new Error('Invalid Salla response');
  }

  return json;
}

export const config = {
  maxDuration: 30
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const q = String(req.query.q || '')
      .trim()
      .slice(0, 80);

    const rawCursor = String(
      req.query.cursor || '1-0'
    );

    const cursorMatch =
      /^(\d{1,2})-(\d{1,2})$/.exec(rawCursor);

    if (!cursorMatch) {
      return res.status(400).json({
        error: 'Invalid cursor'
      });
    }

    let page = Number(cursorMatch[1]);
    let offset = Number(cursorMatch[2]);

    if (
      page < 1 ||
      page > 20 ||
      offset < 0 ||
      offset >= 50
    ) {
      return res.status(400).json({
        error: 'Invalid cursor'
      });
    }

    const tokens = await getStoredTokens();

    if (
      String(tokens?.merchant_id) !== MERCHANT_ID ||
      !tokens?.access_token
    ) {
      return res.status(503).json({
        error: 'Salla authorization unavailable'
      });
    }

    const products = [];
    const seen = new Set();

    let nextCursor = null;

    const normalized = (value) =>
      String(value || '')
        .toLowerCase()
        .replace(/\s+/g, '');

    const needle = normalized(q);

    // Load only enough Salla pages for 30 abayas.
    while (page <= 20) {
      const result = await fetchPage(
        tokens.access_token,
        page,
        q
      );

      const totalPages =
        Number(result.pagination?.totalPages) || 1;

      if (
        !Number.isInteger(totalPages) ||
        totalPages < 1 ||
        totalPages > 20
      ) {
        throw new Error(
          'Unexpected number of product pages'
        );
      }

      if (page > totalPages) {
        break;
      }

      for (
        let index = offset;
        index < result.data.length;
        index++
      ) {
        const raw = result.data[index];

        if (
          raw.status !== 'sale' ||
          !isAbaya(raw)
        ) {
          continue;
        }

        if (
          needle &&
          !normalized(raw.name).includes(needle) &&
          !normalized(raw.sku).includes(needle)
        ) {
          continue;
        }

        const product = cleanProduct(raw);

        if (
          !product.id ||
          !product.images.length ||
          !product.product_url ||
          seen.has(String(product.id))
        ) {
          continue;
        }

        // Save the position of the next batch.
        if (products.length === 30) {
          nextCursor = `${page}-${index}`;
          break;
        }

        products.push(product);
        seen.add(String(product.id));
      }

      if (nextCursor || page >= totalPages) {
        break;
      }

      page++;
      offset = 0;
    }

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=120, stale-while-revalidate=300'
    );

    return res.status(200).json({
      success: true,
      products,
      hasNext: !!nextCursor,
      nextCursor,
      pagination: {
        count: products.length,
        perPage: 30
      }
    });

  } catch (error) {
    console.error(
      'Salla products error:',
      error.message
    );

    return res.status(
      error.status === 401 ? 502 : 500
    ).json({
      error: error.status === 401
        ? 'Salla authorization expired or invalid'
        : 'Unable to load products'
    });
  }
}
