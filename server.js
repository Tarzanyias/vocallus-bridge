import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import WebSocket from 'ws';
import admin from 'firebase-admin';

const DEFAULT_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE = process.env.GEMINI_VOICE || 'Aoede';
const DEFAULT_TZ = 'America/Chicago';
const DEFAULT_PROMPT = process.env.SYSTEM_PROMPT ||
  'You are Solana, a friendly AI receptionist answering a business phone line. ' +
  'Speak naturally and warmly. Keep every reply to one or two short sentences. ' +
  'Find out the caller\'s name and why they are calling. ' +
  'If you cannot help with something, offer to take a message for the team.';
const DEFAULT_HOURS = {
  mon: { open: '09:00', close: '17:00', closed: false },
  tue: { open: '09:00', close: '17:00', closed: false },
  wed: { open: '09:00', close: '17:00', closed: false },
  thu: { open: '09:00', close: '17:00', closed: false },
  fri: { open: '09:00', close: '17:00', closed: false },
  sat: { open: '09:00', close: '17:00', closed: true },
  sun: { open: '09:00', close: '17:00', closed: true }
};
const GEMINI_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';

const app = Fastify({ logger: true });
await app.register(formbody);
await app.register(fastifyWebsocket);

/* ---------------- Firebase ---------------- */

let db = null;
try {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  app.log.info('Firebase connected');
} catch (e) {
  app.log.error('Firebase NOT configured: ' + e.message);
}

async function findTenant(phone) {
  if (!db || !phone) return null;
  const snap = await db.collection('users').where('phoneNumber', '==', phone).limit(1).get();
  if (snap.empty) return null;
  return { uid: snap.docs[0].id, ...snap.docs[0].data() };
}

async function loadConfig(uid) {
  if (!uid || !db) {
    return { uid: null, prompt: DEFAULT_PROMPT, key: DEFAULT_KEY, agentName: 'Solana',
             tz: DEFAULT_TZ, hours: DEFAULT_HOURS, len: 30, business: '' };
  }
  const u = (await db.doc(`users/${uid}`).get()).data() || {};
  let key = DEFAULT_KEY;                       // Max plan: your key
  if (u.plan === 'pro') {                      // Pro plan: their own key
    const ai = (await db.doc(`users/${uid}/private/ai`).get()).data() || {};
    key = ai.apiKey || null;
  }
  return {
    uid,
    plan: u.plan,
    prompt: u.systemPrompt || DEFAULT_PROMPT,
    agentName: u.agentName || 'Solana',
    key,
    tz: u.timezone || DEFAULT_TZ,
    hours: u.hours || DEFAULT_HOURS,
    len: Number(u.appointmentLength) || 30,
    business: u.company || ''
  };
}

/* ---------------- time helpers ---------------- */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  return Object.fromEntries(f.formatToParts(date).map(p => [p.type, p.value]));
}

// "2026-10-06" + "14:30" in America/Chicago -> real Date
function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = tzParts(new Date(guess), tz);
  const seen = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute);
  return new Date(guess - (seen - guess));
}

function dayKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
function to12(t) {
  let [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
function normTime(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
}
function todayText(tz) {
  const now = new Date();
  const p = tzParts(now, tz);
  const pretty = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return `${pretty} (${p.year}-${p.month}-${p.day})`;
}

/* ---------------- calendar ---------------- */

async function freeSlots(cfg, dateStr) {
  const h = cfg.hours[dayKey(dateStr)];
  if (!h || h.closed) return { closed: true, slots: [] };

  const from = zonedToUtc(dateStr, '00:00', cfg.tz);
  const to = new Date(zonedToUtc(dateStr, '23:59', cfg.tz).getTime() + 60000);
  const snap = await db.collection(`users/${cfg.uid}/appointments`)
    .where('start', '>=', from).where('start', '<', to).get();
  const busy = snap.docs.map(doc => {
    const a = doc.data();
    const s = a.start.toDate().getTime();
    const e = a.end ? a.end.toDate().getTime() : s + cfg.len * 60000;
    return [s, e];
  });

  const now = Date.now();
  const slots = [];
  for (let t = toMin(h.open); t + cfg.len <= toMin(h.close); t += cfg.len) {
    const s = zonedToUtc(dateStr, fromMin(t), cfg.tz).getTime();
    const e = s + cfg.len * 60000;
    if (s < now) continue;
    if (busy.some(([bs, be]) => s < be && e > bs)) continue;
    slots.push(fromMin(t));
  }
  return { closed: false, slots };
}

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'check_availability',
      description: 'Get the open appointment times on a specific date. Always call this before offering times.',
      parameters: {
        type: 'OBJECT',
        properties: { date: { type: 'STRING', description: 'Date as YYYY-MM-DD' } },
        required: ['date']
      }
    },
    {
      name: 'book_appointment',
      description: 'Book an appointment. Only call this after the caller has confirmed the exact date and time.',
      parameters: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', description: 'Date as YYYY-MM-DD' },
          time: { type: 'STRING', description: '24-hour time HH:MM, for example 14:30' },
          customer_name: { type: 'STRING' },
          customer_phone: { type: 'STRING', description: 'Callback number if the caller gives a different one' },
          reason: { type: 'STRING', description: 'Short reason for the visit' }
        },
        required: ['date', 'time', 'customer_name']
      }
    }
  ]
}];

