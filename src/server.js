import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = Number(process.env.PORT || 3001);
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const liveModel = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: '128kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true }));

const getClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY is not configured on the server.');
    error.status = 503;
    throw error;
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
};

const cleanHistory = (history) => {
  if (!Array.isArray(history)) return [];
  return history
    .filter((message) => message && ['user', 'model'].includes(message.role) && typeof message.text === 'string')
    .slice(-20)
    .map(({ role, text }) => ({ role, parts: [{ text: text.slice(0, 12_000) }] }));
};

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, model, liveModel });
});

app.post('/api/live-token', async (_request, response) => {
  try {
    const ai = getClient();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: liveModel,
          config: {
            responseModalities: ['AUDIO'],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            sessionResumption: {},
            systemInstruction: {
              parts: [{ text: 'You are Nova, a warm and concise voice assistant. Speak naturally and helpfully.' }],
            },
          },
        },
      },
    });
    return response.json({ token: token.name, model: liveModel });
  } catch (error) {
    const status = error.status || error.statusCode;
    const messageText = String(error.message || '');
    if (status === 429 || /quota|rate limit/i.test(messageText)) {
      return response.status(429).json({ error: 'Live API quota or rate limit reached.' });
    }
    if (/api key|authentication|permission|unauthorized/i.test(messageText)) {
      return response.status(502).json({ error: 'The Gemini API key cannot create Live API sessions.' });
    }
    console.error('Live token request failed:', status || 'unknown status');
    return response.status(503).json({ error: 'Live calling is unavailable for this Gemini project or model.' });
  }
});

app.post('/api/chat', async (request, response) => {
  const { message, history } = request.body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    return response.status(400).json({ error: 'A non-empty message is required.' });
  }
  if (message.length > 12_000) {
    return response.status(413).json({ error: 'Message is too long. Please keep it under 12,000 characters.' });
  }

  try {
    const ai = getClient();
    const result = await ai.models.generateContent({
      model,
      contents: [...cleanHistory(history), { role: 'user', parts: [{ text: message.trim() }] }],
      config: {
        systemInstruction: 'You are Nova, a helpful, concise AI assistant. Use Markdown when it improves readability. Never claim to have performed actions you cannot perform.',
      },
    });
    const text = result.text?.trim();
    if (!text) {
      return response.status(502).json({ error: 'Gemini returned an empty response. Please try again.' });
    }
    return response.json({ text, model });
  } catch (error) {
    const status = error.status || error.statusCode;
    const messageText = String(error.message || '');
    if (status === 429 || /quota|rate limit/i.test(messageText)) {
      return response.status(429).json({ error: 'Gemini quota or rate limit reached. Please wait and try again.' });
    }
    if (/api key|authentication|permission|unauthorized/i.test(messageText)) {
      return response.status(502).json({ error: 'The Gemini API key was rejected. Check the server .env configuration.' });
    }
    console.error('Gemini request failed:', status || 'unknown status');
    return response.status(500).json({ error: 'The assistant could not respond right now. Please try again.' });
  }
});

app.listen(port, () => {
  console.log(`Nova API listening on http://localhost:${port}`);
});
