# Accent Changer

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
3. **Windows sound settings**: make your wired or USB headphones the **default playback device**. Sanas plays its audio through the default device, so a Bluetooth headset in call mode would cut the quality.
4. **Start the probe**: open PowerShell (or Windows Terminal) in the repo folder and run:

   ```
   node spike/serve.mjs
   ```

   Paste the key **once**, then press Enter. In Windows Terminal paste with Ctrl+V; in the classic blue PowerShell window, right-click. Nothing shows while you paste: that is on purpose. The server then says how many characters it got and whether **Sanas accepted the key**. If Sanas refused it, it asks again. The key stays in that window's memory only.
5. **Open** http://localhost:8080/spike/ in Edge. Use `localhost`, not `127.0.0.1`: the allowed origin must match exactly. Then go through the page:
   1. **Allow microphone**, then pick your headset mic and headphones.
   2. **Record** the whole script in one take (about a minute), with about one second of pause between lines.
   3. **Baseline first (free):** pick the **Mock** engine and press **Run** once. This measures your own laptop's audio path (it should show about 300 ms plus a little, and 0 gaps). Then switch back to **Sanas**.
   4. **Connect to Sanas**. If the model name differs from `AT5.2`, type the console's exact name.
   5. **Run** it three times, at different times of day, at both 16 kHz and 48 kHz.
   6. **Listen and rate** each line after each run. Tick a box only if it really is true. Every run keeps its own ratings.
   7. Try **Live** for a minute.
   8. Run **Stability** once (10 minutes, about $0.09).
   9. **Download results (JSON)** and send me that file. It has no audio. It holds the measurements, your ratings and notes, the settings with your device names, the browser version, the script text if you changed it, and the page log. The WAV download is your own voice: keep it on your PC.
6. Stop the server with Ctrl+C.

The GO/NO-GO rules are at the bottom of [spike/FINDINGS.md](spike/FINDINGS.md). If Sanas fails them, the fallback is Krisp's own app: step 7 of the page can measure its delay, and the delay of VB-CABLE itself.

## Troubleshooting

| You see | Do this |
|---|---|
| Server: "Sanas refused this key" | Paste it again, **once**. If it keeps being refused, check in the Sanas Console whether the key expired or was revoked, and create a new one only then. |
| Server: "Can't ask for the key here" | That window isn't an interactive terminal (for example Git Bash). Use PowerShell or Windows Terminal. |
| Server: "Port 8080 is already used" or "Windows does not let programs use port 8080" | Run `node spike/serve.mjs --port 8090` and add `http://localhost:8090` as an allowed origin. |
| "Origin not allowed" | In the Sanas Console, Allowed origins must contain exactly `http://localhost:8080`: no slash at the end, and `localhost` rather than an IP. |
| "Model not entitled" | Copy the exact model name from the console, including any suffix. |
| "The browser blocked the microphone for this page" | Click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload. The setting is per port: after `--port 8090`, allow it again. |
| "Windows blocked the microphone" or no microphones listed | Windows Settings → Privacy & security → Microphone: allow access, including "Let desktop apps access your microphone", then reload the page. |
| "Sanas answered, but no audio connection came up" | A firewall or VPN is blocking WebRTC (UDP). Try without the VPN, or on another network. |
| A run reports "dropped the call" | The connection to Sanas broke during the run. Note the time; if it happens again, try another network. |

## Privacy

- **API key:** only in the server's memory. It never reaches the browser, the disk or the logs.
- **Audio:** goes to Sanas Cloud (Ohio or Mumbai). Sanas says it is processed in real time and not stored.
- **Recordings and downloads:** stay on your PC (your Downloads folder). If you copy them into this folder, `.gitignore` keeps WAV files and `sanas-check-*.json` results out of git.

## Development

```
npm test               # unit tests (Node 20+, no install)
npm run test:browser   # the probe page in headless Chromium with a fake mic and the Mock engine (needs Playwright)
```

| Path | What |
|---|---|
| `spike/` | the Step 0 probe: `serve.mjs` (local server, key check, token exchange), `index.html` / `probe.js` (UI), `engines.js` (Sanas + Mock), `webrtc-stats.js`, `recorder.worklet.js` |
| `src/core/` | pure logic shared with the future app: `delay-estimate.js` (delay, gaps, bandwidth), `wav.js` |
| `src/vendor/` | the Sanas Browser SDK, unchanged (see its README for version and hashes) |
| `tests/` | `node --test` unit tests and the headless browser check |
