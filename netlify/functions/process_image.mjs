import { Groq } from 'groq-sdk';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawKeys = process.env.GROQ_API_KEYS || '';
  const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

  if (apiKeys.length === 0) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEYS bulunamadı.' }) };
  }

  try {
    const body = JSON.parse(event.body);
    let imageData = body.image;

    if (!imageData) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Resim verisi bulunamadı.' }) };
    }

    let imageUrl = imageData.startsWith('data:') ? imageData : `data:image/jpeg;base64,${imageData}`;
    const base64Part = imageUrl.split(',')[1];

    if (!base64Part || base64Part.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Geçersiz görsel verisi.' }) };
    }

    console.log(`Görsel boyutu: ${Math.round(base64Part.length / 1024)}KB`);

    // Prompt: Modelden verileri analiz ederek gruplandırmasını istiyoruz.
    const prompt = `Analyze this Turkish fiscal receipt carefully.
Follow these steps for accurate results:
1. List EVERY item price (look for numbers ending with * or in the rightmost column).
2. Note the VAT rate (%1, %10, or %20) next to each price.
3. Group these prices by VAT rate and calculate the GROSS SUM for each rate.
4. From the GROSS SUM, derive the Matrah (Base) and KDV Amount. 
   - Formula: Matrah = Gross / (1 + Rate/100). KDV = Gross - Matrah.

Return a JSON object:
- store_name: Merchant name.
- date: DD.MM.YYYY.
- receipt_no: 4-8 digits for standard, 16 chars for e-fatura (e.g. ABC2026...).
- total_amount: GRAND TOTAL (sum of all items).
- masraf_turu: ONE of: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER
- kdv_details: array of objects (ONE object per unique rate):
    - rate: (1, 10, or 20)
    - amount: (number: total KDV for this rate)
    - matrah: (number: total matrah for this rate)
    - gross_amount: (number: total gross including VAT for this rate)

RULES:
- NEVER use 8% or 18%. Use 10% or 20%.
- Do NOT confuse "TOPKDV" (Total Tax) with a specific rate's tax.
- Prices on receipts are ALMOST ALWAYS VAT-inclusive (Gross).
- Return ONLY valid JSON.

Example:
{"store_name":"OFİSER","date":"15.04.2026","receipt_no":"0031","total_amount":515.00,"masraf_turu":"KIRTASİYE","kdv_details":[{"rate":10,"amount":15.00,"matrah":150.00,"gross_amount":165.00},{"rate":20,"amount":58.33,"matrah":291.67,"gross_amount":350.00}]}`;

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
                { type: 'image_url', image_url: { url: imageUrl } },
                { type: 'text', text: prompt }
              ]
            }
          ],
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          response_format: { type: 'json_object' },
          max_tokens: 512,
          temperature: 0.1
        });

        const rawContent = chatCompletion.choices[0].message.content;
        console.log('Model yanıtı:', rawContent);

        const modelResult = JSON.parse(rawContent);

        // --- Gelişmiş KDV Mantığı ---
        const totalAmount = parseFloat(String(modelResult.total_amount || 0).replace(',', '.')) || 0;
        let kdvDetails = [];

        if (modelResult.kdv_details && Array.isArray(modelResult.kdv_details)) {
          kdvDetails = modelResult.kdv_details.map(det => {
            const rate = parseInt(String(det.rate).replace('%', '').trim()) || 0;
            const extractedAmt = parseFloat(String(det.amount || 0).replace(',', '.')) || 0;
            const extractedMatrah = parseFloat(String(det.matrah || 0).replace(',', '.')) || 0;
            const gross = parseFloat(String(det.gross_amount || 0).replace(',', '.')) || 0;
            
            if (rate > 0) {
              // Eğer model hem KDV tutarı hem matrah verdiyse onları kullan (güvenilir olan budur)
              if (extractedAmt > 0 && extractedMatrah > 0) {
                return { rate, matrah: extractedMatrah, amount: extractedAmt, gross: Number((extractedMatrah + extractedAmt).toFixed(2)) };
              }
              // Sadece KDV tutarı varsa (Kullanıcının durumu)
              if (extractedAmt > 0 && gross > 0) {
                const calculatedMatrah = Number((gross - extractedAmt).toFixed(2));
                return { rate, matrah: calculatedMatrah, amount: extractedAmt, gross };
              }
              // Hiçbiri yoksa veya yetersizse matematiksel hesapla (Gerileme/Fallback)
              const finalGross = gross || totalAmount;
              if (finalGross > 0) {
                const matrah = Number((finalGross / (1 + (rate / 100))).toFixed(2));
                const kdvAmt = Number((finalGross - matrah).toFixed(2));
                return { rate, matrah, amount: kdvAmt, gross: finalGross };
              }
            }
            return null;
          }).filter(Boolean);
        }

        // Eğer KDV detayı hala yoksa ama toplam tutar varsa (%20 varsayılan)
        if (kdvDetails.length === 0 && totalAmount > 0) {
          const rate = 20; 
          const matrah = Number((totalAmount / (1 + rate / 100)).toFixed(2));
          const kdvAmt = Number((totalAmount - matrah).toFixed(2));
          kdvDetails = [{ rate, matrah, amount: kdvAmt, gross: totalAmount }];
        }

        const result = {
          store_name: modelResult.store_name || '',
          date: modelResult.date || '',
          receipt_no: modelResult.receipt_no || '',
          total_amount: totalAmount,
          masraf_turu: modelResult.masraf_turu || 'DİĞER',
          kdv_details: Object.values(kdvDetails.reduce((acc, curr) => {
            if (!acc[curr.rate]) {
              acc[curr.rate] = { ...curr };
            } else {
              acc[curr.rate].matrah = Number((acc[curr.rate].matrah + curr.matrah).toFixed(2));
              acc[curr.rate].amount = Number((acc[curr.rate].amount + curr.amount).toFixed(2));
              acc[curr.rate].gross = Number((acc[curr.rate].gross + curr.gross).toFixed(2));
            }
            return acc;
          }, {}))
        };

        console.log('Sonuç:', JSON.stringify(result));

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
