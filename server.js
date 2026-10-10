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
  let key = DEFAULT_KEY, provider = 'gemini';   // Max plan: your Gemini key
  if (u.plan === 'pro') {                         // Pro plan: their own Google or OpenAI key
    const ai = (await db.doc(`users/${uid}/private/ai`).get()).data() || {};
    provider = ai.provider === 'openai' ? 'openai' : 'gemini';
    key = (ai.apiKey && (!ai.provider || ai.provider === 'gemini' || ai.provider === 'openai')) ? ai.apiKey : null;
  }
  return {
    uid,
    provider,
    // VOICE_SET: Pro voices only on paid plans
    voice: ((['pro', 'max'].includes(u.plan) && ['female', 'male'].includes(u.voice)) ||
            (u.plan === 'max' && ['mmale', 'mfmale', 'rmale'].includes(u.voice))) ? u.voice : 'default',
    plan: u.plan,
    prompt: u.systemPrompt || DEFAULT_PROMPT,
    agentName: u.agentName || 'Solana',
    key,
    tz: u.timezone || DEFAULT_TZ,
    hours: u.hours || DEFAULT_HOURS,
    len: Number(u.appointmentLength) || 30,
    business: u.company || '',
    about: String(u.businessDescription || '').slice(0, 1500),
    afterHours: ['message', 'book', 'forward', 'closed'].includes(u.afterHours) ? u.afterHours : 'message',
    afterHoursMessage: String(u.afterHoursMessage || '').slice(0, 400),
    afterHoursForward: /^\+1\d{10}$/.test(u.afterHoursForward || '') ? u.afterHoursForward : ''
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

/* AFTER_HOURS helpers */
const DAY_NAMES = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const WEEK_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
function nowInTz(tz) {
  const p = tzParts(new Date(), tz);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date()).slice(0, 3).toLowerCase();
  return { day: wd, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
function dayIsOpen(h) {
  return !!(h && !h.closed && h.open && h.close && toMin(h.close) > toMin(h.open));
}
function isOpenNow(cfg) {
  try {
    const n = nowInTz(cfg.tz);
    const h = cfg.hours[n.day];
    return dayIsOpen(h) && n.min >= toMin(h.open) && n.min < toMin(h.close);
  } catch { return true; }
}
function hoursText(cfg) {
  return WEEK_ORDER.map(k => {
    const h = cfg.hours[k];
    return DAY_NAMES[k] + ' ' + (dayIsOpen(h) ? to12(h.open) + ' to ' + to12(h.close) : 'closed');
  }).join('; ');
}
function nextOpenText(cfg) {
  try {
    const n = nowInTz(cfg.tz);
    const start = DAY_KEYS.indexOf(n.day);
    for (let i = 0; i < 8; i++) {
      const k = DAY_KEYS[(start + i) % 7];
      const h = cfg.hours[k];
      if (!dayIsOpen(h)) continue;
      if (i === 0 && n.min >= toMin(h.open)) continue;
      const when = i === 0 ? 'today' : i === 1 ? 'tomorrow' : DAY_NAMES[k];
      return `${when} at ${to12(h.open)}`;
    }
  } catch {}
  return '';
}
function closedGreeting(cfg) {
  if (cfg.afterHoursMessage) return cfg.afterHoursMessage;
  const next = nextOpenText(cfg);
  return `Thanks for calling${cfg.business ? ' ' + cfg.business : ''}. We're closed right now.` +
    (next ? ` We open again ${next}.` : '') + ' Please call back then. Goodbye.';
}
function hoursPrompt(cfg) {
  let s = `\n\nBusiness hours (${cfg.tz}): ${hoursText(cfg)}.`;
  if (isOpenNow(cfg)) {
    s += ' The business is OPEN right now.';
  } else {
    const next = nextOpenText(cfg);
    s += ` The business is CLOSED right now${next ? ' and opens again ' + next : ''}. Let the caller know early in the call.`;
    if (cfg.afterHours === 'book') {
      s += ' You can still help: book them into an upcoming open time with the calendar tools, or take a message.';
    } else {
      s += ' Offer to take a message so the team can call them back. If they ask, you can also book a time when the business is open.';
    }
    if (cfg.afterHoursMessage) s += ` Open the call with something close to: "${cfg.afterHoursMessage}"`;
  }
  s += " To take a message: get the caller's name, the best number to call back, and a short reason," +
    ' read it back to confirm, then call take_message.';
  return s;
}
async function logQuickCall(uid, from, status) {
  if (!db || !uid) return;
  try {
    await db.collection(`users/${uid}/calls`).add({
      from, status, durationSec: 0,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      endedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { app.log.error('Call log failed: ' + e.message); }
}

/* ---------------- calendar ---------------- */

const BOOKING_LEAD_MIN = Math.max(0, Number(process.env.BOOKING_LEAD_MINUTES || 30));
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

  const now = Date.now() + BOOKING_LEAD_MIN * 60000;   // never in the past, never too soon
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
    },
    {
      name: 'take_message',
      description: 'Save a message for the business. Call this after you have the caller\'s name, callback number and message, and have read it back to them.',
      parameters: {
        type: 'OBJECT',
        properties: {
          caller_name: { type: 'STRING' },
          callback_number: { type: 'STRING', description: 'Best number to call back' },
          message: { type: 'STRING', description: 'What the caller needs, in a sentence or two' }
        },
        required: ['caller_name', 'message']
      }
    }
  ]
}];

/* HISTORY_ACTIONS */
async function runTool(cfg, name, args, callerPhone) {
  const result = await runToolInner(cfg, name, args, callerPhone);
  if (cfg && cfg.callRef) {
    const a = { type: name, at: admin.firestore.Timestamp.now() };
    if (name === 'check_availability') {
      a.date = String(args.date || '');
      a.open = !!(result && result.open);
      a.times = (result && result.available_times) ? result.available_times.length : 0;
    } else if (name === 'book_appointment') {
      a.date = String(args.date || ''); a.time = (result && result.time) || String(args.time || '');
      a.name = String(args.customer_name || '').slice(0, 100); a.reason = String(args.reason || '').slice(0, 200);
      a.ok = !!(result && result.booked);
    } else if (name === 'take_message') {
      a.name = String(args.caller_name || '').slice(0, 100); a.ok = !!(result && result.saved);
    }
    cfg.callRef.set({ actions: admin.firestore.FieldValue.arrayUnion(a) }, { merge: true }).catch(() => {});
  }
  return result;
}
async function runToolInner(cfg, name, args, callerPhone) {
  try {
    if (name === 'check_availability') {
      const r = await freeSlots(cfg, args.date);
      if (r.closed) return { date: args.date, open: false, message: 'The business is closed that day.' };
      if (!r.slots.length) return { date: args.date, open: true, available_times: [], message: 'No open times left that day (it may already be over, or fully booked). Offer another day.' };
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
        callId: cfg.callRef ? cfg.callRef.id : null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      app.log.info(`Booked ${args.date} ${time} for ${args.customer_name} (user ${cfg.uid})`);
      return { booked: true, date: args.date, time: to12(time) };
    }
    if (name === 'take_message') {
      const message = {
        name: String(args.caller_name || '').slice(0, 100),
        phone: String(args.callback_number || callerPhone || '').slice(0, 40),
        reason: String(args.message || '').slice(0, 1000),
        at: admin.firestore.Timestamp.now()
      };
      if (cfg.callRef) await cfg.callRef.set({ message }, { merge: true });
      app.log.info(`Message taken for ${cfg.uid} from ${message.name}`);
      return { saved: true };
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
      if (!isOpenNow(cfg)) {
        if (cfg.afterHours === 'closed') {
          await logQuickCall(tenant.uid, from, 'after-hours');
          return sayAndHang(reply, closedGreeting(cfg));
        }
        if (cfg.afterHours === 'forward' && cfg.afterHoursForward && cfg.afterHoursForward !== to) {
          await logQuickCall(tenant.uid, from, 'forwarded');
          return reply.type('text/xml').send(
            '<?xml version="1.0" encoding="UTF-8"?><Response>' +
            `<Dial timeout="25">${xml(cfg.afterHoursForward)}</Dial>` +
            `<Say>${xml('Sorry, no one could pick up. Please call back during business hours. Goodbye.')}</Say>` +
            '</Response>'
          );
        }
      }
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
  let streamSid = null, agent = null, cfg = null, from = '', callRef = null, startedAt = Date.now();
  const transcript = [];

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
      app.log.info(`Call started for ${cfg.uid || 'default line'} from ${from} (${cfg.provider || 'gemini'})`);
      if (cfg.uid && db) {
        try {
          callRef = await db.collection(`users/${cfg.uid}/calls`).add({
            from, startedAt: admin.firestore.FieldValue.serverTimestamp(), status: 'in-progress'
          });
          cfg.callRef = callRef;
        } catch (e) { app.log.error('Call log failed: ' + e.message); }
      }
      agent = openAgent(cfg, {
        io: 'phone',
        tools: !!cfg.uid,
        system: buildSystem(cfg, from, 'call'),
        greet: 'A caller just connected. Greet them warmly and ask how you can help.',
        runTool: (name, args) => runTool(cfg, name, args, from),
        onAudio: (b64) => { if (streamSid) twilio.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } })); },
        onClear: () => { if (streamSid) twilio.send(JSON.stringify({ event: 'clear', streamSid })); },
        onCaption: (who, text) => addLine(transcript, who === 'caller' ? 'Caller' : cfg.agentName, text),
        onError: (m) => app.log.error('AI error: ' + m),
        onClose: () => { try { twilio.close(); } catch {} }
      });
    } else if (msg.event === 'media') {
      if (agent) agent.sendAudio(msg.media.payload);
    } else if (msg.event === 'stop') {
      if (agent) agent.close();
    }
  });

  twilio.on('close', async () => {
    if (agent) agent.close();
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    if (callRef) {
      try {
        await callRef.update({
          endedAt: admin.firestore.FieldValue.serverTimestamp(),
          durationSec,
          status: 'completed'
        });
      } catch {}
    }
    finishCall(cfg, callRef, transcript, from, durationSec).catch(() => {});
  });
});

