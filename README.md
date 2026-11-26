# Accent Changer

A small personal Windows tool. While you speak in an interview on Zoom, Teams or Meet, your microphone is converted live from an Indian-English accent to a US accent, in your own voice. It will use Sanas Accent Translation (AT5.2) and the free VB-CABLE virtual microphone.

**Status: Step 0.** Before the app is built, this repo's test page compares three options on your laptop:

- Sanas cloud: the engine our app would use.
- The Sanas desktop app: ready-made, with a 7-day free trial.
- Krisp: ready-made, with a 7-day free trial.

Results so far: [spike/FINDINGS.md](spike/FINDINGS.md).

## What to do, in order

1. **Part 1, now:** test Sanas cloud with this page. It takes about 2 hours of your time over 2–3 sittings, plus about 1 h 20 min of runs you don't need to watch, and about $1 of Sanas credit.
2. **Part 2, 5–6 days before your interview** (about 2 hours): try Krisp and the Sanas desktop app with the same page, and ask a friend for a short blind listening test.
3. **Your interview:** follow [INTERVIEW.md](INTERVIEW.md) with the app that passes its bar. Our own app can't be ready in time.
4. **Send me the results file** after every sitting.

Two rules for every sitting:

- **Download results (JSON) before you close the page.** Runs, ratings and notes live only in the open page. Each file has its own time stamp, so send all of them.
- **Keep the page open in its own tab until you have downloaded.** Don't reload it, and open other sites (Zoom, Meet) in a new tab (Ctrl+T). The page remembers your script text, model name, sample rate and devices, but not your recording, runs, ratings or notes. If you try to leave it, Edge asks "Leave site?": choose **Cancel**.

The free trials last 7 days each. Starting them 5–6 days before the interview means they still run on interview day.

## Before you start (once)

