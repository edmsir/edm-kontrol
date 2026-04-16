import { Groq } from 'groq-sdk';

/**
 * Netlify Function: process_image
 * OCR processing using Groq Vision API
 */
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // API Anahtarlarını al (Virgülle ayrılmış olabilir)
  const rawKeys = process.env.GROQ_API_KEYS || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

  if (apiKeys.length === 0) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GROQ_API_KEYS bulunamadı. Lütfen Netlify panelinden tanımlayın.' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    let imageData = body.image;

    if (!imageData) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Resim verisi bulunamadı.' }) };
    }

    // Base64 temizliği
    if (imageData.includes(',')) {
      imageData = imageData.split(',')[1];
    }

    const prompt = `
      Extract the following information from this Turkish receipt and return it as a JSON object. 
      
      IMPORTANT RULES:
      1. Current Turkish VAT rates: 1, 10, 20. If you see 8 or 18, it is highly likely a misread 10 or 20. Correct it!
      2. Categorize the type of expense (masraf_turu). Use ONE of these: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER.
      
      JSON Structure:
      - store_name, date, receipt_no, total_amount, masraf_turu
      - kdv_details: Array of {rate, gross_amount}
      
      Return ONLY valid JSON.
    `;

    let lastError = null;

    // Anahtar Rotasyonu: Her anahtarı sırayla dener
    console.log(`Toplam ${apiKeys.length} anahtar bulundu. İşlem başlatılıyor...`);
    
    for (const [index, key] of apiKeys.entries()) {
      try {
        console.log(`Deneme ${index + 1}: Anahtar sonu ...${key.slice(-4)}`);
        const groq = new Groq({ apiKey: key });

        const chatCompletion = await groq.chat.completions.create({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${imageData}` }
                }
              ]
            }
          ],
          model: 'groq/compound',
          response_format: { type: 'json_object' }
        });

        const result = JSON.parse(chatCompletion.choices[0].message.content);

        // KDV Hesaplama ve Doğrulama
        if (result.kdv_details && Array.isArray(result.kdv_details)) {
          result.kdv_details = result.kdv_details.map(det => {
            try {
              const rate = parseInt(String(det.rate).replace('%', '').trim()) || 0;
              const gross = parseFloat(String(det.gross_amount).replace(',', '.')) || 0;
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
        console.error(`Sıradaki anahtar deneniyor (Hata: ${err.message})`);
        lastError = err;
        continue; // Sonraki anahtara geç
      }
    }

    // Eğer tüm anahtarlar başarısız olursa
    throw new Error(`Tüm API anahtarları denendi ve başarısız oldu. Son hata: ${lastError?.message}`);

  } catch (error) {
    console.error('OCR Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