/* ---------------- dashboard API: phone numbers ---------------- */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://vocallus.netlify.app,http://localhost:8080,http://127.0.0.1:5500')
  .split(',').map(s => s.trim());
const TW_SID = process.env.TWILIO_ACCOUNT_SID;
const TW_TOKEN = process.env.TWILIO_AUTH_TOKEN;

function setCors(req, reply) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

app.options('/api/*', async (req, reply) => { setCors(req, reply); return reply.code(204).send(); });

async function requireUser(req, reply) {
  setCors(req, reply);
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m || !db) { reply.code(401).send({ error: 'Not signed in' }); return null; }
  try {
    const decoded = await admin.auth().verifyIdToken(m[1]);
    const snap = await db.doc(`users/${decoded.uid}`).get();
    return { uid: decoded.uid, data: snap.data() || {} };
  } catch (e) {
    reply.code(401).send({ error: 'Session expired. Please sign in again.' });
    return null;
  }
}

async function twilioApi(path, opts = {}) {
  if (!TW_SID || !TW_TOKEN) throw new Error('Twilio is not configured on the server');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID}${path}`, {
    ...opts,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TW_SID}:${TW_TOKEN}`).toString('base64'),
      ...(opts.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Twilio error ${res.status}`);
  return body;
}

app.get('/api/numbers/search', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  const area = String(req.query.areaCode || '').replace(/\D/g, '').slice(0, 3);
  if (area.length !== 3) return reply.code(400).send({ error: 'Enter a 3-digit area code.' });
  try {
    const r = await twilioApi(`/AvailablePhoneNumbers/US/Local.json?AreaCode=${area}&VoiceEnabled=true&PageSize=10`);
    return {
      numbers: (r.available_phone_numbers || []).map(n => ({
        phoneNumber: n.phone_number, friendlyName: n.friendly_name,
        locality: n.locality, region: n.region
      }))
    };
  } catch (e) {
    return reply.code(502).send({ error: e.message });
  }
});

app.post('/api/numbers/buy', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  if (!['pro', 'max'].includes(user.data.plan)) {
    return reply.code(403).send({ error: 'Choose a plan before getting a number.' });
  }
  if (user.data.phoneNumber) {
    return reply.code(409).send({ error: 'Your account already has a number.' });
  }
  const phone = String((req.body && req.body.phoneNumber) || '');
  if (!/^\+1\d{10}$/.test(phone)) return reply.code(400).send({ error: 'Invalid phone number.' });
  try {
    const r = await twilioApi('/IncomingPhoneNumbers.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        PhoneNumber: phone,
        VoiceUrl: `https://${req.headers.host}/incoming-call`,
        VoiceMethod: 'POST',
        FriendlyName: `vocallus-${user.uid}`
      })
    });
    await db.doc(`users/${user.uid}`).set({
      phoneNumber: r.phone_number,
      twilioNumberSid: r.sid,
      numberSource: 'purchased',
      numberCreatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    app.log.info(`Bought ${r.phone_number} for ${user.uid}`);
    return { phoneNumber: r.phone_number };
  } catch (e) {
    return reply.code(502).send({ error: e.message });
  }
});

