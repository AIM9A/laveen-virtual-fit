const BASE_URL = 'https://api.fashn.ai/v1';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { model_image, garment_image } = req.body || {};

    if (!process.env.FASHN_API_KEY) {
      return res.status(500).json({ error: 'FASHN_API_KEY is missing in Vercel environment variables' });
    }

    if (!model_image || !garment_image) {
      return res.status(400).json({ error: 'Missing model_image or garment_image' });
    }

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FASHN_API_KEY}`,
    };

    // 1) إنشاء المهمة
    const runResponse = await fetch(`${BASE_URL}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model_name: 'tryon-v1.6',
        inputs: {
          model_image,
          garment_image
        }
      })
    });

    const runData = await runResponse.json();

    if (!runResponse.ok) {
      return res.status(runResponse.status).json({
        error: runData?.message || runData?.error || 'FASHN run error',
        raw: runData
      });
    }

    const predictionId = runData?.id;
    if (!predictionId) {
      return res.status(500).json({
        error: 'FASHN did not return a prediction id',
        raw: runData
      });
    }

    // 2) Polling على الحالة
    const maxAttempts = 40; // تقريبًا حتى 80 ثانية
    const delayMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(delayMs);

      const statusResponse = await fetch(`${BASE_URL}/status/${predictionId}`, {
        method: 'GET',
        headers
      });

      const statusData = await statusResponse.json();

      if (!statusResponse.ok) {
        return res.status(statusResponse.status).json({
          error: statusData?.message || statusData?.error || 'FASHN status error',
          raw: statusData
        });
      }

      const status = statusData?.status;

      if (status === 'completed') {
        const output = statusData?.output;

        const result =
          output?.image ||
          output?.images?.[0] ||
          (Array.isArray(output) ? output[0] : null) ||
          statusData?.result?.image ||
          statusData?.image ||
          null;

        if (!result) {
          return res.status(500).json({
            error: 'Prediction completed but no result image was returned',
            raw: statusData
          });
        }

        return res.status(200).json({ result });
      }

      if (status === 'failed' || status === 'cancelled') {
        return res.status(500).json({
          error: `Prediction ${status}`,
          raw: statusData
        });
      }
    }

    return res.status(504).json({
      error: 'Timed out while waiting for FASHN result'
    });

  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Internal server error'
    });
  }
}
