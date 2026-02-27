import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import axios from 'axios';
import multer from 'multer';

// Set the path to the ffmpeg static binary
ffmpeg.setFfmpegPath(ffmpegStatic);

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Supabase Configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://yffwujipdmkysltvqjft.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'sb_publishable_7V5AHsyId4rWO4AetrcmWg_yu1ZN_5b';

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

// Configure multer for handling file uploads in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit for audio files
});

// Endpoint to upload user's custom audio track to Supabase Storage
app.post('/api/upload-audio', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No audio file provided' });
        }

        const fileBuffer = req.file.buffer;
        const originalName = req.file.originalname;
        const ext = path.extname(originalName) || '.mp3';
        const uniqueFilename = `${uuidv4()}${ext}`;
        const contentType = req.file.mimetype || 'audio/mpeg';

        // Upload to Supabase Storage bucket 'audio-uploads'
        const uploadUrl = `${supabaseUrl}/storage/v1/object/audio-uploads/${uniqueFilename}`;

        const supabaseResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${supabaseKey}`,
                'apikey': supabaseKey,
                'Content-Type': contentType
            },
            body: fileBuffer
        });

        if (!supabaseResponse.ok) {
            const errorText = await supabaseResponse.text();
            throw new Error(`Supabase upload failed: ${supabaseResponse.status} ${errorText}`);
        }

        // Get public URL
        const publicUrl = `${supabaseUrl}/storage/v1/object/public/audio-uploads/${uniqueFilename}`;

        res.json({ url: publicUrl });
    } catch (error) {
        console.error('Error uploading audio:', error);
        res.status(500).json({ error: 'Failed to upload audio to storage' });
    }
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
        const systemPrompt = `Ты профессиональный сонграйтер-копирайтер. Твоя задача — написать текст короткого ритмичного поздравления (2 четверостишия).
