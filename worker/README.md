# AI tutor for Budget Copilot (free, with Google Gemini)

The chat bubble on the site talks to a small Cloudflare Worker. The Worker keeps your Gemini API key
secret (never put a key in the site itself: GitHub Pages is public, anyone could copy it) and asks for
an access code, so the tutor stays yours. Both services are free: no card needed.

## 1. Get a free Gemini API key
1. Go to https://aistudio.google.com and sign in with your Google account.
2. "Get API key" → "Create API key". Copy it.
   Do not link a billing account: without billing you stay on the free tier and can never be charged.

## 2. Create the Worker (5 minutes, Cloudflare free plan)
1. Create a free account on https://dash.cloudflare.com
2. Workers & Pages → Create → Create Worker → name it `budget-copilot-tutor` → Deploy.
3. Edit code → delete everything → paste the whole content of `worker.js` → Deploy.
4. Settings → Variables and Secrets → add two **Secrets**:
   - `GEMINI_API_KEY` = your key
   - `ACCESS_CODE` = a password you choose (you will type it once in the bubble)
   Then Deploy.
5. Copy the Worker address, like `https://budget-copilot-tutor.yourname.workers.dev`.
   Open it in the browser: it should say "Budget Copilot AI tutor is running."

## 3. Connect the site
Open `config.js` at the root of the repo and paste the address:

```js
window.BC_CHAT_URL = 'https://budget-copilot-tutor.yourname.workers.dev';
```

Commit and push. Open the bubble on https://styl1st.github.io/Budget-Copilot/, ask a question,
type your access code when asked. The browser remembers it.

## Good to know
- Models: `gemini-3.8-flash` first; when its free daily quota is used up, the Worker switches to
  `gemini-3.5-flash-lite`, which has a much bigger free quota. Change them with the variables `MODEL`
  and `FALLBACK_MODEL`. Your real limits are shown in Google AI Studio; they reset every day.
- Google's free tier is meant for your own use: its terms reserve apps offered to other users in the
  EU/UK/Switzerland to the paid tier. Keep the access code to yourself.
- Do not paste anything personal or confidential in the chat.
- Only `https://styl1st.github.io` may call the Worker. To test locally, add a variable
  `ALLOWED_ORIGINS` = `https://styl1st.github.io,http://localhost:8000`.
- The tutor's course knowledge is the `SYSTEM` text at the bottom of `worker.js`: edit it to add notes.
