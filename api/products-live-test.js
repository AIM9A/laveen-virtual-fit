  const images = productImages(product);
  return {
    id: product.id,
    name: product.name || 'منتج',
    sku: product.sku || '',
    type: product.type || 'unknown',
    image: images[0] || '',
    images,
    product_url: validUrl(product.urls?.customer || product.url)
  };
}

function isAbaya(product) {
  const name = String(product.name || '');
  return /عباي[ةه]|abaya/i.test(name);
}

async function fetchProductsPage(accessToken, page) {
  const url = new URL(`${SALLA_API}/products`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '50');
  url.searchParams.set('status', 'sale');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    cache: 'no-store'
  });

  if (!response.ok) {
    const error = new Error('Salla request failed');
    error.status = response.status;
    throw error;
  }

  const json = await response.json();
  if (!Array.isArray(json.data)) {
    throw new Error('Invalid Salla products response');
  }
  return json;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tokens = await getRedisValue(
      `salla:merchant:${MERCHANT_ID}:tokens`
    );
    if (!tokens?.access_token) {
      return res.status(503).json({
        error: 'Salla store authorization not found'
      });
    }

    const firstPage = await fetchProductsPage(tokens.access_token, 1);
    const totalPages = Number(firstPage.pagination?.totalPages) || 1;
    // Safety limit for this temporary test route.
    if (totalPages > 20) {
      return res.status(503).json({
        error: 'Too many product pages for the test endpoint'
      });
    }

    const allProducts = [...firstPage.data];
    // Fetch in batches of 3 to avoid a large burst of requests.
    for (let start = 2; start <= totalPages; start += 3) {
      const end = Math.min(totalPages, start + 2);
      const batch = [];
      for (let page = start; page <= end; page++) {
        batch.push(fetchProductsPage(tokens.access_token, page));
      }
      const results = await Promise.all(batch);
      for (const result of results) allProducts.push(...result.data);
    }

    const types = {};
    const statuses = {};
    for (const product of allProducts) {
      const type = String(product.type || 'unknown');
      const status = String(product.status || 'unknown');
      types[type] = (types[type] || 0) + 1;
      statuses[status] = (statuses[status] || 0) + 1;
    }

    // Abayas may be stored as product or service in Salla.
    const matchedAbayas = allProducts
      .filter((product) => product.status === 'sale')
      .filter(isAbaya);

    const products = matchedAbayas
      .map(cleanProduct)
      .filter((product) => product.images.length > 0 && product.product_url)
      .filter((product, index, items) =>
        items.findIndex((item) => item.id === product.id) === index
      );

    return res.status(200).json({
      success: true,
      merchant_id: MERCHANT_ID,
      products,
      diagnostics: {
        received: allProducts.length,
        pages_fetched: totalPages,
        types,
        statuses,
        abayas_by_name: matchedAbayas.length,
        abayas_with_images_and_url: products.length
      },
      pagination: firstPage.pagination || null
    });
  } catch (error) {
    console.error('Products live test failed:', error.message);
    if (error.status) {
      return res.status(502).json({
        error: error.status === 401
          ? 'Salla authorization expired or invalid'
          : 'Unable to fetch Salla products'
      });
    }
    return res.status(500).json({ error: 'Unable to load products' });
  }
}
