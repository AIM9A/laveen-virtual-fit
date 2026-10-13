
import { createHmac, timingSafeEqual } from 'node:crypto';

export const config = {
  api: {
    bodyParser: false
  }
};

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;

const WEBHOOK_SECRET =
  process.env.SALLA_WEBHOOK_SECRET;

async function readRawBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > 1024 * 1024) {
      throw new Error('Payload too large');
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function verifySignature(body, signature) {
  if (!WEBHOOK_SECRET || !signature) {
    return false;
  }

  const expected = createHmac(
    'sha256',
    WEBHOOK_SECRET
  )
    .update(body)
    .digest('hex');

  const received = String(signature)
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, '');

  if (!/^[a-f0-9]{64}$/.test(received)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(received, 'hex')
  );
}

async function saveToRedis(key, value) {
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
      'SET',
      key,
      JSON.stringify(value)
    ])
  });

  if (!response.ok) {
    throw new Error('Redis request failed');
  }

  const result = await response.json();

  if (result.error) {
    throw new Error('Redis write failed');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  if (!WEBHOOK_SECRET || !REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({
      error: 'Server configuration missing'
    });
  }

  let rawBody;

  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(413).json({
      error: 'Invalid or oversized payload'
    });
  }

  const signature = req.headers['x-salla-signature'];

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).json({
      error: 'Invalid webhook signature'
    });
  }

  let payload;

  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({
      error: 'Invalid JSON'
    });
  }

  const event = payload.event;
  const merchantId = String(payload.merchant || '');
  const data = payload.data || {};

  if (!merchantId || !/^\d+$/.test(merchantId)) {
    return res.status(400).json({
      error: 'Invalid merchant ID'
    });
  }

  try {
    if (event === 'app.store.authorize') {
      if (
        typeof data.access_token !== 'string' ||
        !data.access_token
      ) {
        return res.status(400).json({
          error: 'Missing access token'
        });
      }

      const tokenData = {
        merchant_id: merchantId,
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        expires: data.expires || null,
        scope: data.scope || '',
        token_type: data.token_type || 'bearer',
        updated_at: new Date().toISOString()
      };

      await saveToRedis(
        `salla:merchant:${merchantId}:tokens`,
        tokenData
      );

      // Keep this as a test-store mapping only.
      // Do not use it for the live store.
      await saveToRedis(
        'salla:test:merchant_id',
        merchantId
      );

      console.log(
        'Salla authorization saved for merchant:',
        merchantId
      );

      return res.status(200).json({
        success: true,
        message: 'Authorization saved'
      });
    }

    // Other authenticated events are acknowledged.
    return res.status(200).json({
      success: true,
      message: 'Event received'
    });

  } catch (error) {
    console.error('Salla webhook processing failed');

    return res.status(500).json({
      error: 'Webhook processing failed'
    });
  }
}
