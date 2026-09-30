# FAQ / Payment Code

A Help Scout sidebar app for pulling Ops email templates out of Airtable. It replaces the Payment Code & FAQ Chrome extension.

It is deliberately separate from the guest panel (`helpscoutapp`): its own repo, its own Vercel project and its own Airtable token. Either can be changed or redeployed without touching the other.

## What it does

- Accepts the extension's commands: `LOULAU2531.CONF`, `LOULAU2531.RESTS`, `DREVUX.STA`, `FAQ.RESTS`, `CODE.morocco`, `HELP`.
- Lists the current guest's live payment codes as buttons, read from the conversation's email address.
- Shows the email exactly as it will paste, warns about any `{{placeholder}}` it could not fill, and copies with formatting.
- Only reads from Airtable. The token stays in Vercel and never reaches the browser.

## Setup

1. Create a read-only Airtable token for this app (see `.env.example` for scopes).
2. Import this repo into Vercel as a new project. Vercel detects Vite; no build settings are needed.
3. In the Vercel project, add `AIRTABLE_API_KEY` under Settings > Environment Variables, then redeploy.
4. In Help Scout, go to **Workspace → Apps** (left sidebar) and click **Create**. Name it **FAQ/Payment Code App**, set its callback URL to the Vercel production URL, and give it a long random secret key — keep a copy, as request verification will need it. Not **My Apps** under your profile: that only issues API credentials and cannot add anything to the sidebar.
5. Enable it for the mailboxes the BMs work in. Help Scout shows it as its own card in the sidebar.

## Local development

```bash
npm install
```

```bash
npm run dev
```

Put the token in a `.env` file (never committed), then open `/?email=guest@example.com` to load a guest without Help Scout.

## Files

- `api/templates.js` — the server route. Looks up bookings, leads and FAQ records.
- `lib/templateRender.js` — command parsing, placeholder filling and paste formatting. No Airtable calls, so it can be tested on its own.
- `src/App.jsx` — the sidebar UI.
