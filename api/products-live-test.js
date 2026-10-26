
const SALLA_API = 'https://api.salla.dev/admin/v2';

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

// رقم المتجر التجريبي فقط
const TEST_MERCHANT_ID = '2110593632';

async function getRedisValue(key) {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Redis environment variables missing');
  }

  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(['GET', key]),
    cache: 'no-store'
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

function validUrl(value) {
  if (typeof value !== 'string') return '';

  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function productImages(product) {
  const images = [];

  function add(value) {
    const url = validUrl(value);
    if (url && !images.includes(url)) {
      images.push(url);
    }
  }

  add(product.thumbnail);
add(product.main_image);

  if (typeof product.image === 'string') {
    add(product.image);
  } else {
    add(product.image?.url);
  }

  if (Array.isArray(product.images)) {
    product.images.forEach((image) => {
      if (typeof image === 'string') {
        add(image);
      } else {
        add(image?.url);
        add(image?.image);
      }
    });
  }

  return images;
}

function cleanProduct(product) {
  return {
    id: product.id,
    name: product.name || 'عباية',
    sku: product.sku || '',
    image: productImages(product)[0] || '',
    images: productImages(product),
    product_url: validUrl(
      product.urls?.customer || product.url
    )
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const tokens = await getRedisValue(
      `salla:merchant:${TEST_MERCHANT_ID}:tokens`
    );

    if (!tokens?.access_token) {
      return res.status(503).json({
        error: 'Salla store authorization not found'
      });
    }

    const page = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.page, 10) || 1)
    );

    const url = new URL(`${SALLA_API}/products`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '50');
    url.searchParams.set('status', 'sale');

    const sallaResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json'
      },
      cache: 'no-store'
    });

    if (!sallaResponse.ok) {
      return res.status(502).json({
        error: sallaResponse.status === 401
          ? 'Salla authorization expired or invalid'
          : 'Unable to fetch Salla products'
      });
    }

    const json = await sallaResponse.json();

    if (!Array.isArray(json.data)) {
      throw new Error('Invalid Salla products response');
    }

    const regularProducts = json.data
  .filter((p) => p.type === 'product');

const saleProducts = regularProducts
  .filter((p) => p.status === 'sale');

const cleanedProducts = saleProducts
  .map(cleanProduct);

const products = cleanedProducts
  .filter((p) => p.images.length > 0);

const diagnostics = {
  received: json.data.length,
  regular_products: regularProducts.length,
  sale_products: saleProducts.length,
  products_with_images: products.length
};

    return res.status(200).json({
      success: true,
      products,
      pagination: json.pagination || null
    });

  } catch (error) {
    console.error('Products API error:', error.message);

    return res.status(500).json({
      error: 'Unable to load products'
    });
  }
}
