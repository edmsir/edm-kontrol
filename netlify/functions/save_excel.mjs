import ExcelJS from 'exceljs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const results = data.rows || [];
    const unvan = data.unvan || "BEY KUMAŞÇILIK TEKSTİL SANAYİ VE DIŞ TİCARET LİMİTED ŞİRKETİ";
    const today = new Date().toLocaleDateString('tr-TR');

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Gider Raporu');

    // --- Başlık Bölümü ---
    sheet.mergeCells('A1:F2');
    const companyCell = sheet.getCell('A1');
    companyCell.value = unvan.toUpperCase();
    companyCell.font = { bold: true, size: 11 };
    companyCell.alignment = { vertical: 'middle', horizontal: 'left' };

    sheet.getCell('G1').value = 'Tarih';
    sheet.getCell('G1').font = { bold: true };
    sheet.getCell('H1').value = today;
    sheet.getCell('H1').alignment = { horizontal: 'right' };

    // --- Tablo Başlıkları ---
    const headers = ['SIRA NO', 'TARİH', 'FİŞ NO', 'UNVAN', 'MASRAF TÜRÜ', 'TOPLAM', 'MATRAH', 'KDV ORANI', 'KDV TUTARI'];
    const headerRowIdx = 4;
    const headerRow = sheet.getRow(headerRowIdx);
    headerRow.values = headers;

    // Sütun Genişlikleri
    sheet.columns = [
      { width: 8 }, { width: 12 }, { width: 12 }, { width: 30 }, { width: 20 },
      { width: 15 }, { width: 15 }, { width: 12 }, { width: 15 }
    ];

    // Başlık Stili
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 9 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin' }, left: { style: 'thin' },
        bottom: { style: 'thin' }, right: { style: 'thin' }
      };
    });

    // --- Veri Satırları ---
    let currentRowIdx = 5;
    let totalGross = 0, totalMatrah = 0, totalKdv = 0;

    results.forEach((item, index) => {
      const gross = parseFloat(item.total_amount) || 0;
      const matrah = parseFloat(item.matrah) || 0;
      const kdvAmt = parseFloat(item.kdv_amount) || 0;

      const row = sheet.addRow([
        index + 1,
        item.date || '',
        item.receipt_no || '',
        (item.store_name || '').toUpperCase(),
        (item.masraf_turu || '').toUpperCase(),
        gross,
        matrah,
        item.kdv_rate ? `%${item.kdv_rate}` : '',
        kdvAmt
      ]);

      row.eachCell((cell, colNumber) => {
        cell.font = { size: 9 };
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' }
        };
        // Sayı Formatları (TR formatı için numFmt kullanıyoruz)
        if (colNumber === 6 || colNumber === 7 || colNumber === 9) {
          cell.numFmt = '#,##0.00';
          cell.alignment = { horizontal: 'right' };
        } else {
          cell.alignment = { horizontal: 'center' };
        }
      });

      totalGross += gross;
      totalMatrah += matrah;
      totalKdv += kdvAmt;
      currentRowIdx++;
    });

    // --- Liste Toplam Satırı ---
    const totalRow = sheet.getRow(currentRowIdx);
    totalRow.getCell(5).value = 'TOPLAM';
    totalRow.getCell(5).font = { bold: true };
    totalRow.getCell(5).alignment = { horizontal: 'right' };
    
    totalRow.getCell(6).value = totalGross;
    totalRow.getCell(7).value = totalMatrah;
    totalRow.getCell(9).value = totalKdv;

    [6, 7, 9].forEach(col => {
      const cell = totalRow.getCell(col);
      cell.font = { bold: true, size: 10 };
      cell.numFmt = '#,##0.00';
      cell.border = {
        top: { style: 'medium' }, left: { style: 'thin' },
        bottom: { style: 'medium' }, right: { style: 'thin' }
      };
    });

    // --- Özet Tablo (Masraf Türü Bazlı) ---
    currentRowIdx += 4;
    const summaryHeaderRow = sheet.getRow(currentRowIdx);
    summaryHeaderRow.values = ['Masraf Türü', 'Toplam MATRAH', 'Ortalama KDV ORANI', 'Toplam KDV TUTARI'];
    summaryHeaderRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF999999' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    // Gruplama Mantığı
    const summaryMap = {};
    results.forEach(item => {
      const cat = (item.masraf_turu || 'DİĞER').toUpperCase();
      if (!summaryMap[cat]) summaryMap[cat] = { matrah: 0, kdv: 0, rateSum: 0, count: 0 };
      summaryMap[cat].matrah += parseFloat(item.matrah) || 0;
      summaryMap[cat].kdv += parseFloat(item.kdv_amount) || 0;
      summaryMap[cat].rateSum += parseInt(item.kdv_rate) || 0;
      summaryMap[cat].count += 1;
    });

    currentRowIdx++;
    Object.keys(summaryMap).forEach(cat => {
      const data = summaryMap[cat];
      const row = sheet.addRow([]);
      // sheet.addRow'u boş geçip manuel dolduruyoruz çünkü index karmaşası olmasın
      const r = sheet.getRow(currentRowIdx);
      r.getCell(1).value = cat;
      r.getCell(2).value = data.matrah;
      r.getCell(3).value = `%${(data.rateSum / data.count).toFixed(0)}`;
      r.getCell(4).value = data.kdv;

      r.eachCell((cell, col) => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (col > 1 && col !== 3) cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: col === 1 ? 'left' : 'right' };
      });
      currentRowIdx++;
    });

    // Genel Toplam Satırı (Özet Tablo için)
    const summaryTotalRow = sheet.getRow(currentRowIdx);
    summaryTotalRow.getCell(1).value = 'Genel Toplam';
    summaryTotalRow.getCell(1).font = { bold: true };
    summaryTotalRow.getCell(2).value = totalMatrah;
    summaryTotalRow.getCell(3).value = `%${(results.length > 0 ? results.reduce((a,b)=>a+(parseInt(b.kdv_rate)||0),0)/results.length : 0).toFixed(0)}`;
    summaryTotalRow.getCell(4).value = totalKdv;

    [1, 2, 3, 4].forEach(col => {
      const cell = summaryTotalRow.getCell(col);
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
      cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      if (col === 2 || col === 4) cell.numFmt = '#,##0.00';
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const base64File = buffer.toString('base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: base64File,
        filename: `SlipX_Raporu_${new Date().toISOString().split('T')[0]}.xlsx`
      })
    };

  } catch (error) {
    console.error('Excel Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