/* ---------------- Stripe webhook ---------------- */
import crypto from 'node:crypto';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PLAN_BY_AMOUNT = { 1499: 'pro', 9999: 'max' };   // cents

// Keep the raw body so Stripe's signature can be checked.
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  if (!body || !body.length) return done(null, {});
  try { done(null, JSON.parse(body.toString('utf8'))); }
  catch (e) { e.statusCode = 400; done(e); }
});

function verifyStripe(raw, header) {
  if (!STRIPE_WEBHOOK_SECRET || !header || !raw) return false;
  const items = header.split(',');
  const t = (items.find(p => p.startsWith('t=')) || '').slice(2);
  const sigs = items.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return sigs.some(s => s.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

app.post('/stripe/webhook', async (req, reply) => {
  if (!verifyStripe(req.rawBody, req.headers['stripe-signature'])) {
    app.log.warn('Stripe webhook: bad signature');
    return reply.code(400).send({ error: 'bad signature' });
  }
  if (!db) return reply.code(500).send({ error: 'database not configured' });
  const evt = req.body || {};
  const obj = (evt.data && evt.data.object) || {};
  try {
    if (evt.type === 'checkout.session.completed') {
      const uid = obj.client_reference_id;
      const plan = PLAN_BY_AMOUNT[obj.amount_total];
      if (!uid || !plan) {
        app.log.warn(`Stripe checkout without uid/plan (uid=${uid}, amount=${obj.amount_total})`);
      } else {
        await db.doc(`users/${uid}`).set({
          plan,
          stripeCustomerId: obj.customer || null,
          stripeSubscriptionId: obj.subscription || null,
          planUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        app.log.info(`Plan ${plan} activated for ${uid}`);
      }
    } else if ((evt.type === 'customer.subscription.created' || evt.type === 'customer.subscription.updated') &&
               ['active', 'trialing'].includes(obj.status) && obj.metadata && obj.metadata.uid) {
      const plan = obj.metadata.plan === 'max' ? 'max' : 'pro';
      await db.doc(`users/${obj.metadata.uid}`).set({
        plan,
        stripeCustomerId: obj.customer || null,
        stripeSubscriptionId: obj.id,
        planUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      app.log.info(`Plan ${plan} active for ${obj.metadata.uid}`);
    } else if (evt.type === 'customer.subscription.deleted' ||
              (evt.type === 'customer.subscription.updated' &&
               ['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status))) {
      const snap = await db.collection('users').where('stripeSubscriptionId', '==', obj.id).limit(1).get();
      if (!snap.empty) {
        await snap.docs[0].ref.set({
          plan: 'none',
          planUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        app.log.info(`Plan cancelled for ${snap.docs[0].id}`);
      }
    }
  } catch (e) {
    app.log.error('Stripe webhook failed: ' + e.message);
    return reply.code(500).send({ error: 'failed' });
  }
  return { received: true };
});

/* SOLANA_LIVE block */
/* AGENT_ADAPTERS */
/* ---------------- AI voice: Gemini Live or OpenAI Realtime ---------------- */
const SITE_URL = (process.env.SITE_URL || 'https://vocallus.netlify.app').replace(/\/$/, '');
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'marin';
/* VOICE_SET */
const GEMINI_VOICES = { default: VOICE, female: process.env.GEMINI_VOICE_FEMALE || 'Kore', male: process.env.GEMINI_VOICE_MALE || 'Charon' };
const OPENAI_VOICES = { default: OPENAI_VOICE, female: process.env.OPENAI_VOICE_FEMALE || 'coral', male: process.env.OPENAI_VOICE_MALE || 'cedar' };
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const OPENAI_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';

function lowerTypes(s) {
  if (Array.isArray(s)) return s.map(lowerTypes);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const k of Object.keys(s)) o[k] = (k === 'type' && typeof s[k] === 'string') ? s[k].toLowerCase() : lowerTypes(s[k]);
  return o;
}
const OPENAI_TOOLS = TOOLS[0].functionDeclarations.map(f => ({
  type: 'function', name: f.name, description: f.description, parameters: lowerTypes(f.parameters)
}));

// 16 kHz PCM16 (browser mic) -> 24 kHz PCM16 (OpenAI)
function pcm16kTo24k(b64) {
  const inp = Buffer.from(b64, 'base64');
  const n = inp.length >> 1;
  if (!n) return '';
  const outN = Math.floor(n * 1.5);
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const pos = i / 1.5, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, n - 1), f = pos - i0;
    const s0 = inp.readInt16LE(i0 * 2), s1 = inp.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))), i * 2);
  }
  return out.toString('base64');
}

// io: 'phone' (Twilio mu-law 8k in/out) or 'browser' (PCM 16k in, PCM 24k out)
/* ELEVEN_VOICES */
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const ELEVEN_VOICES = {
  mmale: process.env.ELEVENLABS_VOICE_PRO_MALE || 'nPczCjzI2devNBz1zQrb',     // Brian
  mfmale: process.env.ELEVENLABS_VOICE_PRO_FEMALE || 'EXAVITQu4vr4xnSDxMaL',  // Sarah
  rmale: process.env.ELEVENLABS_VOICE_RUSTIC_MALE || 'pqHfZKP75CvOlQylNhV4'   // Bill
};

// One ElevenLabs stream per spoken turn. Text goes in, audio (mu-law 8k or PCM 24k) comes out.
function elevenStream(voiceId, fmt, onAudio, onDone) {
  const ws = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${encodeURIComponent(ELEVEN_MODEL)}` +
    `&output_format=${fmt}&inactivity_timeout=60`,
    { headers: { 'xi-api-key': ELEVEN_KEY } });
  let open = false, dead = false, buf = '';
  const queue = [];
  const send = (obj) => {
    if (dead) return;
    if (open && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    else queue.push(obj);
  };
  ws.on('open', () => {
    open = true;
    ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1 } }));
    while (queue.length) ws.send(JSON.stringify(queue.shift()));
  });
  ws.on('message', (d) => {
    if (dead) return;
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.audio) onAudio(m.audio);
    else if (m.error || (m.message && !m.isFinal && !m.is_final)) app.log.error('ElevenLabs: ' + (m.error || m.message));
  });
  ws.on('unexpected-response', (req, res) => {
    try { req.destroy(); } catch {}
    app.log.error(`ElevenLabs HTTP ${res.statusCode}` + (res.statusCode === 401 ? ' (check ELEVENLABS_API_KEY)' : ''));
    dead = true;
    if (onDone) onDone();
  });
  ws.on('close', () => { dead = true; if (onDone) onDone(); });
  ws.on('error', (e) => app.log.error('ElevenLabs socket: ' + e.message));

  // Send whole sentences (or long phrases) so speech starts fast and sounds natural.
  function pump(force) {
    for (;;) {
      const m = buf.match(/^([\s\S]*?[.!?](?:["')\]]*))\s+/);
      if (m) { send({ text: m[1] + ' ', flush: true }); buf = buf.slice(m[0].length); continue; }
      if (buf.length > 90) {
        const cut = Math.max(buf.lastIndexOf(', ', 90), buf.lastIndexOf(' ', 90));
        if (cut > 20) { send({ text: buf.slice(0, cut + 1) + ' ', flush: true }); buf = buf.slice(cut + 1); continue; }
      }
      break;
    }
    if (force && buf.trim()) { send({ text: buf.trim() + ' ', flush: true }); buf = ''; }
  }
  return {
    push(text) { buf += text; pump(false); },
    end() { pump(true); send({ text: '' }); },
    cancel() { dead = true; try { ws.close(); } catch {} }
  };
}

// Mute the AI's own voice and speak its words with ElevenLabs instead.
// If ElevenLabs fails (bad key, voice not in your account...), the call falls back to the AI's own voice.
function withEleven(o, voiceId) {
  const fmt = o.io === 'phone' ? 'ulaw_8000' : 'pcm_24000';
  let tts = null, broken = false, held = [];
  const giveUp = (why) => {
    if (broken) return;
    broken = true;
    app.log.error(`ElevenLabs gave no audio (${why}) - using the default voice for the rest of this call`);
    const backlog = held; held = [];
    backlog.forEach(b => o.onAudio(b));
  };
  const current = () => {
    if (!tts) {
      const inst = elevenStream(voiceId, fmt, (b64) => {
        inst.gotAudio = true; held = [];
        o.onAudio(b64);
      }, () => {
        if (tts === inst) tts = null;
        if (inst.pushed && !inst.gotAudio && !inst.cancelled) giveUp('stream closed');
      });
      tts = inst;
    }
    return tts;
  };
  return Object.assign({}, o, {
    onAudio: (b64) => {
      if (broken) return o.onAudio(b64);
      if (held.length < 3000) held.push(b64);       // kept in case ElevenLabs fails this turn
    },
    onCaption: (who, text) => {
      if (o.onCaption) o.onCaption(who, text);
      if (!broken && who === 'agent' && text && text.trim()) { const t = current(); t.pushed = true; t.push(text); }
      else if (!broken && who === 'agent' && text && tts) tts.push(text);
    },
    onTurnEnd: () => { if (tts) { tts.end(); tts = null; } if (o.onTurnEnd) o.onTurnEnd(); },
    onClear: () => {
      held = [];
      if (tts) { tts.cancelled = true; tts.cancel(); tts = null; }
      if (o.onClear) o.onClear();
    }
  });
}

function openAgent(cfg, o) {
  const elevenId = ELEVEN_VOICES[cfg.voice];
  const useEleven = !!(elevenId && ELEVEN_KEY);
  app.log.info(`Agent for ${cfg.uid || 'default line'}: ${cfg.provider || 'gemini'}, voice=${cfg.voice || 'default'}` +
    (useEleven ? ' (ElevenLabs)' : (elevenId ? ' (ELEVENLABS_API_KEY missing - default voice)' : '')));
  if (useEleven) o = withEleven(o, elevenId);
  return (cfg.provider === 'openai' ? openaiAgent : geminiAgent)(cfg, o);
}

// What the server will actually use for this account - shown on the Solana page.
app.get('/api/agent/status', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  let cfg;
  try { cfg = await loadConfig(user.uid); } catch (e) { return reply.code(500).send({ error: 'Could not load your settings.' }); }
  const out = {
    plan: user.data.plan || 'none',
    phoneNumber: user.data.phoneNumber || '',
    provider: cfg.provider || 'gemini',
    aiReady: !!cfg.key,
    savedVoice: user.data.voice || 'default',
    voice: cfg.voice || 'default',
    engine: cfg.provider === 'openai' ? 'openai' : 'gemini',
    problem: ''
  };
  const eid = ELEVEN_VOICES[out.voice];
  if (eid) {
    out.engine = 'elevenlabs';
    if (!ELEVEN_KEY) out.problem = 'eleven-missing';
    else {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/voices/${eid}`, { headers: { 'xi-api-key': ELEVEN_KEY } });
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          if (/missing_permissions/i.test(body)) out.problem = '';            // key can't read voices; can't check
          else out.problem = r.status === 401 ? 'eleven-key' : 'eleven-voice';
        }
      } catch { out.problem = 'eleven-unreachable'; }
    }
  }
  return out;
});

