# Vocallus Bridge

Twilio Media Streams bridge for the Vocallus AI receptionist.

## Endpoints

- `GET /health` — health check
- `POST /incoming-call` — Twilio webhook
- `WS  /media-stream` — Twilio media stream

## Deploy

Deployed on Railway. Environment variables:

- `OPENAI_API_KEY` — OpenAI API key
- `SYSTEM_PROMPT` — Solana's system prompt
