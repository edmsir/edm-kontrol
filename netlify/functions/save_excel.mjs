import ExcelJS from 'exceljs';

/**
 * Netlify Function: save_excel
 * Frontend Beklentisi: { rows: [...], unvan: "..." }
 * Yanıt Beklentisi: { file: "base64", filename: "..." }
 */
export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const results = data.rows || []; // Frontend 'rows' gönderiyor
    const unvan = data.unvan || "BEY KUMAŞÇILIK";

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Gider Raporu');

    // Kolon Genişlikleri
    sheet.columns = [
      { header: 'MAĞAZA ADI', key: 'store', width: 25 },
      { header: 'TARİH', key: 'date', width: 15 },
      { header: 'KDV %', key: 'rate', width: 10 },
      { header: 'MATRAH', key: 'matrah', width: 15 },
      { header: 'KDV TUTARI', key: 'kdvAmt', width: 15 },
      { header: 'TOPLAM TUTAR', key: 'total', width: 15 }
    ];

    // Üst Başlık (Şirket Unvanı)
    sheet.insertRow(1, [unvan.toUpperCase()]);
    sheet.mergeCells('A1:F1');
    sheet.getRow(1).getCell(1).font = { bold: true, size: 14 };
    sheet.getRow(1).getCell(1).alignment = { horizontal: 'center' };

    // Tablo Başlık Stili
    const headerRow = sheet.getRow(2);
    headerRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF6600' } };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      cell.alignment = { horizontal: 'center' };
    });

    // Verileri Ekle
    results.forEach((item) => {
      const row = sheet.addRow({
        store: item.store_name?.toUpperCase() || '',
        date: item.date || '',
        rate: item.kdv_rate ? `%${item.kdv_rate}` : '',
        matrah: parseFloat(item.matrah) || 0,
        kdvAmt: parseFloat(item.kdv_amount) || 0,
        total: parseFloat(item.total_amount) || 0
      });

      row.eachCell((cell, colNumber) => {
        if (colNumber >= 4) {
          cell.numFmt = '#,##0.00 "₺"';
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const base64File = buffer.toString('base64');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file: base64File,
        filename: `Gider_Raporu_${new Date().toISOString().split('T')[0]}.xlsx`
      })
    };

  } catch (error) {
    console.error('Excel Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