function geminiAgent(cfg, o) {
  const ws = new WebSocket(GEMINI_URL + encodeURIComponent(cfg.key));
  let ready = false, toolBusy = 0, closed = false;
  const pending = [];
  ws.on('open', () => {
    const setup = {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICES[cfg.voice] || VOICE } } }
      },
      systemInstruction: { parts: [{ text: o.system }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    };
    if (o.tools) setup.tools = TOOLS;
    ws.send(JSON.stringify({ setup }));
  });
  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.setupComplete) {
      ready = true;
      ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: o.greet }] }], turnComplete: true } }));
      while (pending.length) ws.send(pending.shift());
      if (o.onReady) o.onReady();
      return;
    }
    if (msg.toolCall) {
      // Hold the caller's audio while a tool runs - streaming audio mid tool call is what makes
      // Gemini drop the session with "CONTENT_TYPE_AUDIO is not supported".
      toolBusy++;
      try {
        const calls = msg.toolCall.functionCalls || [];
        calls.forEach(c => o.onTool && o.onTool(c.name));
        const functionResponses = await Promise.all(calls.map(async c => ({
          id: c.id, name: c.name, response: await o.runTool(c.name, c.args || {})
        })));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
      } finally { toolBusy--; }
      return;
    }
    const sc = msg.serverContent;
    if (!sc) {
      if (msg.error && o.onError) o.onError(msg.error.message || JSON.stringify(msg.error));
      return;
    }
    if (sc.interrupted && o.onClear) o.onClear();
    if (sc.inputTranscription && sc.inputTranscription.text) o.onCaption && o.onCaption('caller', sc.inputTranscription.text);
    if (sc.outputTranscription && sc.outputTranscription.text) o.onCaption && o.onCaption('agent', sc.outputTranscription.text);
    for (const p of (sc.modelTurn && sc.modelTurn.parts) || []) {
      if (p.inlineData && p.inlineData.data) o.onAudio(o.io === 'phone' ? geminiToTwilio(p.inlineData.data) : p.inlineData.data);
    }
    if ((sc.turnComplete || sc.generationComplete) && o.onTurnEnd) o.onTurnEnd();
  });
  ws.on('close', (code, reason) => {
    if (closed) return;
    closed = true;
    app.log.info(`Gemini closed: ${code} ${reason ? reason.toString() : ''}`);
    if (o.onClose) o.onClose(code, reason ? reason.toString() : '');
  });
  ws.on('error', (err) => app.log.error('Gemini socket error: ' + err.message));
  return {
    sendAudio(b64) {
      if (toolBusy > 0) return;
      const frame = JSON.stringify({ realtimeInput: { audio: {
        data: o.io === 'phone' ? twilioToGemini(b64) : b64, mimeType: 'audio/pcm;rate=16000'
      } } });
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(frame);
      else if (pending.length < 100) pending.push(frame);
    },
    close() { closed = true; try { ws.close(); } catch {} }
  };
}

