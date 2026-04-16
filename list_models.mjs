import { Groq } from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const key = process.env.GROQ_API_KEYS.split(',')[0].trim();
const groq = new Groq({ apiKey: key });

async function list() {
  try {
    const response = await groq.models.list();
    console.log(JSON.stringify(response.data.map(m => m.id), null, 2));
  } catch (e) {
    console.error(e);
  }
}
list();
