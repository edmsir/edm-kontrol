import { Groq } from 'groq-sdk';

/**
 * Netlify Function: process_image
 * OCR processing using Groq Vision API
 */
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawKeys = process.env.GROQ_API_KEYS || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

  if (apiKeys.length === 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GROQ_API_KEYS bulunamadı.' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    let imageData = body.image;

    if (!imageData) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Resim verisi bulunamadı.' }) };
    }

    // data URI prefix'i koru (model bunu istiyor)
    // Eğer prefix yoksa ekle
    let imageUrl;
    if (imageData.startsWith('data:')) {
      imageUrl = imageData;
    } else {
      imageUrl = `data:image/jpeg;base64,${imageData}`;
    }

    // Base64 kısmını doğrula
    const base64Part = imageUrl.split(',')[1];
    if (!base64Part || base64Part.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Geçersiz görsel verisi.' }) };
    }

    console.log(`Görsel boyutu: ${Math.round(base64Part.length / 1024)}KB`);

    const prompt = `Extract the following information from this Turkish receipt and return it as a JSON object.

IMPORTANT RULES:
1. Turkish VAT rates are 1, 10, or 20. Correct any misread values.
2. Categorize masraf_turu as one of: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER.

Return JSON with these fields:
- store_name (string)
- date (string, format DD.MM.YYYY)
- receipt_no (string)
- total_amount (number)
- masraf_turu (string)
- kdv_details (array of objects with: rate (number), gross_amount (number))

Return ONLY valid JSON, no markdown.`;

    let lastError = null;
    console.log(`Toplam ${apiKeys.length} anahtar. İşlem başlatılıyor...`);

    for (const [index, key] of apiKeys.entries()) {
      try {
        console.log(`Deneme ${index + 1}: ...${key.slice(-6)}`);
        const groq = new Groq({ apiKey: key });

        const chatCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: imageUrl
                  }
                },
                {
                  type: 'text',
                  text: prompt
                }
              ]
            }
          ],
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          response_format: { type: 'json_object' },
          max_tokens: 1024,
          temperature: 0.1
        });

        const rawContent = chatCompletion.choices[0].message.content;
        console.log('Model yanıtı:', rawContent.substring(0, 200));

        const result = JSON.parse(rawContent);

        // KDV Hesaplama
        if (result.kdv_details && Array.isArray(result.kdv_details)) {
          result.kdv_details = result.kdv_details.map(det => {
            try {
              const rate = parseInt(String(det.rate).replace('%', '').trim()) || 0;
              const gross = parseFloat(String(det.gross_amount || det.gross || 0).replace(',', '.')) || 0;
              const matrah = Number((gross / (1 + (rate / 100))).toFixed(2));
              const kdvAmt = Number((gross - matrah).toFixed(2));
              return { rate, amount: kdvAmt, matrah, gross };
            } catch (e) { return null; }
          }).filter(Boolean);
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(result)
        };

      } catch (err) {
        console.error(`Anahtar ${index + 1} başarısız: ${err.message}`);
        lastError = err;
        continue;
      }
    }

    throw new Error(`Tüm anahtarlar başarısız. Son hata: ${lastError?.message}`);

  } catch (error) {
    console.error('OCR Hatası:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
