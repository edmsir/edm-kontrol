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
- receipt_no: the receipt or invoice number (string). 
    - Look for labels like "FİŞ NO", "FİŞ NUMARASI", "BELGE NO", or "FATURA NO".
    - For E-ARŞİV or E-FATURA: These numbers are typically 16 characters long, starting with 3 letters followed by the year and then a long sequence (e.g., GIB2026000000001, BYG2026000000123). ALWAYS prioritize these 16-character strings if they exist.
    - If it's a standard receipt, it's usually a 4-8 digit number found near the top or bottom.
- total_amount: the GRAND TOTAL paid (number, no currency symbols)
- masraf_turu: category, ONE of: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER
- kdv_details: array of objects. Group items by VAT rate (1, 10, 20). If there are multiple items with SAME rate, SUM their matrah and amount into one object for that rate.
    - rate: (number: 1, 10, or 20)
    - amount: (number: total VAT amount for this rate)
    - matrah: (number: total taxable base for this rate)
    - gross_amount: (number: total including VAT for this rate)

RULES:
- Turkish VAT rates are strictly: 1, 10, or 20.
- GROUP BY RATE: You MUST produce only ONE object per VAT rate. If there are multiple 10% items, sum them up.
- DO NOT CALCULATE: Extract and sum the numbers as written.
- If the receipt has a "KDV DAĞILIMI" section, use those summarized values.
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