Адресат: ${name}. Повод: ${occasion}.
Смысл/информация от заказчика: "${prompt}".
ВАЖНО: Текст должен читаться как рэп или ритмичная поэзия в стиле: ${mood}.
Используй ЖЕСТКУЮ РИФМУ (ААББ или АБАБ) и очень четкий РИТМ.
РАССТАВЛЯЙ ПУНКТУАЦИЮ (запятые, тире, многоточия), чтобы диктору было понятно, где делать музыкальные паузы и акценты.
Никаких лишних слов, только текст хита.`;

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

app.get('/api/speech', async (req, res) => {
    try {
        const text = req.query.text;
        const voiceId = req.query.voice || 'EXAVITQu4vr4xnSDxMaL'; // Default ElevenLabs voice Bella

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const response = await axios({
            method: 'post',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            headers: {
                'Accept': 'audio/mpeg',
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.35, // Lower stability = more expressive/emotional
                    similarity_boost: 0.8
                }
            },
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(buffer);
    } catch (error) {
        console.error('Error generating speech (GET):', error);
        res.status(500).json({ error: 'Failed to generate speech' });
    }
});

app.post('/api/speech', async (req, res) => {
    try {
        const { text, voice = 'EXAVITQu4vr4xnSDxMaL' } = req.body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const response = await axios({
            method: 'post',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
            headers: {
                'Accept': 'audio/mpeg',
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.35,
                    similarity_boost: 0.8
                }
            },
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.send(buffer);
    } catch (error) {
        console.error('Error generating speech:', error);
        res.status(500).json({ error: 'Failed to generate speech' });
    }
});

app.post('/api/mix-audio', async (req, res) => {
    try {
        const { text, voice = 'EXAVITQu4vr4xnSDxMaL', bgUrl } = req.body;

        if (!text || !bgUrl) {
            return res.status(400).json({ error: 'Text and bgUrl are required' });
        }

        console.log(`Starting mix for voice ${voice} and bgUrl: ${bgUrl.substring(0, 50)}...`);

        // 1. Generate Voice TTS Buffer from ElevenLabs
        const response = await axios({
            method: 'post',
            url: `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
            headers: {
                'Accept': 'audio/mpeg',
                'xi-api-key': process.env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
            },
            data: {
                text: text,
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.35,
                    similarity_boost: 0.8
                }
            },
            responseType: 'arraybuffer'
        });
        const voiceBuffer = Buffer.from(response.data);

        // We need temporary files since ffmpeg works best with files
        const tmpDir = '/tmp'; // Render has a /tmp directory we can use
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        const uniqueId = uuidv4();
        const voicePath = path.join(tmpDir, `${uniqueId}_voice.mp3`);
        const bgPath = path.join(tmpDir, `${uniqueId}_bg.mp3`);
        const outPath = path.join(tmpDir, `${uniqueId}_mixed.mp3`);

        // Save voice buffer to disk
        fs.writeFileSync(voicePath, voiceBuffer);

        // 2. Download Background Audio
        const bgResponse = await axios({
            url: bgUrl,
            method: 'GET',
            responseType: 'stream'
        });

        const bgWriter = fs.createWriteStream(bgPath);
        bgResponse.data.pipe(bgWriter);

        await new Promise((resolve, reject) => {
            bgWriter.on('finish', resolve);
            bgWriter.on('error', reject);
        });

        // 3. Mix them using FFmpeg
        // We duck the background music: volume 1.0 normally, but during voice it's 0.15
        console.log(`Mixing audio files with FFmpeg...`);

        res.setHeader('Content-Type', 'audio/mpeg');
        // If we want a file download, we use Content-Disposition:
        // res.setHeader('Content-Disposition', 'attachment; filename="music-card.mp3"');

        const ffmpegCommand = ffmpeg()
            .input(bgPath)
            .input(voicePath)
            .complexFilter([
                // [0:a] is background, [1:a] is voice
                // Reduce background volume significantly so the voice is clear.
                // Adelay delays the voice track by 1 second (1000ms) so the beat kicks in first.
                // amix halves total volume for 2 inputs, so we multiply by 2.0 at the end [mixed]volume=2.0
                "[0:a]volume=0.2[bg]; [1:a]volume=1.5,adelay=1000|1000[v]; [bg][v]amix=inputs=2:duration=first:dropout_transition=2[mixed]; [mixed]volume=2.0"
            ])
            .outputOptions('-ac 2') // stereo
            .format('mp3')
            .on('end', () => {
                console.log('FFmpeg processing finished.');
                // Cleanup temp files
                try {
                    fs.unlinkSync(voicePath);
                    fs.unlinkSync(bgPath);
                    fs.unlinkSync(outPath);
                } catch (e) { }
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                if (!res.headersSent) res.status(500).json({ error: 'Error mixing audio' });

                // Cleanup
                try {
                    fs.unlinkSync(voicePath);
                    fs.unlinkSync(bgPath);
                } catch (e) { }
            });

        // Instead of writing to a file, pipe directly to the response
        ffmpegCommand.pipe(res, { end: true });

    } catch (error) {
        console.error('Error in mix-audio:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to process audio mixture' });
    }
});

// Save a card and get a short ID
app.post('/api/cards', async (req, res) => {
    try {
        const cardData = req.body;
        const id = uuidv4().substring(0, 8); // 8-char short ID

        // Insert into Supabase
        const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/cards`, {
            method: 'POST',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
                id: id,
                name: cardData.name,
                occasion: cardData.occasion,
                lyrics: cardData.lyrics,
                audio_url: cardData.audioUrl,
                melody_text: cardData.melodyText
            })
        });

        if (!supabaseResponse.ok) {
            const errorText = await supabaseResponse.text();
            throw new Error(`Supabase error saving card: ${supabaseResponse.status} ${errorText}`);
        }

        res.json({ id });
    } catch (error) {
        console.error('Error saving card:', error);
        res.status(500).json({ error: 'Failed to save card' });
    }
});

// Retrieve a card by ID
app.get('/api/cards/:id', async (req, res) => {
    try {
        const id = req.params.id;

        const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/cards?id=eq.${id}&select=*`, {
            method: 'GET',
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });

        if (!supabaseResponse.ok) {
            throw new Error(`Supabase error retrieving card: ${supabaseResponse.status}`);
        }

        const data = await supabaseResponse.json();

        if (data && data.length > 0) {
            const row = data[0];
            res.json({
                name: row.name,
                occasion: row.occasion,
                lyrics: row.lyrics,
                audioUrl: row.audio_url,
                melodyText: row.melody_text
            });
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
