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

    // Prompt: Modelden SADECE okuduğu ham veriyi istiyoruz.
    // KDV hesaplamalarını biz yapacağız.
    const prompt = `You are an expert at reading Turkish fiscal receipts (fatura/fiş).

Analyze this receipt image carefully and extract EXACTLY what you see.

Return a JSON object with these fields:
- store_name: the merchant/store name (string)
- date: the date on receipt in DD.MM.YYYY format (string)
- receipt_no: the receipt/invoice number (string, look for "Fiş No", "No:", "Belge No", "EFT No" etc.)
- total_amount: the GRAND TOTAL paid, the biggest total amount on the receipt (number, no currency symbols)
- masraf_turu: category, ONE of: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER
- kdv_rates: array of VAT rate percentages found on the receipt (e.g. [20] or [10, 20] or [1])

RULES:
- Turkish VAT rates are only: 1, 10, or 20. Never 8 or 18.
- total_amount is the FINAL TOTAL including VAT (KDV Dahil Toplam / Genel Toplam / Toplam Tutar)
- Return ONLY valid JSON, no markdown, no explanation.

Example output:
{"store_name":"ABC MARKET","date":"15.03.2024","receipt_no":"0042","total_amount":183.33,"masraf_turu":"MARKET","kdv_rates":[20]}`;

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

        // --- Akıllı KDV Hesaplama ---
        // Toplam tutarı ve KDV oranlarını kullanarak matrahı kendimiz hesaplıyoruz.
        // Modele güvenmek yerine matematiksel olarak hesaplıyoruz.
        const totalAmount = parseFloat(String(modelResult.total_amount || 0).replace(',', '.')) || 0;
        const kdvRates = Array.isArray(modelResult.kdv_rates)
          ? modelResult.kdv_rates.map(r => parseInt(String(r)) || 0).filter(r => [1, 10, 20].includes(r))
          : [];

        let kdvDetails = [];

        if (totalAmount > 0 && kdvRates.length > 0) {
          if (kdvRates.length === 1) {
            // Tek KDV oranı: toplam tutardan hesapla
            const rate = kdvRates[0];
            const matrah = Number((totalAmount / (1 + rate / 100)).toFixed(2));
            const kdvAmt = Number((totalAmount - matrah).toFixed(2));
            kdvDetails = [{ rate, matrah, amount: kdvAmt, gross: totalAmount }];
          } else {
            // Birden fazla KDV oranı: her birini eşit dağıt (model oran listesini verdi)
            // Kullanıcı formu düzeltebilir
            const perRate = Number((totalAmount / kdvRates.length).toFixed(2));
            kdvDetails = kdvRates.map(rate => {
              const matrah = Number((perRate / (1 + rate / 100)).toFixed(2));
              const kdvAmt = Number((perRate - matrah).toFixed(2));
              return { rate, matrah, amount: kdvAmt, gross: perRate };
            });
          }
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