function openaiAgent(cfg, o) {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    { headers: { Authorization: `Bearer ${cfg.key}` } });
  let ready = false, toolBusy = 0, closed = false, greeted = false;
  const pending = [];
  const fmt = o.io === 'phone' ? { type: 'audio/pcmu' } : { type: 'audio/pcm', rate: 24000 };
  const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  ws.on('open', () => {
    send({ type: 'session.update', session: {
      type: 'realtime',
      model: OPENAI_REALTIME_MODEL,
      instructions: o.system,
      output_modalities: ['audio'],
      audio: {
        input: { format: fmt, transcription: { model: OPENAI_TRANSCRIBE_MODEL }, turn_detection: { type: 'server_vad' } },
        output: { format: fmt, voice: OPENAI_VOICES[cfg.voice] || OPENAI_VOICE }
      },
      tools: o.tools ? OPENAI_TOOLS : [],
      tool_choice: 'auto'
    } });
  });
  ws.on('message', async (data) => {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch { return; }
    switch (ev.type) {
      case 'session.updated':
        if (!greeted) {
          greeted = true; ready = true;
          send({ type: 'response.create', response: { instructions: o.greet } });
          while (pending.length) ws.send(pending.shift());
          if (o.onReady) o.onReady();
        }
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (ev.delta) o.onAudio(ev.delta);
        break;
      case 'input_audio_buffer.speech_started':
        if (o.onClear) o.onClear();
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (ev.delta && o.onCaption) o.onCaption('agent', ev.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript && o.onCaption) o.onCaption('caller', ev.transcript + ' ');
        break;
      case 'response.done': {
        if (o.onTurnEnd) o.onTurnEnd();
        const calls = ((ev.response && ev.response.output) || []).filter(it => it.type === 'function_call');
        if (!calls.length) break;
        toolBusy++;
        try {
          for (const c of calls) {
            if (o.onTool) o.onTool(c.name);
            let args = {};
            try { args = JSON.parse(c.arguments || '{}'); } catch {}
            const result = await o.runTool(c.name, args);
            send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) } });
          }
          send({ type: 'response.create' });
        } finally { toolBusy--; }
        break;
      }
      case 'error': {
        const m = (ev.error && ev.error.message) || 'OpenAI error';
        app.log.error('OpenAI realtime: ' + m);
        if (o.onError && !/no active response|cancel/i.test(m)) o.onError(m);
        break;
      }
    }
  });
  ws.on('unexpected-response', (req, res) => {
    try { req.destroy(); } catch {}
    const m = res.statusCode === 401 ? 'Your OpenAI API key was rejected. Check it on the Solana page.' : `OpenAI error ${res.statusCode}`;
    if (o.onError) o.onError(m);
    if (!closed) { closed = true; if (o.onClose) o.onClose(4000 + (res.statusCode || 0), m); }
  });
  ws.on('close', (code, reason) => {
    if (closed) return;
    closed = true;
    app.log.info(`OpenAI closed: ${code} ${reason ? reason.toString() : ''}`);
    if (o.onClose) o.onClose(code, reason ? reason.toString() : '');
  });
  ws.on('error', (err) => app.log.error('OpenAI socket error: ' + err.message));
  return {
    sendAudio(b64) {
      if (toolBusy > 0) return;
      const audio = o.io === 'phone' ? b64 : pcm16kTo24k(b64);
      if (!audio) return;
      const frame = JSON.stringify({ type: 'input_audio_buffer.append', audio });
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(frame);
      else if (pending.length < 100) pending.push(frame);
    },
    close() { closed = true; try { ws.close(); } catch {} }
  };
}

