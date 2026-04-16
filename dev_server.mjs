import express from 'express';
import cors from 'cors';
import { handler as processImageHandler } from './netlify/functions/process_image.mjs';
import { handler as saveExcelHandler } from './netlify/functions/save_excel.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve Static Files
app.use(express.static('.'));

// Netlify Functions Mock for Local Development
app.post('/api/process_image', async (req, res) => {
  try {
    const event = { httpMethod: 'POST', body: JSON.stringify(req.body) };
    const result = await processImageHandler(event);
    res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (err) {
    console.error('CRITICAL SERVER ERROR:', err);
    res.status(500).send({ error: 'Internal Server Error', details: err.message });
  }
});

app.post('/api/save_excel', async (req, res) => {
  try {
    const event = { httpMethod: 'POST', body: JSON.stringify(req.body) };
    const result = await saveExcelHandler(event);
    res.status(result.statusCode).set(result.headers).send(result.body);
  } catch (err) {
    console.error('CRITICAL SERVER ERROR:', err);
    res.status(500).send({ error: 'Internal Server Error', details: err.message });
  }
});

const PORT = 5005;
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`SlipX NODE.JS DEV SERVER`);
  console.log(`Sunucu: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
