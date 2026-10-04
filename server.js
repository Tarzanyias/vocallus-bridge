import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import WebSocket from 'ws';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE = process.env.GEMINI_VOICE || 'Aoede';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  'You are Solana, a friendly AI receptionist answering a business phone line. ' +
  'Speak naturally and warmly, like a real person on the phone. Keep every reply to one or two short sentences. ' +
  'Find out the caller\'s name, why they are calling, and a good callback number. ' +
  'If you cannot help with something, offer to take a message for the team.';

const GEMINI_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';

const app = Fastify({ logger: true });
await app.register(formbody);
await app.register(fastifyWebsocket);

/* ---------------- audio conversion ---------------- */

// mu-law byte -> 16-bit PCM sample
function ulawToPcm(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -sample : sample;
}

// 16-bit PCM sample -> mu-law byte
function pcmToUlaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Twilio base64 mu-law 8kHz -> base64 PCM16 16kHz (for Gemini)
function twilioToGemini(b64) {
  const ulaw = Buffer.from(b64, 'base64');
  const out = Buffer.alloc(ulaw.length * 4); // 2x samples, 2 bytes each
  for (let i = 0; i < ulaw.length; i++) {
    const s = ulawToPcm(ulaw[i]);
    const next = i + 1 < ulaw.length ? ulawToPcm(ulaw[i + 1]) : s;
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE((s + next) >> 1, i * 4 + 2);
  }
  return out.toString('base64');
}

// Gemini base64 PCM16 24kHz -> base64 mu-law 8kHz (for Twilio)
function geminiToTwilio(b64) {
  const pcm = Buffer.from(b64, 'base64');
  const samples = Math.floor(pcm.length / 2);
  const outLen = Math.floor(samples / 3);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = pcm.readInt16LE(i * 6);
    const b = pcm.readInt16LE(i * 6 + 2);
    const c = pcm.readInt16LE(i * 6 + 4);
    out[i] = pcmToUlaw(Math.round((a + b + c) / 3));
  }
  return out.toString('base64');
}

/* ---------------- HTTP routes ---------------- */

app.get('/health', async () => ({
  status: 'ok',
  service: 'vocallus-bridge',
  ai: GEMINI_API_KEY ? 'gemini key set' : 'MISSING GEMINI_API_KEY',
  model: MODEL,
  time: new Date().toISOString()
}));

app.get('/', async () => ({
  message: 'Vocallus bridge is running',
  endpoints: ['/health', '/incoming-call', '/media-stream']
}));

app.post('/incoming-call', async (req, reply) => {
  const host = req.headers.host;
  const to = (req.body && req.body.To) || 'unknown';
  const from = (req.body && req.body.From) || 'unknown';
  app.log.info(`Incoming call to ${to} from ${from}`);

  reply.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Connect>' +
        `<Stream url="wss://${host}/media-stream">` +
          `<Parameter name="to" value="${to}" />` +
          `<Parameter name="from" value="${from}" />` +
        '</Stream>' +
      '</Connect>' +
    '</Response>'
  );
});

/* ---------------- the bridge ---------------- */

app.get('/media-stream', { websocket: true }, (twilio, req) => {
  app.log.info('Twilio connected');

  if (!GEMINI_API_KEY) {
    app.log.error('GEMINI_API_KEY is not set in Railway Variables');
    twilio.close();
    return;
  }

  let streamSid = null;
  let geminiReady = false;
  const pendingAudio = [];

  const gemini = new WebSocket(GEMINI_URL + encodeURIComponent(GEMINI_API_KEY));

  gemini.on('open', () => {
    app.log.info(`Gemini connected (model ${MODEL})`);
    gemini.send(JSON.stringify({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } }
        },
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
      }
    }));
  });

  gemini.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.setupComplete) {
      geminiReady = true;
      app.log.info('Gemini session ready - sending greeting');
      // Make Solana speak first.
      gemini.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: 'A caller just connected. Greet them warmly and ask how you can help.' }] }],
          turnComplete: true
        }
      }));
      while (pendingAudio.length) gemini.send(pendingAudio.shift());
      return;
    }

    const sc = msg.serverContent;
    if (!sc) {
      if (msg.error) app.log.error(`Gemini error: ${JSON.stringify(msg.error)}`);
      return;
    }

    // Caller talked over Solana -> stop playing her current sentence.
    if (sc.interrupted && streamSid) {
      twilio.send(JSON.stringify({ event: 'clear', streamSid }));
    }

    const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data && streamSid) {
        twilio.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: geminiToTwilio(p.inlineData.data) }
        }));
      }
    }
  });

  gemini.on('close', (code, reason) => {
    app.log.info(`Gemini closed: ${code} ${reason ? reason.toString() : ''}`);
    try { twilio.close(); } catch {}
  });

  gemini.on('error', (err) => app.log.error(`Gemini socket error: ${err.message}`));

  twilio.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      const p = msg.start.customParameters || {};
      app.log.info(`Call stream started ${streamSid} (to ${p.to}, from ${p.from})`);
    } else if (msg.event === 'media') {
      const frame = JSON.stringify({
        realtimeInput: {
          audio: { data: twilioToGemini(msg.media.payload), mimeType: 'audio/pcm;rate=16000' }
        }
      });
      if (geminiReady && gemini.readyState === WebSocket.OPEN) gemini.send(frame);
      else if (pendingAudio.length < 100) pendingAudio.push(frame);
    } else if (msg.event === 'stop') {
      app.log.info('Call ended');
      try { gemini.close(); } catch {}
    }
  });

  twilio.on('close', () => {
    try { gemini.close(); } catch {}
  });
});

const port = process.env.PORT || 8080;
await app.listen({ port, host: '0.0.0.0' });
