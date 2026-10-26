import { randomUUID, timingSafeEqual } from 'node:crypto';

const MERCHANT_ID = '2110593632';

const TOKEN_KEY =
  `salla:merchant:${MERCHANT_ID}:tokens`;

const LOCK_KEY =
  `salla:merchant:${MERCHANT_ID}:refresh-lock`;

const ATTEMPT_KEY =
  `salla:merchant:${MERCHANT_ID}:refresh-attempt`;

const REFRESH_BEFORE_SECONDS = 3 * 24 * 60 * 60;

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

const CLIENT_ID =
  process.env.SALLA_CLIENT_ID;

const CLIENT_SECRET =
  process.env.SALLA_CLIENT_SECRET;

const CRON_SECRET =
  process.env.CRON_SECRET;

export const config = {
  maxDuration: 30
};

function authorized(value) {
  if (!CRON_SECRET || CRON_SECRET.length < 32) {
    return false;
  }

  const supplied = typeof value === 'string'
    ? value.replace(/^Bearer\s+/i, '')
    : '';

  const a = Buffer.from(supplied);
  const b = Buffer.from(CRON_SECRET);

  return (
    a.length === b.length &&
    timingSafeEqual(a, b)
  );
}

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

  const json = await response.json();

  if (json.error) {
    throw new Error('Redis command error');
  }

  return json.result;
}

async function unlock(nonce) {
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
      'Salla cron lock cleanup failed'
    );
  }
}

function expiryFromOAuth(data) {
  const absolute = Number(data.expires);

  if (
    Number.isFinite(absolute) &&
    absolute > 1000000000
  ) {
    return absolute;
  }

  const seconds = Number(
    data.expires_in ?? data.expires
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
    'Invalid Salla token expiry'
  );
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
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
  let refreshStarted = false;

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
        status: 'already_running'
      });
    }

    locked = true;

    // Prevent reuse after an uncertain attempt.

    const priorAttempt = await redis([
      'GET',
      ATTEMPT_KEY
    ]);

    if (priorAttempt) {
      return res.status(409).json({
        status: 'manual_review_required'
      });
    }

    const raw = await redis([
      'GET',
      TOKEN_KEY
    ]);

    if (typeof raw !== 'string') {
      return res.status(503).json({
        error: 'Store authorization missing'
      });
    }

    const previous = JSON.parse(raw);

    if (
      String(previous.merchant_id) !== MERCHANT_ID
    ) {
      throw new Error(
        'Merchant ID mismatch'
      );
    }

    const expires = Number(previous.expires);

    if (
      !Number.isFinite(expires) ||
      expires <= 0
    ) {
      throw new Error(
        'Stored expiry is invalid'
      );
    }

    const remaining =
      expires - Math.floor(Date.now() / 1000);

    // No refresh if more than 3 days remain.

    if (remaining > REFRESH_BEFORE_SECONDS) {
      return res.status(200).json({
        status: 'not_due',
        merchant_id: MERCHANT_ID
      });
    }

    if (
      typeof previous.refresh_token !== 'string' ||
      !previous.refresh_token
    ) {
      throw new Error(
        'Refresh token missing'
      );
    }

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: previous.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    // Record the attempt before contacting Salla.

    await redis([
      'SET',
      ATTEMPT_KEY,
      new Date().toISOString()
    ]);

    // Never automatically retry a single-use token.

    refreshStarted = true;

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
        'Salla cron refresh rejected:',
        response.status
      );

      return res.status(502).json({
        error: 'Salla refresh rejected'
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
        'Incomplete OAuth token response'
      );
    }

    const updated = {
      ...previous,
      merchant_id: MERCHANT_ID,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires: expiryFromOAuth(next),
      scope: next.scope ?? previous.scope ?? '',
      token_type: next.token_type ?? 'bearer',
      updated_at: new Date().toISOString()
    };

    // Save both newly issued tokens together.

    await redis([
      'SET',
      TOKEN_KEY,
      JSON.stringify(updated)
    ]);

    // Clear the attempt marker after saving.

    await redis([
      'DEL',
      ATTEMPT_KEY
    ]);

    console.log(
      'Salla cron token rotation saved for merchant:',
      MERCHANT_ID
    );

    return res.status(200).json({
      status: 'refreshed',
      merchant_id: MERCHANT_ID
    });

  } catch (error) {
    console.error(
      'Salla cron failed:',
      error.message
    );

    return res.status(500).json({
      error: 'Salla refresh job failed',
      do_not_retry: refreshStarted
    });

  } finally {
    if (locked) {
      await unlock(nonce);
    }
  }
}
