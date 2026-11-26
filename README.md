# AccentSwitch

A small personal Windows tool: while you speak in an interview on Zoom, Teams or Meet, your microphone is converted live from an Indian-English accent to a US accent, in your own voice. It will use Sanas Accent Translation (AT5.2) and the free VB-CABLE virtual microphone.

**Status: Step 0, checking Sanas before building the app.** This repo holds a probe page that measures whether Sanas is good and fast enough: delay, gaps, sound quality and stability. Results so far: [spike/FINDINGS.md](spike/FINDINGS.md).

## Step 0 on your Windows laptop (about 1 hour, about $0.30 of Sanas credit)

You need Node.js 20 or newer (`node --version` in PowerShell), wired or USB headphones, and Microsoft Edge or Chrome.

1. **Get this code**: `git clone` the repo, or on GitHub use **Code → Download ZIP** and unzip it.
2. **Sanas account** at [console.sanas.ai](https://console.sanas.ai). Sign-up is self-serve, with $10 of free credit and no card needed. Then:
   - Create a project.
   - Create an **API key** (expiry 30 or 90 days). It is shown only once, so copy it into a password manager. Never paste it in a chat, an email or a file in this folder.
   - In the project's **Allowed origins** add exactly `http://localhost:8080`.
   - Note the exact **Accent Translation model name** the console shows (for example `AT5.2`, perhaps with a suffix).
   - Optional: set a monthly spend cap, for example $5.
3. **Start the probe**: open PowerShell in the repo folder and run:

   ```
   node spike/serve.mjs
   ```

   Paste the key when asked and press Enter. Nothing appears while you paste: that is on purpose. If Ctrl+V does nothing, right-click to paste. The key stays in memory only.
4. **Open** http://localhost:8080/spike/ in Edge. Use `localhost`, not `127.0.0.1`: the allowed origin must match exactly. Then go through the page:
   1. **Allow microphone**, then pick your headset mic and headphones.
   2. **Connect to Sanas**. If the model name differs from `AT5.2`, type the console's exact name.
   3. **Record** the script: one take, about one second of pause between lines.
   4. **Run** it three times, at different times of day, at both 16 kHz and 48 kHz.
   5. **Listen and rate** each line. Tick a box only if it really is true.
   6. Try **Live** for a minute.
   7. Run **Stability** once (10 minutes, about $0.09).
   8. **Download results (JSON)** and send me that file. It holds numbers and settings only. The WAV download is your own voice: keep it on your PC.
5. Stop the server with Ctrl+C.

The GO/NO-GO rules are at the bottom of [spike/FINDINGS.md](spike/FINDINGS.md). If Sanas fails them, the fallback is Krisp's own app: step 7 of the page can measure its delay.

## Troubleshooting

| You see | Do this |
|---|---|
| "Origin not allowed" | In the Sanas console, Allowed origins must contain exactly `http://localhost:8080`: no slash at the end, and `localhost` rather than an IP. |
| "Model not entitled" | Copy the exact model name from the console, including any suffix. |
| "Token request failed (HTTP 401/403)" | The key is wrong, expired or revoked. Create a new one and restart the server. |
| "Port 8080 is busy" | Run `node spike/serve.mjs --port 8090` and add `http://localhost:8090` as an allowed origin. |
| No microphones listed | Windows Settings → Privacy & security → Microphone: allow access, including for desktop apps, then reload the page. |
| Run starts, but no converted audio | A firewall or VPN may block WebSockets on port 7443 or WebRTC (UDP). Try without the VPN, or on another network. |

## Privacy

- **API key:** only in the server's memory. It never reaches the browser, the disk or the logs.
- **Audio:** goes to Sanas Cloud (Ohio or Mumbai). Sanas says it is processed in real time and not stored.
- **Recordings and downloads:** stay on your PC, and `.gitignore` keeps WAV files out of git.

## Development

```
npm test               # unit tests (Node 20+, no install)
npm run test:browser   # the probe page in headless Chromium with a fake mic and the Mock engine (needs Playwright)
```

| Path | What |
|---|---|
| `spike/` | the Step 0 probe: `serve.mjs` (local server + token exchange), `index.html` / `probe.js` (UI), `engines.js` (Sanas + Mock), `webrtc-stats.js`, `recorder.worklet.js` |
| `src/core/` | pure logic shared with the future app: `delay-estimate.js` (delay, gaps, bandwidth), `wav.js` |
| `src/vendor/` | the Sanas Browser SDK, unchanged (see its README for version and hashes) |
| `tests/` | `node --test` unit tests and the headless browser check |
