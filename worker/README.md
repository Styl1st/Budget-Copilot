# AI tutor for Budget Copilot (free, with Google Gemini)

The chat bubble on the site talks to a small Cloudflare Worker (`worker.js`). The Worker adds the
course knowledge, calls Gemini and streams the answer back. API keys never go in the site itself:
GitHub Pages is public, anyone could copy them. Both services are free, no card needed.

Two ways to unlock the bubble:
- **Your own Gemini key** (for friends): each person pastes their free key in the bubble. It stays in
  their browser, the Worker only uses it for their request and never stores it. Everyone gets their
  own free quota.
- **The access code** (for you): you type the code you chose, and the Worker uses your key
  (`GEMINI_API_KEY`).

## 1. Deploy the Worker from GitHub (what this repo is set up for)
1. Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick `Budget-Copilot`.
   Keep the name `budget-copilot`, keep the default deploy command (`npx wrangler deploy`).
2. The file `wrangler.jsonc` at the root of the repo tells Cloudflare to deploy **only**
   `worker/worker.js`. Every `git push` redeploys it.
3. Check: open `https://budget-copilot.<your-subdomain>.workers.dev`. It must say
   "Budget Copilot AI tutor is running." If you see the site instead, the build did not use
   `wrangler.jsonc`: Workers & Pages → budget-copilot → Deployments shows the build log.

## 2. Add your key and your code (optional but recommended)
1. https://aistudio.google.com → "Get API key" → "Create API key". Do not link a billing account:
   without billing you stay on the free tier and can never be charged.
2. Cloudflare → budget-copilot → Settings → Variables and Secrets → add two **Secrets**:
   - `GEMINI_API_KEY` = your key
   - `ACCESS_CODE` = a password you choose
   Without them the tutor still works for anyone who pastes their own key.

## 3. Connect the site
`config.js` at the root of the repo holds the Worker address:

```js
window.BC_CHAT_URL = 'https://budget-copilot.<your-subdomain>.workers.dev';
```

## 4. Share with friends
Send them https://styl1st.github.io/Budget-Copilot/. Lessons, cases, games and the mock exam work
for everyone, and progress is saved in each person's own browser. For the chat, they click
"Get a key in 1 minute" in the bubble, create their free key, paste it, done.

## Good to know
- Models: `gemini-3.8-flash` first; when its free daily quota is used up, the Worker switches to
  `gemini-3.5-flash-lite`, which has a much bigger free quota. Change them with the variables `MODEL`
  and `FALLBACK_MODEL`. Real limits are shown in Google AI Studio; they reset every day.
- Google's free tier terms reserve apps offered to other users in the EU/UK/Switzerland to the paid
  tier. That is why friends use their own key instead of your access code.
- Gemini API users must be 18 or older. Do not paste anything personal or confidential in the chat.
- Only `https://styl1st.github.io` may call the Worker. To test locally, add a variable
  `ALLOWED_ORIGINS` = `https://styl1st.github.io,http://localhost:8000`.
- The tutor's course knowledge is the `SYSTEM` text at the bottom of `worker.js`: edit it to add notes.
