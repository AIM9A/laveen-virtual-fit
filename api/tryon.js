export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { model_image, garment_image } = req.body || {};

    if (!model_image || !garment_image) {
      return res.status(400).json({ error: 'Missing model_image or garment_image' });
    }

    const response = await fetch('https://api.fashn.ai/v1/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FASHN_API_KEY}`,
      },
      body: JSON.stringify({
        model_name: 'tryon-v1.6',
        inputs: {
          model_image,
          garment_image,
          return_base64: true,
          output_format: 'png'
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.message || data?.error || 'FASHN API error',
        raw: data
      });
    }

    const result =
      data?.output?.image ||
      data?.output?.images?.[0] ||
      data?.result?.image ||
      data?.image ||
      null;

    if (!result) {
      return res.status(500).json({
        error: 'No result image returned from API',
        raw: data
      });
    }

    return res.status(200).json({ result });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Internal server error'
    });
  }
}
