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

    // Prompt: Modelden fiş üzerindeki verileri doğrudan okumasını istiyoruz.
    const prompt = `You are an expert at reading Turkish fiscal receipts (fatura/fiş).
Analyze this receipt image carefully and extract EXACTLY what you see.

Return a JSON object with these fields:
- store_name: the merchant/store name (string)
- date: the date on receipt in DD.MM.YYYY format (string)
- receipt_no: the receipt/invoice number (string). Look for "Fiş No", "No:", or "Belge No".
- total_amount: the GRAND TOTAL paid (number, no currency symbols)
- masraf_turu: category, ONE of: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER
- kdv_details: array of objects for EACH VAT rate. Receipts often have a table or summary at the bottom listing "KDV", "MATRAH", or "VERGİ" per rate.
    - rate: (number: 1, 10, or 20)
    - amount: (number: the VAT amount/KDV Tutarı explicitly written for this rate)
    - matrah: (number: the taxable base/KDV Matrahı explicitly written for this rate)
    - gross_amount: (number: the total including VAT for this rate)

RULES:
- Turkish VAT rates are strictly: 1, 10, or 20.
- MULTI-VAT ACCURACY: If a receipt has more than one VAT rate, you MUST find the breakdown section and extract EACH rate's specific Matrah and Amount. Do NOT sum them into one.
- DO NOT CALCULATE: Extract the numbers exactly as they appear on the receipt. If a number is clearly "KDV Tutarı" for %10, use it as 'amount'.
- If the receipt has a "KDV DAĞILIMI" or "VERGİ DETAYI" section, prioritize values from there.
- Return ONLY valid JSON.

Example for multi-VAT:
{"store_name":"XYZ","date":"16.04.2024","receipt_no":"123","total_amount":500.00,"masraf_turu":"MARKET","kdv_details":[{"rate":10,"amount":10.00,"matrah":100.00,"gross_amount":110.00},{"rate":20,"amount":65.00,"matrah":325.00,"gross_amount":390.00}]}`;

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
          kdv_details: kdvDetails
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
