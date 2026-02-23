# Twilio Voice Memory Application

A Twilio voice application that integrates with Twilio Memory API to fetch caller profiles and uses OpenAI for intelligent conversations.

## Features

- 📞 Incoming call handling with Twilio Voice
- 💾 Automatic profile lookup from Twilio Memory using caller's phone number
- 🤖 OpenAI GPT-4 powered conversations
- 🎙️ Speech recognition and text-to-speech
- 📝 Customizable AI context and tool manifests

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- Twilio account with Voice API enabled
- Twilio Memory Store configured
- OpenAI API key
- ngrok or similar tunneling service for local development

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure your environment variables in `.env`:
```
PORT=3001
SERVER_BASE_URL=your-ngrok-url.ngrok-free.dev
OPENAI_API_KEY=your-openai-key
ACCOUNT_SID=your-twilio-account-sid
AUTH_TOKEN=your-twilio-auth-token
TWILIO_MEMORY_STORE_ID=your-memory-store-id
```

### Running the App

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

### Twilio Configuration

1. Start your server and ngrok tunnel
2. Configure your Twilio phone number webhook URL to:
   - Voice webhook: `https://your-url.ngrok-free.dev/voice`
   - Method: HTTP POST

## How It Works

1. **Incoming Call**: When a call comes in, the `/voice` endpoint receives the webhook
2. **Profile Lookup**: The app calls Twilio Memory's Lookup API with:
   - `idType: phone`
   - `value: caller's phone number`
3. **Personalization**: Retrieved profile data is used to personalize the conversation
4. **AI Conversation**: User speech is processed by OpenAI with context from their profile
5. **Response**: AI-generated response is spoken back to the caller

## API Endpoints

- `POST /voice` - Main voice webhook for incoming calls
- `POST /handle-input` - Processes user speech/DTMF input
- `POST /status-callback` - Receives call status updates
- `GET /health` - Health check endpoint

## Project Structure

- `server.js` - Main Express application
- `package.json` - Project metadata and dependencies
- `.env` - Environment variables (not committed)
- `defaultContext.md` - AI assistant context/instructions
- `defaultToolManifest.json` - Tool definitions for AI

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3001) |
| `SERVER_BASE_URL` | Your public server URL (ngrok) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | OpenAI model to use (default: gpt-4o) |
| `ACCOUNT_SID` | Twilio Account SID |
| `AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_MEMORY_STORE_ID` | Twilio Memory Store ID |
| `LLM_CONTEXT` | Path to context markdown file |
| `LLM_MANIFEST` | Path to tool manifest JSON file |

## License

MIT
