import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';

const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

// Health check — Railway and your browser use this to confirm it's alive.
app.get('/health', async () => ({
  status: 'ok',
  service: 'vocallus-bridge',
  time: new Date().toISOString()
}));

// Root route — so visiting the bare URL doesn't 404.
app.get('/', async () => ({
  message: 'Vocallus bridge is running',
  endpoints: ['/health', '/incoming-call', '/media-stream']
}));

// Twilio will POST here when a call comes in. For now this is a stub
// that returns an empty TwiML response so we can test the deploy.
app.post('/incoming-call', async (req, reply) => {
  reply.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  );
});

// Twilio Media Streams connects here. Full bridge logic comes later.
app.get('/media-stream', { websocket: true }, (socket, req) => {
  app.log.info('WebSocket client connected');
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'start') app.log.info(`Stream started: ${msg.start.streamSid}`);
      if (msg.event === 'stop') app.log.info('Stream stopped');
    } catch (err) {
      app.log.error('Bad message from Twilio');
    }
  });
  socket.on('close', () => app.log.info('WebSocket closed'));
});

const port = process.env.PORT || 8080;
await app.listen({ port, host: '0.0.0.0' });
