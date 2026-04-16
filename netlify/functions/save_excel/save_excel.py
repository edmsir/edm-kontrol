import json
import io
import base64
import xlsxwriter
import datetime

def handler(event, context):
    if event['httpMethod'] != 'POST':
        return {"statusCode": 405, "body": "Method Not Allowed"}

    try:
        data = json.loads(event['body'])
        rows = data.get('rows', [])
        unvan_header = data.get('unvan', 'BEY KUMAŞÇILIK TEKSTİL SANAYİ VE DIŞ TİCARET LİMTED ŞİRKETİ').upper()

        output = io.BytesIO()
        workbook = xlsxwriter.Workbook(output)
        worksheet = workbook.add_worksheet("Rapor")
        
        # --- FORMATLAR ---
        title_fmt = workbook.add_format({'bold': True, 'size': 10, 'align': 'left', 'valign': 'vcenter'})
        date_label_fmt = workbook.add_format({'bold': True, 'align': 'right', 'border': 1})
        date_val_fmt = workbook.add_format({'align': 'center', 'border': 1, 'bold': True})
        
        header_fmt = workbook.add_format({'bold': True, 'border': 1, 'align': 'center', 'valign': 'vcenter'})
        header_gray_fmt = workbook.add_format({'bold': True, 'bg_color': '#A6A6A6', 'border': 1, 'align': 'center', 'valign': 'vcenter'})
        
        cell_fmt = workbook.add_format({'border': 1, 'valign': 'vcenter'})
        cell_center_fmt = workbook.add_format({'border': 1, 'align': 'center', 'valign': 'vcenter'})
        money_fmt = workbook.add_format({'num_format': '#,##0.00', 'border': 1, 'valign': 'vcenter'})
        total_fmt = workbook.add_format({'bold': True, 'border': 1, 'num_format': '#,##0.00'})
        total_label_fmt = workbook.add_format({'bold': True, 'align': 'right', 'border': 1})
        
        # --- BAŞLIK ALANI ---
        # Görseldeki gibi BEY KUMAŞÇILIK A1:F2'de geniş bir alanda yazıyor
        worksheet.merge_range('A1:F2', unvan_header, title_fmt)
        
        today_str = datetime.datetime.now().strftime("%d.%m.%Y")
        worksheet.write('H2', "Tarih", date_label_fmt)
        worksheet.write('I2', today_str, date_val_fmt)

        # --- ANA TABLO BAŞLIKLARI (6. Satır) ---
        header_row = 4 # Index 4 = Satır 5
        headers = ["SIRA NO", "TARİH", "FİŞ NO", "UNVAN", "MASRAF TÜRÜ", "TOPLAM", "MATRAH", "KDV ORANI", "KDV TUTARI"]
        
        # Sütun Genişlikleri
        worksheet.set_column(0, 0, 10)  # SIRA NO
        worksheet.set_column(1, 1, 15)  # TARİH
        worksheet.set_column(2, 2, 12)  # FİŞ NO
        worksheet.set_column(3, 3, 30)  # UNVAN
        worksheet.set_column(4, 4, 15)  # MASRAF TÜRÜ
        worksheet.set_column(5, 5, 12)  # TOPLAM
        worksheet.set_column(6, 6, 12)  # MATRAH
        worksheet.set_column(7, 7, 12)  # KDV ORANI
        worksheet.set_column(8, 8, 12)  # KDV TUTARI

        for col, h in enumerate(headers):
            worksheet.write(header_row, col, h, header_fmt)

        # --- VERİ YAZMA ---
        current_row = header_row + 1
        start_data_row = current_row + 1

        summary_data = {}

        for i, row in enumerate(rows):
            try:
                total = float(str(row.get('total_amount', 0)).replace(',', '.'))
                matrah = float(str(row.get('matrah', 0)).replace(',', '.'))
                kdv_amt = float(str(row.get('kdv_amount', 0)).replace(',', '.'))
                rate_str = str(row.get('kdv_rate', '0')).replace('%', '').strip()
                rate = int(float(rate_str)) if rate_str else 0
            except:
                total, matrah, kdv_amt, rate = 0, 0, 0, 0

            raw_masraf = str(row.get('masraf_turu', 'GENEL')).upper().strip()
            masraf_with_kdv = f"{raw_masraf}{rate}"
            
            # Özet Veri Toplama
            if masraf_with_kdv not in summary_data:
                summary_data[masraf_with_kdv] = {'matrah': 0, 'kdv': 0, 'rate': rate, 'display_name': raw_masraf}
            summary_data[masraf_with_kdv]['matrah'] += matrah
            summary_data[masraf_with_kdv]['kdv'] += kdv_amt

            worksheet.write(current_row, 0, i + 1, cell_center_fmt)
            worksheet.write(current_row, 1, row.get('date', ''), cell_center_fmt)
            worksheet.write(current_row, 2, row.get('receipt_no', ''), cell_center_fmt)
            worksheet.write(current_row, 3, row.get('store_name', ''), cell_fmt)
            worksheet.write(current_row, 4, masraf_with_kdv, cell_center_fmt)
            worksheet.write(current_row, 5, total, money_fmt)
            worksheet.write(current_row, 6, matrah, money_fmt)
            worksheet.write(current_row, 7, f"{rate}%", cell_center_fmt)
            worksheet.write(current_row, 8, kdv_amt, money_fmt)
            current_row += 1

        # --- ALT TOPLAM SATIRI ---
        worksheet.write(current_row, 4, "TOPLAM", total_label_fmt)
        worksheet.write_formula(current_row, 5, f'=SUM(F{start_data_row}:F{current_row})', total_fmt)
        worksheet.write_formula(current_row, 6, f'=SUM(G{start_data_row}:G{current_row})', total_fmt)
        worksheet.write(current_row, 7, "", cell_fmt)
        worksheet.write_formula(current_row, 8, f'=SUM(I{start_data_row}:I{current_row})', total_fmt)

        # --- ÖZET TABLO (Kategorilere Göre) ---
        summary_start = current_row + 3
        s_headers = ["Masraf Türü", "Toplam MATRAH", "Ortalama KDV ORANI", "Toplam KDV TUTARI"]
        
        # Ozet tablo basliklari gri
        for col, h in enumerate(s_headers):
            worksheet.write(summary_start, col, h, header_gray_fmt)
        
        s_row = summary_start + 1
        
        # Sort by Name
        sorted_keys = sorted(summary_data.keys(), key=lambda x: summary_data[x]['display_name'])
        
        for k in sorted_keys:
            val = summary_data[k]
            # Görselde Masraf Turu kolonunda orn. "YEMEK 1", "YEMEK 10", "TAMİR", "HIRDAVAT" goruluyor.
            # Biz de tam isimleri oranlarla yansitiyoruz.
            disp = f"{val['display_name']} {val['rate']}" if val['rate'] > 0 else val['display_name']
            
            worksheet.write(s_row, 0, disp, cell_fmt)
            worksheet.write(s_row, 1, val['matrah'], money_fmt)
            worksheet.write(s_row, 2, f"{val['rate']}%", cell_center_fmt)
            worksheet.write(s_row, 3, val['kdv'], money_fmt)
            s_row += 1
        
        # Bos Satir
        worksheet.write(s_row, 0, "(boş)", cell_fmt)
        worksheet.write(s_row, 1, 0, money_fmt)
        worksheet.write(s_row, 2, "20%", cell_center_fmt)
        worksheet.write(s_row, 3, 0, money_fmt)
        s_row += 1

        # Özet Tablo Genel Toplam
        worksheet.write(s_row, 0, "Genel Toplam", header_fmt)
        worksheet.write_formula(s_row, 1, f'=SUM(B{summary_start+2}:B{s_row})', total_fmt)
        worksheet.write(s_row, 2, "15%", header_fmt) # Görselde 15% yazılmış
        worksheet.write_formula(s_row, 3, f'=SUM(D{summary_start+2}:D{s_row})', total_fmt)

        workbook.close()
        output.seek(0)
        encoded_file = base64.b64encode(output.read()).decode('utf-8')

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            "body": json.dumps({
                "file": encoded_file,
                "filename": f"Slip_Raporu_{datetime.datetime.now().strftime('%Y%m%d')}.xlsx"
            })
        }

    except Exception as e:
        import traceback
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e), "trace": traceback.format_exc()})
        }
