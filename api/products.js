const SALLA_API = 'https://api.salla.dev/admin/v2';

const MERCHANT_ID = '2110593632';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;


// Read the stored Salla authorization.

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


// Accept HTTPS links only.

function httpsUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  try {
    const url = new URL(value);

    return url.protocol === 'https:'
      ? url.href
      : '';

  } catch {
    return '';
  }
}


// Extract all available product images.

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


// Include Arabic and English abaya names.

function isAbaya(product) {
  const name = String(product.name || '');

  return /عباي[ةه]|abaya/i.test(name);
}


// Prepare product data for the storefront.

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


// Fetch one page from Salla.

async function fetchPage(accessToken, page) {
  const url = new URL(
    `${SALLA_API}/products`
  );

  url.searchParams.set(
    'page',
    String(page)
  );

  url.searchParams.set(
    'per_page',
    '50'
  );

  url.searchParams.set(
    'status',
    'sale'
  );

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const error = new Error(
      'Salla API rejected request'
    );

    error.status = response.status;

    throw error;
  }

  const json = await response.json();

  if (!Array.isArray(json.data)) {
    throw new Error(
      'Invalid Salla response'
    );
  }

  return json;
}


// Vercel function configuration.

export const config = {
  maxDuration: 30
};


// Main products API.

export default async function handler(req, res) {
  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const tokens = await getStoredTokens();

    if (
      String(tokens?.merchant_id) !== MERCHANT_ID ||
      !tokens?.access_token
    ) {
      return res.status(503).json({
        error: 'Salla authorization unavailable'
      });
    }

    // Fetch the first page.

    const first = await fetchPage(
      tokens.access_token,
      1
    );

    const totalPages =
      Number(first.pagination?.totalPages) || 1;

    if (
      !Number.isInteger(totalPages) ||
      totalPages < 1 ||
      totalPages > 20
    ) {
      throw new Error(
        'Unexpected number of product pages'
      );
    }

    const rawProducts = [...first.data];

    // Fetch remaining pages in batches of three.

    for (
      let start = 2;
      start <= totalPages;
      start += 3
    ) {
      const batch = [];

      for (
        let page = start;
        page <= Math.min(
          start + 2,
          totalPages
        );
        page++
      ) {
        batch.push(
          fetchPage(
            tokens.access_token,
            page
          )
        );
      }

      const results = await Promise.all(batch);

      for (const result of results) {
        rawProducts.push(...result.data);
      }
    }

    // Keep available abayas and remove duplicates.

    const seen = new Set();

    const products = rawProducts
      .filter(
        (product) =>
          product.status === 'sale' &&
          isAbaya(product)
      )
      .map(cleanProduct)
      .filter((product) => {
        if (
          !product.id ||
          !product.images.length ||
          !product.product_url ||
          seen.has(product.id)
        ) {
          return false;
        }

        seen.add(product.id);

        return true;
      });

    // Cache public product data for five minutes.
    // Access tokens are never returned to visitors.

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=300, stale-while-revalidate=600'
    );

    return res.status(200).json({
      success: true,
      products,
      pagination: {
        total: products.length,
        currentPage: 1,
        totalPages: 1
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
