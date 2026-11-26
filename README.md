# Accent Changer

A small personal Windows tool. While you speak in an interview on Zoom, Teams or Meet, your microphone is converted live from an Indian-English accent to a US accent, in your own voice. It will use Sanas Accent Translation (AT5.2) and the free VB-CABLE virtual microphone.

**Status: Step 0.** Before the app is built, this repo's test page compares three options on your laptop:

- Sanas cloud: the engine our app would use.
- The Sanas desktop app: ready-made, with a 7-day free trial.
- Krisp: ready-made, with a 7-day free trial.

Results so far: [spike/FINDINGS.md](spike/FINDINGS.md).

## What to do, in order

1. **Part 1, now** (about 2 h, plus about 1 h 10 min unattended, about $1 of Sanas credit): test Sanas cloud with this page.
2. **Part 2, 5–6 days before your interview** (about 2 h): try Krisp and the Sanas desktop app, measure them with the same page, and ask a friend for a short listening test.
3. **Your interview:** use whichever ready-made app won Part 2 ([guide below](#your-interview-with-a-ready-made-app)). Our own app can't be ready in time.
4. **Send me the results file** (Download results (JSON)) after each part. With it we decide whether to build our own app.

The free trials last 7 days each. Starting them 5–6 days before the interview means they still run on interview day.

## Part 1: test Sanas cloud (now)

You need:

- Node.js 20 or newer: type `node --version` in PowerShell to check.
- Wired or USB headphones.
- Microsoft Edge or Chrome.

1. **Get this code:** `git clone` the repo, or on GitHub use **Code → Download ZIP** and unzip it.
2. **Sanas account** at [console.sanas.ai](https://console.sanas.ai). Sign up with your **personal Google account, not a work email**. It is self-serve, with $10 of free credit and no card. Then:
   - Create a project.
   - Create an **API key** with a **1-year** expiry, so the same key works in the app later. The key is shown only once: copy it into a password manager. Never paste it into a chat, an email or a file in this folder.
   - Under **Allowed origins**, add these three, exactly as written:
     - `http://localhost:8080` (this test page)
     - `http://tauri.localhost` (the future app)
     - `https://tauri.localhost` (the future app, backup)

     If the Console refuses one of them, write that in your notes.
   - Note the exact **Accent Translation model names** the Console shows, for example `AT5.2_Masculine` or `AT5.2_Feminine`. Use the one that matches your voice.
   - Set a monthly spend cap of $10.
3. **Windows sound settings:** make your wired or USB headphones the **default playback device**. Sanas plays its audio through the default device, so a Bluetooth headset in call mode would cut the quality.
4. **Start the test server:** open PowerShell (or Windows Terminal) in the repo folder and run:

   ```
   node spike/serve.mjs
   ```

   - **Paste the key once**, then press Enter. In Windows Terminal paste with Ctrl+V; in the classic blue PowerShell window, right-click.
   - Nothing shows while you paste: that is on purpose.
   - The server says how many characters it got and whether **Sanas accepted the key**. If Sanas refused it, the server asks again. The key stays in that window's memory only.
   - The server then checks, for free, which of the three addresses Sanas accepts, and prints one line for each. The page saves these lines in its results file.
5. **Open** http://localhost:8080/spike/ in Edge. Type `localhost`, not `127.0.0.1`: the allowed origin must match exactly. Then go through the page:
   1. **Allow microphone,** then pick your headset microphone and headphones.
   2. **Make the script yours:** in the script box, replace the example words with your own. Use your name, your past employers, your tech stack and the phrases you will really say in interviews. The words you say most are the ones that matter.
   3. **Record** the whole script in one take (about a minute), with about one second of pause between lines.
   4. **Baseline first (free):** pick the **Mock** engine and press **Run** once. This measures your own laptop's audio path. It should show about 300 ms plus a little, and 0 gaps. Then switch back to **Sanas**.
   5. **Model name:** type the exact name from the Console, then press **Connect to Sanas**.
   6. **Run** three times, at different times of day, at both 16 kHz and 48 kHz.
   7. **Listen and rate** each line after each run. Tick a box only if it really is true. Every run keeps its own ratings.
   8. **Live (two parts):**
      - First: press **Start live** and talk for a minute.
      - Then the **quiet test:** press Start live again, stay silent for 15 minutes (leave the room), come back, read a few lines, and press Stop. The page then says whether your converted voice came back after the quiet.
   9. **Stability:** set Minutes to **65** and press Start (about $0.60). Leave the PC plugged in and awake. You don't need to watch it.
   10. **Download results (JSON)** and send me that file. It has no audio. It holds:
       - the measurements, your ratings and your notes;
       - the settings, with your device names;
       - the browser version, and the script text if you changed it;
       - the address check and the page log.

       The WAV download is your own voice: keep it on your PC.
6. Stop the server with Ctrl+C.

## Part 2: compare the ready-made apps (5–6 days before your interview)

Do Part 2 in **one sitting, without reloading the page**. The page keeps the sound of your last 6 runs only while it stays open, and your friend listens to all of them at the end.

1. **Install and start both trials:**
   - **Sanas desktop app:** go to [sanas.ai/get-sanas](https://www.sanas.ai/get-sanas). For the number of agents choose 0–49, then **Start your 7-day trial**. Install it.
     - Make your **voice profile** (Personalization): read the text it shows, so it keeps your own voice.
     - Set your headset microphone as its microphone, and turn on **Accent Translation** to US English.
   - **Krisp:** install it from [krisp.ai](https://krisp.ai) and start the free trial. Set your headset microphone as its microphone, and turn on its accent conversion for **your** voice (the speaker side).
2. **Start the test server and the page** as in Part 1, and paste the Sanas key: step 3 needs it.
3. **Record the script** (step 2) and do **one Sanas cloud run** at 48 kHz (step 3). That gives your friend all three engines in one sitting.
4. **For each app, in step 7 of the page:**
   1. Pick the app's microphone as **Other microphone**, for example "Krisp Microphone". The Sanas one has "Sanas" in its name.
   2. Press **Read the script**, read the whole script aloud with a short pause between lines, then press **Stop**.
   3. Rate the run in step 4, exactly like the Sanas runs.
   4. **CPU check:** keep the app on, open Task Manager → Performance, and join a 5-minute Zoom test call with video (zoom.us/test). Note the highest CPU % in the Notes box: "Krisp: 45 %".
5. **Blind listening test with a friend** (about 15 minutes). Ask a friend who knows your voice. For each run, in turn:
   1. Pick the run in step 4 under **Run to rate and play**.
   2. Play 5 lines with **▶ converted**. Don't show the script.
   3. Your friend says what they heard and whether it sounds like you.
   4. Enter the number of lines with **every word right**, and the number that **sound like you**.
6. **Download results (JSON)** and send it to me.

## Your interview with a ready-made app

Use the app that won Part 2: the best ratings, every word right, and a delay that is not much higher.

**Set it up once (about 45 minutes):**

1. **In the app:** your headset is its microphone, and accent conversion is on.
2. **In Zoom, Teams or Meet:** pick the app's microphone, for example "Krisp Microphone", as your microphone. Don't pick your headset.
3. **Lip sync** (your camera is on). The converted voice is a little late, so the video is delayed by the same amount:
   1. Install OBS Studio from [obsproject.com](https://obsproject.com).
   2. Under Sources: **+** → **Video Capture Device** → your webcam.
   3. Right-click it → **Filters** → **+** under Audio/Video Filters → **Video Delay (Async)**. Set the delay to the app's **Delay ms** from the page's table (the read-aloud run).
   4. Click **Start Virtual Camera**. In the meeting app, choose the camera **OBS Virtual Camera**.
4. **Practice call:**
   1. Join a test meeting from your phone as a second participant (muted, with earphones), and record the call.
   2. Clap once in front of the camera, then say a few sentences.
   3. Watch the recording:
      - If you hear the clap before the hands meet, lower the OBS delay by 20 ms.
      - If the hands meet before you hear it, raise it by 20 ms.

**On the day:**

1. Plug in the charger. Use a cable to the internet if you can.
2. Start the app and OBS's virtual camera.
3. On the meeting's pre-join screen, check that:
   - the microphone is the app's;
   - its level moves when you speak;
   - the video shows you.
4. Share one window, never the whole screen.
5. **Tell the interviewer** in one sentence: "I use a real-time accent-clarity tool on my mic; the words and the voice are mine, and I'm happy to turn it off."
   - If the company's rules forbid AI tools, don't use it, or ask the recruiter first.
   - Never use it in a proctored or recorded assessment.
6. **If something goes wrong** during the call, switch the meeting's microphone back to your headset:
   - in Zoom, the **^** next to Mute;
   - in Teams or Meet, the arrow next to the microphone button.

   Then switch the camera back to your webcam.

## Troubleshooting

| You see | Do this |
|---|---|
| Server: "Sanas refused this key" | Paste it again, **once**. If it keeps being refused, check in the Sanas Console whether the key expired or was revoked, and create a new one only then. |
| Server: "Can't ask for the key here" | That window isn't an interactive terminal (for example Git Bash). Use PowerShell or Windows Terminal. |
| Server: "Port 8080 is already used" or "Windows does not let programs use port 8080" | Run `node spike/serve.mjs --port 8090` and add `http://localhost:8090` as an allowed origin. |
| Server: "Sanas refused this page's own address" or "refused both app addresses" | Add the addresses under Allowed origins exactly as listed in Part 1 (no slash at the end), then restart the server. |
| Page: "Origin not allowed" | In the Sanas Console, Allowed origins must contain exactly `http://localhost:8080`: no slash at the end, and `localhost` rather than an IP. |
| "Model not entitled" | Copy the exact model name from the Console, including any suffix. |
| "The browser blocked the microphone for this page" | Click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload. The setting is per port: after `--port 8090`, allow it again. |
| "Windows blocked the microphone" or no microphones listed | Windows Settings → Privacy & security → Microphone: allow access, including "Let desktop apps access your microphone", then reload the page. |
| "Sanas answered, but no audio connection came up" | A firewall or VPN is blocking WebRTC (UDP). Try without the VPN, or on another network. |
| A run reports "dropped the call" | The connection to Sanas broke during the run. Note the time; if it happens again, try another network. |
| Step 7: the other microphone "is silent" or "stayed silent" | The app must be running, with your headset as its microphone and accent conversion on. Some apps convert only while a call app uses their microphone: the page counts as one. |

## Privacy

- **API key:** only in the server's memory. It never reaches the browser, the disk or the logs.
- **Audio:** goes to Sanas Cloud (Ohio or Mumbai). Sanas says it is processed in real time and not stored. The desktop apps process audio on your laptop.
- **Recordings and downloads:** stay on your PC (your Downloads folder). If you copy them into this folder, `.gitignore` keeps WAV files and `sanas-check-*.json` results out of git.

## Development

```
npm test               # unit tests (Node 20+, no install)
npm run test:browser   # the probe page in headless Chromium with a fake mic and the Mock engine (needs Playwright)
```

| Path | What |
|---|---|
| `spike/` | The Step 0 probe:<ul><li>`serve.mjs`: local server, key check, Sanas address check, token exchange</li><li>`index.html` / `probe.js`: the UI</li><li>`engines.js`: Sanas and Mock</li><li>`webrtc-stats.js`, `recorder.worklet.js`</li></ul> |
| `src/core/` | Pure logic shared with the future app: `delay-estimate.js` (delay, gaps, bandwidth), `wav.js` |
| `src/vendor/` | The Sanas Browser SDK, unchanged (see its README for version and hashes) |
| `tests/` | `node --test` unit tests and the headless browser check |