1. **Node.js 20 or newer.** Open PowerShell (Start menu → type `PowerShell` → Enter), then type `node --version`. If it says "not recognized", or shows a version below 20, install the **LTS** version from [nodejs.org](https://nodejs.org) (Windows Installer). Then open a **new** PowerShell window.
2. **Get this code.** On GitHub use **Code → Download ZIP** and unzip it.
3. **Open a terminal in the right folder.** In File Explorer, open the folder that holds `README.md` and the `spike` folder. After unzipping it is often `accent_changer-main` inside another `accent_changer-main`. Click that window's address bar, type `powershell` and press Enter. This works on Windows 10 and 11.
4. **Headphones:** make your wired or USB headphones the **default playback device** in Windows sound settings. Sanas plays its audio through the default device, so a Bluetooth headset in call mode would cut the quality.

## Part 1: test Sanas cloud (now)

1. **Sanas account** at [console.sanas.ai](https://console.sanas.ai). Sign up with your **personal Google account, not a work email**. It is self-serve, with $10 of free credit and no card. Then:
   - Create a project.
   - Create an **API key** with a **1-year** expiry, or the longest one offered, so the same key works in the app later. The key is shown only once: copy it into a password manager. Never paste it into a chat, an email or a file in this folder.
   - Under **Allowed origins**, add these three, exactly as written:
     - `http://localhost:8080` (this test page)
     - `http://tauri.localhost` (the future app)
     - `https://tauri.localhost` (the future app, backup)

     If the Console refuses one of them, write that in your notes.
   - Note the exact **Accent Translation model names** the Console shows. If you see `AT5.2_Masculine` and `AT5.2_Feminine`, use the one that matches your voice.
   - Set a monthly spend cap of $10.
2. **Start the test server** in your terminal:

   ```
   node spike/serve.mjs
   ```

   - **Paste the key once**, then press Enter. In Windows Terminal paste with Ctrl+V; in the classic blue PowerShell window, right-click.
   - Nothing shows while you paste: that is on purpose.
   - The server says how many characters it got and whether **Sanas accepted the key**. If Sanas refused it, the server asks again. The key stays in that window's memory only.
   - The server then checks, for free, whether Sanas accepts each of your three addresses. It also checks one made-up test address, which Sanas must refuse; don't add that one anywhere. It prints one line for each, and the page saves them in its results.
   - Don't click inside that window while it runs: in the classic window, a click pauses the server until you press Esc.
3. **Open** http://localhost:8080/spike/ in Edge. Type `localhost`, not `127.0.0.1`: the allowed origin must match exactly. Then go through the page:
   1. **Allow microphone,** then pick your headset microphone and headphones.
   2. **Make the script yours.** Replace the 15 example sentences with 15 of your own: your name, your past employers, your tech stack, and the phrases you will really say in interviews. Keep 15 lines, because the blind test in Part 2 plays 5 different lines from each of 3 runs. The page remembers your script.
   3. **Record** the whole script in one take (about 1.5 minutes), with about **one second of pause** between lines.
   4. **Baseline first (free).** Pick the **Mock** engine and press **Run** once. This measures your own laptop's audio path. It should show about 300 ms plus a little, and 0 gaps. Then switch back to **Sanas**.
   5. **Model name:** type the exact name from the Console, then press **Connect to Sanas**.
   6. **Three runs** at different times of day: two with Sample rate 16 kHz and one with 48 kHz (Sample rate is in step 1).

      **In a later sitting:** start the server again (step 2), open the page, press **Allow microphone**, and **Record** the script again (3.3). The page keeps the script's text, not the recording, so Run stays grey until you record. Download the results at the end of every sitting.
   7. **Rate each run right after it.** In step 4, for every line, tick a box only if it really is true: sounds natural, still my voice, every word right, sounds American. The score stays "–" until you tick something.
   8. **Live:** press **Start live** and talk for a minute, then Stop.
   9. **Quiet test:**
      1. Press Start live again.
      2. Stay silent for 15 minutes; leave the room.
      3. Come back, put the headset on, and start reading the script right away. Read for about a minute, then press Stop.

      The page then says whether your converted voice came back at once. A cough or a knock on the headset doesn't count as speaking.
   10. **Stability:** set Minutes to **65** and press Start (about $0.60). Leave the PC plugged in and awake; you don't need to watch it.
   11. **Download results (JSON)** and send me the file. It has no audio. It holds:
       - the measurements, your ratings and your notes;
       - the settings, with your device names;
       - the browser version, and the script text if you changed it;
       - the address check and the page log.

       The WAV download is your own voice: keep it on your PC.
4. Stop the server with Ctrl+C.

## Part 2: compare the ready-made apps (5–6 days before your interview)

**Any day before Part 2 (10 minutes):** open both trial sign-up pages without starting a trial. Note:
- what each asks for (a card? a work email? a sales call?);
- the price after the trial;
- how many minutes a day of accent conversion the trial gives.

If a card is needed, set a reminder to cancel.

Do Part 2 in **one sitting, without reloading the page**. The page keeps the sound of only the last 6 runs, and only while it stays open; your friend listens to all of them at the end.

1. **Install and start both trials:**
   - **Sanas desktop app:** go to [sanas.ai/get-sanas](https://www.sanas.ai/get-sanas). For the number of agents choose 0–49, then **Start your 7-day trial**. Install it.
     - Make your **voice profile** (Personalization): read the text it shows, so it keeps your own voice.
     - Set your headset microphone as its microphone, and turn on **Accent Translation** to US English.
     - Turn off any meeting-notes, transcription or recording features.
   - **Krisp:** install it from [krisp.ai](https://krisp.ai) and start the free trial.
     - Set your headset microphone as its microphone.
     - Turn on accent conversion **for your microphone**: what others hear from you. Don't use the option for voices you hear.
     - In its settings, turn off the AI Note Taker's automatic activation, and any transcription or recording.
2. **Start the server and the page** as in Part 1, and paste the Sanas key: step 3 needs it. In step 1 of the page, check four things:
   - your headset microphone;
   - your headphones;
   - the model name;
   - Sample rate **48 kHz**.
3. **Record your script** (step 2). Do **one Sanas cloud run** (step 3), and rate it in step 4 like the Part 1 runs.
4. **For each app, in step 7 of the page:**
   1. **Start this app** (again, if you quit it earlier), with accent conversion on, and **quit the other one** (its tray icon → Quit).
   2. Pick the app's microphone as **Other microphone**, for example "Krisp Microphone". The Sanas one has "Sanas" in its name.
   3. Press **Read the script**. Read the whole script aloud with about one second of pause between lines, then press **Stop**. The page listens 3 more seconds for the app's last words.
   4. **Check that it really converts:** in step 4, play line 1 with **▶ original**, then **▶ converted**.
      - If the accent did not change, conversion is off: fix the app and read again.
      - A delay far below the app's own claim (Krisp says about 200 ms) is a warning sign.
   5. Rate the run in step 4.
   6. **Write down the app's delay** (Delay ms, in step 3's table) in the Notes box and on paper: OBS needs it later. A red number in that table fails the bar in INTERVIEW.md.
   7. **CPU check,** with the charger plugged in and Power mode on **Best performance** (Windows Settings → System → Power), as on the interview day:
      1. Open zoom.us/test **in a new tab** (Ctrl+T), join the test call with video, and pick the app's microphone in Zoom.
      2. Talk for 2 minutes.
      3. Note the usual **Utilization** in Task Manager → Performance → CPU, not a short spike.
      4. Turn the app's accent conversion off and note it again.

      Write both in Notes, for example "Krisp: 35 % (off: 25 %)".
5. **Blind test with a friend** (about 15 minutes). Ask a friend who knows your voice and who was out of the room while you read. Start with an app run, not the Sanas cloud run. For each run, in turn:
   1. Pick the run in step 4 under **Run to rate and play**.
   2. Play 5 lines with the small **▶ converted** buttons, not the big ▶ Converted button (that one plays the whole run). Use lines 1–5 for the first run you play, 6–10 for the second, and 11–15 for the third. Don't show the script.
   3. Your friend says what they heard, whether it sounds like you, and whether it sounds American.
   4. Enter **Lines played**, then the counts: every word right, sound like you, sound American.

   Do the blind test before redoing any run, and check that the picker still lists all three runs.
6. **Download results (JSON)** and send it to me.

Then go to [INTERVIEW.md](INTERVIEW.md): it says when an app is good enough to use, and how to set it up. I'll also tell you from your results.

## Troubleshooting

| You see | Do this |
|---|---|
| `node` "is not recognized" | Install Node.js (see "Before you start"), then open a new terminal window. |
| "Cannot find module … spike\serve.mjs" | The terminal is in the wrong folder: open it in the folder that holds `README.md` and `spike`. |
| Server: "Sanas refused this key" | Paste it again, **once**. If it keeps being refused, check in the Sanas Console whether the key expired or was revoked, and create a new one only then. |
| Server: "Can't ask for the key here" | That window isn't an interactive terminal (for example Git Bash). Use PowerShell or Windows Terminal. |
| Server: "Port 8080 is already used" or "Windows does not let programs use port 8080" | Run `node spike/serve.mjs --port 8090` and add `http://localhost:8090` as an allowed origin. |
| Server: "Sanas refused this page's own address" or "refused both app addresses" | Add the addresses under Allowed origins exactly as listed in Part 1 (no slash at the end), then restart the server. |
| Server: "Address check skipped" or "Inconclusive" | Do what that line says: "could not be checked" needs a restart of the server, a refused key needs a working key. If it stays like that, write it in your notes. |
| The server stopped answering | In the classic window, press Esc (a click inside it pauses the server). |
| Page: "Origin not allowed" | In the Sanas Console, Allowed origins must contain exactly `http://localhost:8080`: no slash at the end, and `localhost` rather than an IP. |
| "Model not entitled" | Copy the exact model name from the Console, including any suffix. |
| "The browser blocked the microphone for this page" | Click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload. The setting is per port: after `--port 8090`, allow it again. |
| "Windows blocked the microphone" or no microphones listed | Windows Settings → Privacy & security → Microphone: allow access, including "Let desktop apps access your microphone", then reload the page. |
| "Sanas answered, but no audio connection came up" | A firewall or VPN is blocking WebRTC (UDP). Try without the VPN, or on another network. |
| A run reports "dropped the call" | The connection to Sanas broke during the run. Note the time; if it happens again, try another network. |
| Run (step 3) or Start (step 6) is grey | Record the script first (step 2). A reopened page has the text but no recording. |
| Edge asks "Leave site?" | Choose **Cancel**, then download the results first. Leaving loses the runs, ratings and recording. |
| Step 4 shows far fewer lines than your script has | You paused too briefly between lines: record or read again with about one second of pause. |
| Step 7: the other microphone "is silent" or "stayed silent" | The app must be running, with your headset as its microphone and accent conversion on. Some apps convert only while a call app uses their microphone: the page counts as one. |

## Privacy

- **API key:** only in the server's memory. It never reaches the browser, the disk or the logs.
- **Audio:** goes to Sanas Cloud (Ohio or Mumbai). Sanas says it is processed in real time and not stored.
- **Krisp and the Sanas desktop app:** their vendors say accent conversion runs on your laptop. Their meeting-notes features upload transcripts, so keep those off.
- **Recordings and downloads:** stay on your PC (your Downloads folder). If you copy them into this folder, `.gitignore` keeps WAV files and `sanas-check-*.json` results out of git.

## Development

```
npm test               # unit tests (Node 20+, no install)
npm run test:browser   # the probe page in headless Chromium with fake microphones and the Mock engine (needs Playwright)
npm run test:app       # the app's page in Edge dev mode, the same way
cd src-tauri && cargo test   # the app's Rust side
```

| Path | What |
|---|---|
| `spike/` | The Step 0 probe:<ul><li>`serve.mjs`: local server, key check, Sanas address check, token exchange</li><li>`index.html` / `probe.js`: the UI</li><li>`engines.js`: Sanas and Mock</li><li>`quiet-test.js`: the quiet test's rules</li><li>`webrtc-stats.js`, `recorder.worklet.js`</li></ul> |
| `src/` | The app's page (no bundler): `index.html`, `main.js`, `engines/`, `platform/`, and `core/`, the pure logic shared with the probe |
| `src-tauri/` | The app's Rust side (Tauri 2): key in Windows Credential Manager, token exchange, window and microphone rules |
| `src/vendor/` | The Sanas Browser SDK, unchanged (see its README for version and hashes) |
| `tests/` | `node --test` unit tests and the headless browser checks |
