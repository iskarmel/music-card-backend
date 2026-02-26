import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// In-memory database for cards (since Render free tier has a read-only filesystem)
const cardsDb = {};

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST']
}));
app.use(express.json());

// Serve static frontend files from the current directory
app.use(express.static(process.cwd()));

// Explicitly serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'index.html'));
});

app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.get('/api/audio-proxy', (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');

    https.get(targetUrl, (proxyRes) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/mpeg');
        if (proxyRes.headers['content-length']) {
            res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }
        res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges'] || 'bytes');
        res.status(proxyRes.statusCode);
        proxyRes.pipe(res);
    }).on('error', (err) => {
        console.error('Audio proxy error:', err);
        res.status(500).send('Audio proxy error');
    });
});

app.post('/api/generate', async (req, res) => {
    try {
        const { name, occasion, prompt, mood } = req.body;

        // System prompt sets the context for OpenAI
        const systemPrompt = `Ты профессиональный сонграйтер-копирайтер. Твоя задача — написать текст короткой поздравительной песни (2 четверостишия).
Адресат: ${name}. Повод: ${occasion}.
Смысл/информация от заказчика: "${prompt}".
ВАЖНО: Текст должен быть стилизован под артиста/стиль: ${mood}.
Сохрани фирменный слог, ритм и атмосферу этого исполнителя (например, рифмы, сленг или стиль Басты, если выбран он), чтобы текст идеально ложился на подобную музыку.
Без лишних вступлений, только сам текст поздравления.`;

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Use GPT-4o-mini for fast and cheap responses
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: "Напиши поздравление." }
            ],
            temperature: 0.7,
            max_tokens: 150,
        });

        res.json({ lyrics: response.choices[0].message.content.trim() });
    } catch (error) {
        console.error('Error generating lyrics:', error);
        res.status(500).json({ error: 'Failed to generate lyrics' });
    }
});

app.post('/api/speech', async (req, res) => {
    try {
        const { text, voice = 'alloy' } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: voice,
            input: text,
            speed: 0.85,
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(buffer);
    } catch (error) {
        console.error('Error generating speech:', error);
        res.status(500).json({ error: 'Failed to generate speech' });
    }
});

// Save a card and get a short ID
app.post('/api/cards', (req, res) => {
    try {
        const cardData = req.body;
        const id = uuidv4().substring(0, 8); // 8-char short ID

        cardsDb[id] = cardData;

        res.json({ id });
    } catch (error) {
        console.error('Error saving card:', error);
        res.status(500).json({ error: 'Failed to save card' });
    }
});

// Retrieve a card by ID
app.get('/api/cards/:id', (req, res) => {
    try {
        const id = req.params.id;

        if (cardsDb[id]) {
            res.json(cardsDb[id]);
        } else {
            res.status(404).json({ error: 'Card not found' });
        }
    } catch (error) {
        console.error('Error retrieving card:', error);
        res.status(500).json({ error: 'Failed to retrieve card' });
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
