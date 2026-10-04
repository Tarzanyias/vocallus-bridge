import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import formbody from '@fastify/formbody';

const app = Fastify({ logger: true });
await app.register(formbody);          // Twilio sends form-encoded POSTs
await app.register(fastifyWebsocket);

app.get('/health', async () => ({
  status: 'ok',
  service: 'vocallus-bridge',
  time: new Date().toISOString()
}));

app.get('/', async () => ({
  message: 'Vocallus bridge is running',
  endpoints: ['/health', '/incoming-call', '/media-stream']
}));

// Twilio hits this when someone calls the number.
app.post('/incoming-call', async (req, reply) => {
  const host = req.headers.host;
  const to = (req.body && req.body.To) || 'unknown';
  const from = (req.body && req.body.From) || 'unknown';
  app.log.info(`Incoming call to ${to} from ${from}`);

  reply.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response>' +
      '<Say>Connecting you now.</Say>' +
      '<Connect>' +
        `<Stream url="wss://${host}/media-stream">` +
          `<Parameter name="to" value="${to}" />` +
        '</Stream>' +
      '</Connect>' +
    '</Response>'
  );
});

// Twilio streams the call audio here.
app.get('/media-stream', { websocket: true }, (socket, req) => {
  app.log.info('WebSocket client connected');
  let mediaCount = 0;

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') {
        const to = msg.start.customParameters && msg.start.customParameters.to;
        app.log.info(`Stream started: ${msg.start.streamSid} (number dialed: ${to})`);
      }
      if (msg.event === 'media') {
        mediaCount++;
        if (mediaCount % 250 === 0) app.log.info(`Audio packets received: ${mediaCount}`);
      }
      if (msg.event === 'stop') app.log.info(`Stream stopped after ${mediaCount} audio packets`);
    } catch (err) {
      app.log.error('Bad message from Twilio');
    }
  });

  socket.on('close', () => app.log.info('WebSocket closed'));
});

const port = process.env.PORT || 8080;
await app.listen({ port, host: '0.0.0.0' });
