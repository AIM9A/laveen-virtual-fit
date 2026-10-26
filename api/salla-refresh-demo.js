import { randomUUID, timingSafeEqual } from 'node:crypto';

const DEMO_MERCHANT_ID = '113026894';

const TOKEN_KEY =
  `salla:merchant:${DEMO_MERCHANT_ID}:tokens`;

const LOCK_KEY =
  `salla:merchant:${DEMO_MERCHANT_ID}:refresh-lock`;

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

const CLIENT_ID =
  process.env.SALLA_CLIENT_ID;

const CLIENT_SECRET =
  process.env.SALLA_CLIENT_SECRET;

const TEST_SECRET =
  process.env.SALLA_REFRESH_TEST_SECRET;

export const config = {
  maxDuration: 30
};

async function redis(command) {
  const response = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) {
    throw new Error('Redis HTTP error');
  }

  const data = await response.json();

  if (data.error) {
    throw new Error('Redis command error');
  }

  return data.result;
}

function authorized(header) {
  if (!TEST_SECRET || TEST_SECRET.length < 32) {
    return false;
  }

  const supplied = typeof header === 'string'
    ? header.replace(/^Bearer\s+/i, '')
    : '';

  const a = Buffer.from(supplied);
  const b = Buffer.from(TEST_SECRET);

  return (
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}

async function releaseLock(nonce) {
  try {
    await redis([
      'EVAL',
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      '1',
      LOCK_KEY,
      nonce
    ]);
  } catch {
    console.error(
      'Demo refresh: lock release failed'
    );
  }
}

function getExpiry(payload) {
  const expiry = Number(payload.expires);

  if (
    Number.isFinite(expiry) &&
    expiry > 1000000000
  ) {
    return expiry;
  }

  const seconds = Number(
    payload.expires_in ?? payload.expires
  );

  if (
    Number.isFinite(seconds) &&
    seconds > 0 &&
    seconds < 31536000
  ) {
    return (
      Math.floor(Date.now() / 1000) + seconds
    );
  }

  throw new Error(
    'Missing or invalid token expiry'
  );
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  if (!authorized(req.headers.authorization)) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  if (
    ![
      REDIS_URL,
      REDIS_TOKEN,
      CLIENT_ID,
      CLIENT_SECRET
    ].every(Boolean)
  ) {
    return res.status(503).json({
      error: 'Server configuration missing'
    });
  }

  const nonce = randomUUID();

  let locked = false;
  let refreshRequestStarted = false;

  try {
    const acquired = await redis([
      'SET',
      LOCK_KEY,
      nonce,
      'NX',
      'EX',
      '90'
    ]);

    if (acquired !== 'OK') {
      return res.status(409).json({
        error: 'Refresh already in progress'
      });
    }

    locked = true;

    const raw = await redis([
      'GET',
      TOKEN_KEY
    ]);

    if (typeof raw !== 'string') {
      return res.status(503).json({
        error: 'Demo authorization not found'
      });
    }

    const previous = JSON.parse(raw);

    if (
      previous.merchant_id !== DEMO_MERCHANT_ID ||
      typeof previous.refresh_token !== 'string' ||
      !previous.refresh_token
    ) {
      return res.status(503).json({
        error: 'Demo refresh token unavailable'
      });
    }

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: previous.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    // Never retry this request automatically.
    // Salla refresh tokens are single-use.

    refreshRequestStarted = true;

    const response = await fetch(
      'https://accounts.salla.sa/oauth2/token',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: form.toString(),
        cache: 'no-store',
        signal: AbortSignal.timeout(15000)
      }
    );

    if (!response.ok) {
      console.error(
        'Demo refresh rejected by Salla:',
        response.status
      );

      return res.status(502).json({
        error: 'Salla refresh rejected',
        status: response.status
      });
    }

    const next = await response.json();

    if (
      typeof next.access_token !== 'string' ||
      !next.access_token ||
      typeof next.refresh_token !== 'string' ||
      !next.refresh_token
    ) {
      throw new Error(
        'Incomplete token response'
      );
    }

    const updated = {
      ...previous,
      merchant_id: DEMO_MERCHANT_ID,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires: getExpiry(next),
      scope: next.scope ?? previous.scope ?? '',
      token_type: next.token_type ?? 'bearer',
      updated_at: new Date().toISOString()
    };

    // Save the new token pair together.

    await redis([
      'SET',
      TOKEN_KEY,
      JSON.stringify(updated)
    ]);

    let productsCheck = false;

    try {
      const check = await fetch(
        'https://api.salla.dev/admin/v2/products?page=1&per_page=1',
        {
          headers: {
            Authorization:
              `Bearer ${updated.access_token}`,
            Accept: 'application/json'
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(10000)
        }
      );

      productsCheck = check.ok;

    } catch {
      // Tokens were already saved.
      // Do not repeat the refresh request.
    }

    console.log(
      'Demo token rotated:',
      DEMO_MERCHANT_ID
    );

    return res.status(200).json({
      success: true,
      merchant_id: DEMO_MERCHANT_ID,
      token_pair_saved: true,
      products_check_passed: productsCheck
    });

  } catch (error) {
    console.error(
      'Demo refresh failed:',
      error.message
    );

    return res.status(500).json({
      error: 'Demo refresh failed',
      do_not_retry: refreshRequestStarted
    });

  } finally {
    if (locked) {
      await releaseLock(nonce);
    }
  }
}