async function runTool(cfg, name, args, callerPhone) {
  try {
    if (name === 'check_availability') {
      const r = await freeSlots(cfg, args.date);
      if (r.closed) return { date: args.date, open: false, message: 'The business is closed that day.' };
      if (!r.slots.length) return { date: args.date, open: true, available_times: [], message: 'Fully booked that day.' };
      return { date: args.date, open: true, available_times: r.slots.slice(0, 16).map(to12) };
    }
    if (name === 'book_appointment') {
      const time = normTime(args.time);
      const r = await freeSlots(cfg, args.date);
      if (r.closed || !r.slots.includes(time)) {
        return { booked: false, reason: 'That time is not available.', other_times: r.slots.slice(0, 8).map(to12) };
      }
      const start = zonedToUtc(args.date, time, cfg.tz);
      const end = new Date(start.getTime() + cfg.len * 60000);
      await db.collection(`users/${cfg.uid}/appointments`).add({
        title: args.reason || 'Appointment',
        customerName: args.customer_name || '',
        customerPhone: args.customer_phone || callerPhone || '',
        start: admin.firestore.Timestamp.fromDate(start),
        end: admin.firestore.Timestamp.fromDate(end),
        notes: args.reason || '',
        source: 'ai',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      app.log.info(`Booked ${args.date} ${time} for ${args.customer_name} (user ${cfg.uid})`);
      return { booked: true, date: args.date, time: to12(time) };
    }
    return { error: 'Unknown tool' };
  } catch (e) {
    app.log.error(`Tool ${name} failed: ${e.message}`);
    return { error: 'Calendar is unavailable right now. Offer to take a message instead.' };
  }
}

/* ---------------- audio conversion ---------------- */

function ulawToPcm(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -sample : sample;
}
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
function twilioToGemini(b64) {
  const ulaw = Buffer.from(b64, 'base64');
  const out = Buffer.alloc(ulaw.length * 4);
  for (let i = 0; i < ulaw.length; i++) {
    const s = ulawToPcm(ulaw[i]);
    const next = i + 1 < ulaw.length ? ulawToPcm(ulaw[i + 1]) : s;
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE((s + next) >> 1, i * 4 + 2);
  }
  return out.toString('base64');
}
function geminiToTwilio(b64) {
  const pcm = Buffer.from(b64, 'base64');
  const outLen = Math.floor(pcm.length / 6);
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = pcm.readInt16LE(i * 6), b = pcm.readInt16LE(i * 6 + 2), c = pcm.readInt16LE(i * 6 + 4);
    out[i] = pcmToUlaw(Math.round((a + b + c) / 3));
  }
  return out.toString('base64');
}

/* ---------------- HTTP routes ---------------- */

const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function sayAndHang(reply, text) {
  reply.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(text)}</Say><Hangup/></Response>`
  );
}

app.get('/health', async () => ({
  status: 'ok',
  service: 'vocallus-bridge',
  ai: DEFAULT_KEY ? 'gemini key set' : 'MISSING GEMINI_API_KEY',
  firebase: db ? 'connected' : 'NOT CONNECTED',
  model: MODEL,
  time: new Date().toISOString()
}));

app.get('/', async () => ({ message: 'Vocallus bridge is running' }));

app.post('/incoming-call', async (req, reply) => {
  const host = req.headers.host;
  const to = (req.body && req.body.To) || '';
  const from = (req.body && req.body.From) || '';
  app.log.info(`Incoming call to ${to} from ${from}`);

  let uid = '';
  try {
    const tenant = await findTenant(to);
    if (tenant) {
      if (!['pro', 'max'].includes(tenant.plan)) {
        return sayAndHang(reply, 'Sorry, this line is not active yet. Goodbye.');
      }
      const cfg = await loadConfig(tenant.uid);
      if (!cfg.key) {
        return sayAndHang(reply, 'Sorry, this line is not finished being set up. Please try again later.');
      }
      uid = tenant.uid;
    }
  } catch (e) {
    app.log.error('Tenant lookup failed: ' + e.message);
  }

  reply.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?><Response><Connect>' +
    `<Stream url="wss://${host}/media-stream">` +
    `<Parameter name="uid" value="${xml(uid)}" />` +
    `<Parameter name="from" value="${xml(from)}" />` +
    '</Stream></Connect></Response>'
  );
});

/* ---------------- the bridge ---------------- */

app.get('/media-stream', { websocket: true }, (twilio) => {
  let streamSid = null, gemini = null, geminiReady = false;
  let cfg = null, from = '', callRef = null, startedAt = Date.now();
  const pending = [];

  function openGemini() {
    gemini = new WebSocket(GEMINI_URL + encodeURIComponent(cfg.key));

    gemini.on('open', () => {
      let system = cfg.prompt +
        `\n\nYour name is ${cfg.agentName}.` +
        (cfg.business ? ` You answer the phone for ${cfg.business}.` : '') +
        ` Today is ${todayText(cfg.tz)}. The caller's number is ${from || 'unknown'}.` +
        ' Speak like a real person on the phone and keep replies short.';
      if (cfg.uid) {
        system += ' To book: ask what day they want, call check_availability for that date, offer a few of the returned times,' +
          ' get their name, confirm the date and time back to them, then call book_appointment. Never invent open times.' +
          ' Say times in 12-hour format like 2:30 PM.';
      }
      const setup = {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } }
        },
        systemInstruction: { parts: [{ text: system }] }
      };
      if (cfg.uid) setup.tools = TOOLS;
      gemini.send(JSON.stringify({ setup }));
    });

    gemini.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.setupComplete) {
        geminiReady = true;
        gemini.send(JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text: 'A caller just connected. Greet them warmly and ask how you can help.' }] }],
            turnComplete: true
          }
        }));
        while (pending.length) gemini.send(pending.shift());
        return;
      }

      if (msg.toolCall) {
        const calls = msg.toolCall.functionCalls || [];
        const functionResponses = await Promise.all(calls.map(async c => ({
          id: c.id, name: c.name, response: await runTool(cfg, c.name, c.args || {}, from)
        })));
        if (gemini.readyState === WebSocket.OPEN) {
          gemini.send(JSON.stringify({ toolResponse: { functionResponses } }));
        }
        return;
      }

      const sc = msg.serverContent;
      if (!sc) {
        if (msg.error) app.log.error('Gemini error: ' + JSON.stringify(msg.error));
        return;
      }
      if (sc.interrupted && streamSid) twilio.send(JSON.stringify({ event: 'clear', streamSid }));
      for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
        if (p.inlineData && p.inlineData.data && streamSid) {
          twilio.send(JSON.stringify({ event: 'media', streamSid, media: { payload: geminiToTwilio(p.inlineData.data) } }));
        }
      }
    });

    gemini.on('close', (code, reason) => {
      app.log.info(`Gemini closed: ${code} ${reason ? reason.toString() : ''}`);
      try { twilio.close(); } catch {}
    });
    gemini.on('error', (err) => app.log.error('Gemini socket error: ' + err.message));
  }

  twilio.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      const p = msg.start.customParameters || {};
      from = p.from || '';
      try { cfg = await loadConfig(p.uid || null); }
      catch (e) { app.log.error('Config load failed: ' + e.message); cfg = await loadConfig(null); }
      if (!cfg.key) { app.log.error('No AI key for this call'); try { twilio.close(); } catch {} return; }
      app.log.info(`Call started for ${cfg.uid || 'default line'} from ${from}`);
      if (cfg.uid && db) {
        try {
          callRef = await db.collection(`users/${cfg.uid}/calls`).add({
            from, startedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'in-progress'
          });
        } catch (e) { app.log.error('Call log failed: ' + e.message); }
      }
      openGemini();
    } else if (msg.event === 'media') {
      const frame = JSON.stringify({
        realtimeInput: { audio: { data: twilioToGemini(msg.media.payload), mimeType: 'audio/pcm;rate=16000' } }
      });
      if (geminiReady && gemini && gemini.readyState === WebSocket.OPEN) gemini.send(frame);
      else if (pending.length < 100) pending.push(frame);
    } else if (msg.event === 'stop') {
      try { gemini && gemini.close(); } catch {}
    }
  });

  twilio.on('close', async () => {
    try { gemini && gemini.close(); } catch {}
    if (callRef) {
      try {
        await callRef.update({
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          durationSec: Math.round((Date.now() - startedAt) / 1000),
          status: 'completed'
        });
      } catch {}
    }
  });
});

const port = process.env.PORT || 8080;
await app.listen({ port, host: '0.0.0.0' });
