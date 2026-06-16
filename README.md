# Medivance Server (API)

Express + MySQL backend for the Medivance ERP system. Deploy on [Railway](https://railway.app).

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Import `schema.sql` into MySQL before first run.

## Railway

- Root directory: `/` (this repo root)
- Start command: `npm start`
- Health check: `GET /api/health`

Set `CLIENT_URL` to your Vercel frontend URL. See `.env.example` for all variables.