/* ---------------- text: summaries + test chat (Gemini or OpenAI) ---------------- */
const fmtNum = (n) => {
  let d = String(n || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n || 'unknown caller');
};
function addLine(transcript, who, text) {
  if (!text) return;
  const last = transcript[transcript.length - 1];
  if (last && last.who === who) last.text += text;
  else if (transcript.length < 400) transcript.push({ who, text });
}
const transcriptText = (t) => t.map(l => `${l.who}: ${l.text.trim()}`).join('\n');
const keyError = (provider, m) => /api key|unauthori|401|invalid.*key/i.test(m)
  ? `Your ${provider === 'openai' ? 'OpenAI' : 'Google'} API key was rejected. Check it on the Solana page.` : m;

async function geminiText(key, system, contents, tools) {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools) body.tools = tools;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${TEXT_MODEL}:generateContent?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Gemini error ${res.status}`);
  return j;
}
const partsOf = (j) => (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];

async function openaiChat(key, messages, tools) {
  const body = { model: OPENAI_TEXT_MODEL, messages };
  if (tools) body.tools = tools;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `OpenAI error ${res.status}`);
  return j.choices && j.choices[0] && j.choices[0].message || {};
}

// msgs: [{ role: 'user' | 'model', text }]. Runs calendar tools. Returns the reply text.
async function chatReply(cfg, key, system, msgs, withTools) {
  if (cfg.provider === 'openai') {
    const messages = [{ role: 'system', content: system }]
      .concat(msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })));
    const tools = withTools ? OPENAI_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined;
    for (let i = 0; i < 5; i++) {
      const m = await openaiChat(key, messages, tools);
      if (!m.tool_calls || !m.tool_calls.length) return (m.content || '').trim();
      messages.push(m);
      for (const tc of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(await runTool(cfg, tc.function.name, args, '')) });
      }
    }
    return '';
  }
  const contents = msgs.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] }));
  for (let i = 0; i < 5; i++) {
    const j = await geminiText(key, system, contents, withTools ? TOOLS : undefined);
    const parts = partsOf(j);
    const calls = parts.filter(p => p.functionCall);
    if (!calls.length) return parts.map(p => p.text || '').join('').trim();
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const p of calls) {
      responses.push({ functionResponse: { name: p.functionCall.name, response: await runTool(cfg, p.functionCall.name, p.functionCall.args || {}, '') } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return '';
}

async function summarize(cfg, transcript) {
  const key = cfg && (cfg.key || (cfg.provider !== 'openai' ? DEFAULT_KEY : null));
  if (!key || !transcript.length) return '';
  try {
    return (await chatReply(cfg, key,
      'You write very short phone call summaries for a business owner. One or two plain sentences, no greeting, no markdown. ' +
      'Say who called (their name if given), what they wanted, and what happened (appointment booked, message taken, question answered).',
      [{ role: 'user', text: `Call answered by ${cfg.agentName}:\n\n` + transcriptText(transcript).slice(0, 12000) }], false)).slice(0, 600);
  } catch (e) {
    app.log.error('Summary failed: ' + e.message);
    return '';
  }
}

async function notifyOwner(uid, title, body, link) {
  if (!db || !uid) return { sent: 0, reason: 'no-db' };
  try {
    const ref = db.doc(`users/${uid}/private/push`);
    const d = (await ref.get()).data() || {};
    const tokens = Array.isArray(d.tokens) ? d.tokens.filter(Boolean) : [];
    if (!d.enabled || !tokens.length) return { sent: 0, reason: 'off' };
    const r = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: String(title).slice(0, 100), body: String(body || '').slice(0, 240) },
      webpush: {
        fcmOptions: { link: link || `${SITE_URL}/Pages/history.html` },
        notification: { icon: `${SITE_URL}/Images/favicon.png` }
      }
    });
    const dead = [];
    r.responses.forEach((x, i) => {
      const c = !x.success && x.error && x.error.code;
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' ||
          c === 'messaging/invalid-argument') dead.push(tokens[i]);
    });
    if (dead.length) await ref.set({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) }, { merge: true });
    return { sent: r.successCount, reason: r.successCount ? 'ok' : 'failed' };
  } catch (e) {
    app.log.error('Alert failed: ' + e.message);
    return { sent: 0, reason: e.message };
  }
}

const durText = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function finishCall(cfg, callRef, transcript, from, durationSec) {
  if (!cfg || !cfg.uid) return;
  const summary = await summarize(cfg, transcript);
  if (callRef) {
    try {
      await callRef.set({
        summary,
        transcript: transcript.slice(0, 200).map(l => ({ who: l.who, text: l.text.trim().slice(0, 2000) }))
      }, { merge: true });
    } catch (e) { app.log.error('Saving summary failed: ' + e.message); }
  }
  await notifyOwner(cfg.uid, `${cfg.agentName} · call from ${fmtNum(from)}`,
    summary || `Call ended after ${durText(durationSec)}.`);
}

function buildSystem(cfg, from, channel) {
  let s = cfg.prompt +
    `\n\nYour name is ${cfg.agentName}.` +
    (cfg.business ? ` You answer the phone for ${cfg.business}.` : '') +
    ` Today is ${todayText(cfg.tz)}.`;
  if (channel === 'chat') {
    s += " This is a text chat test from the business owner's dashboard. Treat them like a real customer." +
      ' Reply in short, natural sentences like you would on the phone. Plain text only, no markdown.';
  } else {
    s += ` The caller's number is ${from || 'unknown'}. Speak like a real person on the phone and keep replies short.`;
  }
  if (cfg.uid) {
    s += hoursPrompt(cfg);
    s += ' To book: ask what day they want, call check_availability for that date, offer a few of the returned times,' +
      ' get their name, confirm the date and time back to them, then call book_appointment. Never invent open times.' +
      ' Say times in 12-hour format like 2:30 PM.';
    s += ' Before booking, always spell the caller\'s name back letter by letter, for example "So that is R-A-Y-A-A-N, is that right?".'
      + ' If they say no, ask them to spell it and spell it back again until they say yes.'
      + ' Then repeat the day, date and time and only call book_appointment after they clearly say yes.'
      + ' Never book a time in the past or a time check_availability did not return.';
  }
  if (cfg.about) {
    s += `\n\nAbout the business: ${cfg.about}`;
  }
  s += '\n\nOnly help with things related to this business (its services, hours, appointments, and taking messages).'
    + ' If someone asks for something unrelated, politely say you can only help with this business and offer to take a message.';
  return s;
}

