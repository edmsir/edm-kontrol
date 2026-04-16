import json
import os
import base64
from groq import Groq

# API Anahtarlarını Environment (Ortam) Değişkenlerinden Alır
# Netlify'da 'GROQ_API_KEYS' olarak tanımlanmalıdır.
raw_keys = os.environ.get("GROQ_API_KEYS", "")
API_KEYS = [k.strip() for k in raw_keys.split(",") if k.strip()]

def handler(event, context):
    if event['httpMethod'] != 'POST':
        return {"statusCode": 405, "body": "Method Not Allowed"}

    if not API_KEYS:
        return {
            "statusCode": 500, 
            "body": json.dumps({"error": "GROQ_API_KEYS bulunamadı. Lütfen Netlify veya .env üzerinden tanımlayın."})
        }

    try:
        body = json.loads(event['body'])
        image_data = body.get('image')
        
        if not image_data:
            return {"statusCode": 400, "body": json.dumps({"error": "Resim verisi bulunamadı."})}

        # Base64 temizliği
        if "," in image_data:
            image_data = image_data.split(",")[1]

        # İlk anahtarı kullan (Gelişmiş yapıda rotasyon eklenebilir)
        client = Groq(api_key=API_KEYS[0])
        
        prompt = """
        Extract the following information from this Turkish receipt and return it as a JSON object. 
        
        IMPORTANT RULES:
        1. Current Turkish VAT rates: 1, 10, 20. If you see 8 or 18, it is highly likely a misread 10 or 20. Correct it!
        2. Categorize the type of expense (masraf_turu). Use ONE of these: YEMEK, MARKET, YAKIT, KIRTASİYE, TAMİR, OTOPARK, OTO YIKAMA, HIRDAVAT, DİĞER.
        
        JSON Structure:
        - store_name, date, receipt_no, total_amount, masraf_turu
        - kdv_details: Array of {rate, gross_amount}
        
        Return ONLY valid JSON.
        """
        
        completion = client.chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{image_data}"},
                        },
                    ],
                }
            ],
            response_format={"type": "json_object"}
        )
        
        result_content = completion.choices[0].message.content
        result = json.loads(result_content)
        
        # Matematiksel Doğrulama ve Matrah Hesaplama
        if "kdv_details" in result:
            valid_details = []
            for det in result["kdv_details"]:
                try:
                    rate = int(str(det.get("rate", "0")).replace('%', '').strip())
                    gross = float(str(det.get("gross_amount", 0)).replace(',', '.'))
                    matrah = round(gross / (1 + (rate/100)), 2)
                    kdv_amt = round(gross - matrah, 2)
                    valid_details.append({
                        "rate": rate, "amount": kdv_amt, "matrah": matrah, "gross": gross
                    })
                except: continue
            result["kdv_details"] = valid_details

        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            "body": json.dumps(result)
        }
    except Exception as e:
        return {
            "statusCode": 500, 
            "body": json.dumps({"error": str(e)})
        }