// Daily test limits (in memory; resets when the server restarts or the day changes).
const demoUse = new Map();
function demoBucket(uid) {
  const day = new Date().toISOString().slice(0, 10);
  let u = demoUse.get(uid);
  if (!u || u.day !== day) { u = { day, chat: 0, sec: 0 }; demoUse.set(uid, u); }
  return u;
}
// Test chats/calls: the customer's own key if they saved one, otherwise yours (Gemini).
function testCfg(cfg) {
  if (cfg.key) return cfg;
  return Object.assign({}, cfg, { provider: 'gemini', key: DEFAULT_KEY });
}

app.get('/api/config', async (req, reply) => {
  setCors(req, reply);
  return { vapidKey: process.env.FIREBASE_VAPID_KEY || '' };
});

app.post('/api/alerts/test', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  const name = user.data.agentName || 'Solana';
  const r = await notifyOwner(user.uid, `${name} alerts are on`,
    "You'll get a short summary here after every call.", `${SITE_URL}/Pages/dashboard.html`);
  if (!r.sent) return reply.code(400).send({ error: r.reason === 'off' ? 'Alerts are off for this account.' : 'Could not send: ' + r.reason });
  return { sent: r.sent };
});

app.post('/api/demo/chat', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  const paid = ['pro', 'max'].includes(user.data.plan);
  const b = demoBucket(user.uid);
  if (b.chat >= (paid ? 500 : 150)) return reply.code(429).send({ error: "You've hit today's test limit. Try again tomorrow." });
  b.chat++;

  const msgs = (Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(-30) : [])
    .map(m => ({ role: m.role === 'user' ? 'user' : 'model', text: String(m.text || '').slice(0, 2000) }));
  if (!msgs.length) return reply.code(400).send({ error: 'Type a message first.' });
  let cfg;
  try { cfg = testCfg(await loadConfig(user.uid)); } catch (e) { return reply.code(500).send({ error: 'Could not load your settings.' }); }
  if (!cfg.key) return reply.code(500).send({ error: 'No AI key is set up.' });
  try {
    const text = await chatReply(cfg, cfg.key, buildSystem(cfg, '', 'chat'), msgs, true);
    return { reply: text || 'Sorry, could you say that again?' };
  } catch (e) {
    app.log.error('Test chat: ' + e.message);
    return reply.code(502).send({ error: keyError(cfg.provider, e.message) });
  }
});

// Browser test call: mic audio (16 kHz PCM) in, voice (24 kHz PCM) out.
app.get('/demo-call', { websocket: true }, (sock, req) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) { try { sock.close(1008, 'origin not allowed'); } catch {} return; }

  let agent = null, live = false, cfg = null, uid = null, started = 0, timer = null, closed = false;
  const transcript = [];
  const send = (o) => { try { if (sock.readyState === 1) sock.send(JSON.stringify(o)); } catch {} };

  function end(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (agent) agent.close();
    send({ type: 'ended', reason });
    try { sock.close(); } catch {}
    const secs = started ? Math.round((Date.now() - started) / 1000) : 0;
    if (uid) demoBucket(uid).sec += secs;
    if (cfg && cfg.uid && transcript.length) {
      (async () => {
        const summary = await summarize(cfg, transcript);
        await notifyOwner(cfg.uid, `${cfg.agentName} · test call`, summary || `Test call ended after ${durText(secs)}.`);
      })().catch(() => {});
    }
  }

  sock.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === 'start' && !cfg) {
      try {
        const decoded = await admin.auth().verifyIdToken(String(m.token || ''));
        uid = decoded.uid;
        cfg = testCfg(await loadConfig(uid));
      } catch (e) {
        send({ type: 'error', error: 'Please sign in again.' });
        return end('auth');
      }
      const paid = ['pro', 'max'].includes(cfg.plan);
      const left = (paid ? 3600 : 900) - demoBucket(uid).sec;
      if (left <= 10) { send({ type: 'error', error: "You've used today's test call time. Try again tomorrow." }); return end('limit'); }
      if (!cfg.key) { send({ type: 'error', error: 'No AI key is set up.' }); return end('nokey'); }

      agent = openAgent(cfg, {
        io: 'browser',
        tools: true,
        system: buildSystem(cfg, '', 'call'),
        greet: 'A caller just connected. Greet them warmly and ask how you can help.',
        runTool: (name, args) => runTool(cfg, name, args, ''),
        onReady: () => {
          live = true;
          started = Date.now();
          timer = setTimeout(() => end('limit'), Math.min(300, left) * 1000);
          send({ type: 'live', maxSec: Math.min(300, left), agentName: cfg.agentName });
        },
        onAudio: (b64) => send({ type: 'audio', data: b64 }),
        onClear: () => send({ type: 'clear' }),
        onTool: (name) => send({ type: 'tool', name }),
        onCaption: (who, text) => {
          addLine(transcript, who === 'caller' ? 'Caller' : cfg.agentName, text);
          send({ type: 'caption', who: who === 'caller' ? 'you' : 'agent', text });
        },
        onError: (msg) => send({ type: 'error', error: keyError(cfg.provider, msg) }),
        onClose: (code, why) => {
          if (closed) return;
          if (code !== 1000) {
            send({ type: 'error', error: code === 1007
              ? 'The AI connection dropped. Press Call again to keep testing.'
              : keyError(cfg.provider, why || 'The AI connection closed.') });
          }
          end('ai');
        }
      });
    } else if (m.type === 'audio' && live && agent && typeof m.data === 'string') {
      agent.sendAudio(m.data);
    } else if (m.type === 'stop') {
      end('user');
    }
  });
  sock.on('close', () => end('closed'));
  sock.on('error', () => end('error'));
});

/* ---------------- Stripe on-site checkout ---------------- */
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PRICE_IDS = { pro: process.env.STRIPE_PRICE_PRO, max: process.env.STRIPE_PRICE_MAX };

app.post('/api/billing/subscribe', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  if (!stripe) return reply.code(500).send({ error: 'Billing is not set up yet.' });

  const want = req.body && req.body.plan;
  const plan = want === 'max' ? 'max' : want === 'pro' ? 'pro' : null;
  if (!plan || !PRICE_IDS[plan]) return reply.code(400).send({ error: 'Unknown plan.' });
  if (user.data.plan === plan) return reply.code(409).send({ error: `You're already on ${plan === 'max' ? 'Max' : 'Pro'}.` });

  try {
    let customerId = user.data.stripeCustomerId;
    if (!customerId) {
      const authUser = await admin.auth().getUser(user.uid);
      const c = await stripe.customers.create({
        email: authUser.email || undefined,
        name: user.data.name || authUser.displayName || undefined,
        metadata: { uid: user.uid }
      });
      customerId = c.id;
      await db.doc(`users/${user.uid}`).set({ stripeCustomerId: customerId }, { merge: true });
    }

    // Already paying -> switch plan on the existing subscription.
    const active = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
    if (active.data.length) {
      const sub = active.data[0];
      await stripe.subscriptions.update(sub.id, {
        items: [{ id: sub.items.data[0].id, price: PRICE_IDS[plan] }],
        proration_behavior: 'create_prorations',
        metadata: { uid: user.uid, plan }
      });
      return { updated: true, plan };
    }

    // Clean up checkout attempts that were never paid.
    const stale = await stripe.subscriptions.list({ customer: customerId, status: 'incomplete', limit: 10 });
    for (const s of stale.data) { try { await stripe.subscriptions.cancel(s.id); } catch {} }

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: PRICE_IDS[plan] }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata: { uid: user.uid, plan },
      expand: ['latest_invoice.confirmation_secret']
    });
    const inv = sub.latest_invoice;
    const clientSecret = inv && inv.confirmation_secret && inv.confirmation_secret.client_secret;
    if (!clientSecret) return reply.code(500).send({ error: 'Could not start checkout.' });
    return { clientSecret, subscriptionId: sub.id, plan };
  } catch (e) {
    app.log.error('Billing: ' + e.message);
    return reply.code(502).send({ error: e.message });
  }
});

/* ---------------- delete account ---------------- */
app.post('/api/account/delete', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return reply;
  if (!req.body || req.body.confirm !== 'DELETE') return reply.code(400).send({ error: 'Type DELETE to confirm.' });
  const d = user.data || {};

  // 1. Stop billing first - if this fails, nothing else is touched.
  try {
    if (typeof stripe !== 'undefined' && stripe && d.stripeCustomerId) {
      const subs = await stripe.subscriptions.list({ customer: d.stripeCustomerId, status: 'all', limit: 20 });
      for (const s of subs.data) {
        if (!['canceled', 'incomplete_expired'].includes(s.status)) await stripe.subscriptions.cancel(s.id);
      }
    }
  } catch (e) {
    app.log.error('Delete account (Stripe): ' + e.message);
    return reply.code(502).send({ error: "Couldn't cancel your subscription, so nothing was deleted. Please try again." });
  }

  // 2. Release a number Vocallus bought for them.
  if (d.twilioNumberSid && d.numberSource === 'purchased') {
    try { await twilioApi(`/IncomingPhoneNumbers/${d.twilioNumberSid}.json`, { method: 'DELETE' }); }
    catch (e) { app.log.error('Delete account (Twilio): ' + e.message); }
  }

  // 3. All their data (user doc + calls, appointments, private keys, push tokens).
  try { await db.recursiveDelete(db.doc(`users/${user.uid}`)); }
  catch (e) {
    app.log.error('Delete account (data): ' + e.message);
    return reply.code(500).send({ error: "Your subscription was cancelled but your data couldn't be deleted. Please try again." });
  }

  // 4. Their login.
  try { await admin.auth().deleteUser(user.uid); }
  catch (e) { app.log.error('Delete account (auth): ' + e.message); }

  app.log.info(`Deleted account ${user.uid}`);
  return { deleted: true };
});

const port = process.env.PORT || 8080;
await app.listen({ port, host: '0.0.0.0' });
