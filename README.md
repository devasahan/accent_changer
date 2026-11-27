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
4. **When I say the app's test build is ready** (about 15 minutes, any day): [Session A2](#session-a2-try-the-apps-test-build-about-15-minutes) below.
5. **When I say the Session B build is ready** (about 2 hours in all, about 50 minutes of it with you): [Session B](#session-b-your-voice-into-the-meeting-about-2-hours) below.
6. **Send me the results file** after every sitting.

Two rules for every sitting:

- **Download results (JSON) before you close the page.** Runs, ratings and notes live only in the open page. Each file has its own time stamp, so send all of them.
- **Keep the page open in its own tab until you have downloaded.** Don't reload it, and open other sites (Zoom, Meet) in a new tab (Ctrl+T). The page remembers your script text, model name, sample rate and devices, but not your recording, runs, ratings or notes. Once it holds any of them, Edge asks "Leave site?" or "Reload site?" every time you leave or reload the page, even right after a download. If a step is still running, choose **Cancel**. If you changed anything since you last downloaded the results (a run, a rating, a blind-test count or a note), choose **Cancel** and download first. Otherwise choose **Leave** (or **Reload**).

The free trials last 7 days each. Starting them 5–6 days before the interview means they still run on interview day.

## Before you start (once)

1. **Node.js 20 or newer.** Open PowerShell (Start menu → type `PowerShell` → Enter), then type `node --version`. If it says "not recognized", or shows a version below 20, install the **LTS** version from [nodejs.org](https://nodejs.org) (Windows Installer). Then open a **new** PowerShell window.
2. **Get this code.** On GitHub use **Code → Download ZIP** and unzip it.
3. **Open a terminal in the right folder.** In File Explorer, open the folder that holds `README.md` and the `spike` folder. After unzipping it is often `accent_changer-main` inside another `accent_changer-main`. Click that window's address bar, type `powershell` and press Enter. This works on Windows 10 and 11.
4. **A wired or USB headset, not Bluetooth:** headphones with a microphone that plug into the laptop's headphone jack (like the earphones with a microphone that came with older phones) or into a USB port. Make its headphones the **default playback device** in Windows sound settings: Sanas plays its audio through the default device. A Bluetooth headset switches to call mode when its microphone is on: the sound gets worse both ways, it can cut out, and it adds a delay of its own that varies, so lips and voice can't be matched. If you only have a Bluetooth headset, get a basic wired or USB one before you record in Part 1.

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
      3. Come back, sit down and put the headset on. Count to ten in your head, without a sound. Then read the script aloud for about a minute, and press Stop.

      The page then says, next to the Stop button and at the top of the page, how long you were silent and whether your converted voice came back at once, for example: "Quiet test: after 15.0 min of silence the converted voice came back at once." It should say about 15 min. If it says less than 14 min, or nothing about a quiet test, something broke the silence: do the quiet test again. A cough, or putting the headset on, doesn't count as speaking. If it says late, write in Notes whether you made a noise, breathed on the microphone, or skipped the count to ten, before you started reading.
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

Do Part 2 in **one sitting, without reloading the page**. The page keeps the sound of only the last 6 runs, and only while it stays open; your friend listens to them at the end.

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
   7. **CPU check,** with the charger plugged in and Power mode on **Best performance**, as on the interview day. Set it while plugged in: on Windows 11, Windows Settings → System → **Power & battery** → Power mode; on Windows 10, click the battery icon at the right of the taskbar and drag the slider to **Best performance**. Then:
      1. Open zoom.us/test **in a new tab** (Ctrl+T), join the test call with video, and pick the app's microphone in Zoom.
      2. Talk for 2 minutes.
      3. Note the usual **Utilization** in Task Manager → Performance → CPU, not a short spike.
      4. Turn the app's accent conversion off and note it again.

      Write both in Notes, for example "Krisp: 35 % (off: 25 %)".
5. **Blind test with a friend** (about 15 minutes). Ask a friend who knows your voice and who was out of the room while you read. Play three runs: the Sanas cloud run and one read-aloud run of each app. If you read an app more than once (or did the Sanas cloud run twice), the picker shows those runs under the same app name: play only the last one, the one with the highest Run number. Start with an app run, not the Sanas cloud run. For each of the three runs, in turn:
   1. Pick the run in step 4 under **Run to rate and play**.
   2. Play 5 lines with the small **▶ converted** buttons, not the big ▶ Converted button (that one plays the whole run). Use lines 1–5 for the first run you play, 6–10 for the second, and 11–15 for the third. Don't show the script.
   3. Your friend says what they heard, whether it sounds like you, and whether it sounds American.
   4. Enter **Lines played**, then the counts: every word right, sound like you, sound American.

   Do the blind test before redoing any run, and check that the picker still lists the three runs you will play.
6. **Download results (JSON)** and send it to me.

Then go to [INTERVIEW.md](INTERVIEW.md): it says when an app is good enough to use, and how to set it up. I'll also tell you from your results.

## Session A2: try the app's test build (about 15 minutes)

When I tell you the test build is ready:

1. **In the Sanas Console,** check that Allowed origins has `http://tauri.localhost` (Part 1 added it).
2. **Download the installer:** on your laptop, open the link I send in Edge. It is a page on GitHub: if you see **Sign in** at the top right, sign in first, because GitHub lets only signed-in people download these files. Then scroll down to **Artifacts** and click **windows-x64-nsis** (if it isn't there, or nothing downloads, tell me). Edge saves the file `windows-x64-nsis.zip`.
   - If Edge says the file isn't commonly downloaded: click **…** next to it, then **Keep**, then **Show more**, then **Keep anyway**. The app is new and isn't signed, so Edge doesn't know it yet.
3. **Unzip and install it:**
   1. In Edge's list of downloads (Ctrl+J opens it), click the folder icon next to the file (**Show in folder**).
   2. Right-click the highlighted file (its name starts with `windows-x64-nsis`) → **Extract All…** → **Extract**. (No **Extract All…**? Unzip it the way you unzipped this project's code, then open the new folder.)
   3. In the folder that opens, double-click **Accent Changer_0.1.0_x64-setup**, the installer and the only file there.
   - If Windows shows "Windows protected your PC": click **More info**, then **Run anyway**. For the same reason, Windows doesn't know the app yet.
   - If you see **"Smart App Control blocked"**: stop here and tell me. Do not turn Smart App Control off.
   - If Edge or Windows Security says it found a threat: stop here and tell me.
4. **Open Accent Changer** from the Start menu. The Diagnostics page opens.
   - If no window opens, or it closes at once: copy the line below, press **Windows key + R**, paste the line and press Enter:

     ```
     %LOCALAPPDATA%\io.github.devasahan.accentchanger\logs
     ```

     Send me the file **Accent Changer.log** from the folder that opens (Windows may show it as just "Accent Changer"). If Windows can't find that folder, tell me that instead.
5. Do the four steps on the page:
   1. Look at step 1: "Secure page" should say yes. "Version" also shows which build you have, for example `(build main 1a2b3c4)`.
   2. **Check the microphone.** Note whether Windows or the app asked for permission.
   3. **Paste your Sanas key** once and press **Save key**. It is checked with Sanas and kept in Windows Credential Manager.
   4. Press **Connect only.** It uses no Sanas minutes.
6. **Press Copy results and paste them into your message now,** before you close the app: the app forgets its results when it closes.
7. **Close the app** (the X at the top right) **and open it again** from the Start menu. Press **Check the microphone** and **Connect only** once more. Don't paste the key again: this time Connect only checks that the saved key still works after a restart. Note whether anything asked for permission this time.
8. **Press Copy results again** and paste them under the first ones, with your notes.

**A newer test build, later:** close Accent Changer, then download and install the new one as in steps 2 and 3, from the new link I send. Use the zip you just downloaded: your Downloads folder may still have older zips and their folders, with almost the same names (a newer zip's name may end in a number, such as "(1)" or "(2)"). If Windows asks whether to replace a file, choose **Replace the file in the destination**. If the installer says Accent Changer "is already installed", keep the option it has already chosen and press **Next**. Then do steps 4 to 8 again, but don't paste the key again (step 5.3): it is still saved, and step 4 of the page says "A key is saved". In step 1 of the page, check that the build is the one I named. If it isn't, stop and tell me.

To uninstall later: Windows Settings → Apps → Installed apps (Windows 10: Apps & features) → Accent Changer → Uninstall (in Windows 11, under its **…** button). To remove the key too, open the app first and press **Remove key**.

## Session B: your voice into the meeting (about 2 hours)

Do this when I tell you the Session B build is ready. It takes about 2 hours in all: the long check runs by itself for an hour, and about 50 minutes need you. This build sends your microphone into VB-CABLE, a free virtual cable, so that Zoom, Teams or Meet can use "CABLE Output" as your microphone. It uses no Sanas minutes.

**You need:** the laptop on its charger, your wired or USB headset plugged in, Zoom installed, Google Meet in Edge, your phone (for a timer), and an hour in which the laptop does nothing heavy.

**Before you start:** Windows Settings → System → Power & battery → **Screen and sleep** (on newer Windows 11: **Screen, sleep, & hibernate timeouts**) → "When plugged in, put my device to sleep after" → **Never**. Set it back afterwards. The screen may still turn off: that is fine.

1. **Install VB-CABLE** (10 min). In Edge, open vb-audio.com/Cable and download the Windows "VBCABLE_Driver_Pack" zip. Right-click it → **Extract All** → **Extract**. In the new folder, right-click **VBCABLE_Setup_x64** → **Run as administrator** → **Yes** → **Install Driver** → **OK**. Restart Windows. (Running it from inside the zip fails.)
2. **Windows sound settings** (10 min). Press Windows key + R, type `mmsys.cpl` and press Enter.
   1. **Playback:** right-click your headset → **Set as Default Device**, and again → **Set as Default Communication Device**. CABLE Input must not have the green tick.
   2. **Playback:** right-click **CABLE Input** → **Properties** → **Advanced** → Default Format "2 channel, 24 bit, 48000 Hz" (or 16 bit, 48000 Hz) → **OK**.
   3. **Recording:** make your headset microphone the default device and the default communication device. CABLE Output must have neither tick. Right-click **CABLE Output** → **Properties** → **Advanced** → 48000 Hz as above. Then the **Listen** tab: "Listen to this device" must be unticked → **OK**.
   4. **Communications** tab → **Do nothing** → **OK**.
3. **Remove the old test build, then install the new one** (7 min).
   1. Windows Settings → Apps → Installed apps → **Accent Changer** → **…** → **Uninstall** → **Uninstall**. In the window that opens, tick **Delete the application data**, then press **Uninstall**. This makes the next start a true first start, like on your friend's PC. Your Sanas key stays saved: it lives in Windows Credential Manager. (No Accent Changer in the list? Skip this.)
   2. Install the new build as in [Session A2](#session-a2-try-the-apps-test-build-about-15-minutes), steps 2 and 3, from the link I send.
4. **Open the app three times** (5 min). Open Accent Changer, look at the page, and close it with the X. Do this three times in all, and leave the third one open. **Each time, note whether Windows or the app asked anything.** The first time matters most. On the page:
   - step 1 says "Secure page: yes";
   - step 2 is green: "Your voice goes into “CABLE Input”…", and shows "off / off / off";
   - step 2 shows no yellow warnings. If it does, do what they say, then press **Check the microphone**.

   Speak: the "Your microphone" and "Going to the meeting" bars move. (The true first start on your friend's PC is checked again when they install it.)
5. **Zoom's microphone test** (5 min). Zoom → Settings → Audio: Microphone **CABLE Output (VB-Audio Virtual Cable)**, Speaker your headset. Untick "Automatically adjust microphone volume". Press **Test Mic**, say a sentence and listen to the playback. Note: did you hear yourself?
6. **Measure the delay** (2 min). In step 3 of the page, press **Measure the delay**, then say "pa-ta-ka" over and over until it stops (12 seconds). Note the number.
7. **The long check** (about 70 min; you are needed at the start, after 30 minutes and at the end).
   1. In the app: Long check → Send **a test tone**, Minutes **65** → **Start the long check**. From now on the meeting hears a steady tone instead of you: that is expected. (Starting it before the meeting lets the app notice if Windows turns the sound down when the meeting starts.)
   2. In Edge, go to meet.google.com → **New meeting** → **Start an instant meeting**. In the meeting: **⋮** → **Settings** → **General** → turn **Leave empty calls** off. Otherwise Meet ends a call in which you are alone after a few minutes. Then **Audio** → Microphone **CABLE Output (VB-Audio Virtual Cable)**, Speaker your headset. Keep the meeting open, with the camera on or off. If you can't find "Leave empty calls", join the same meeting from your phone instead, with the phone's microphone and sound off, and leave the phone there.
   3. Minimize the app (the – at the top right). Set a 30-minute timer on your phone.
   4. After 30 minutes: check that the Meet tab still shows the meeting (if it ended, note the time). Click the app in the taskbar and press **Hide the app for 30 minutes**. It disappears. It comes back by itself after 30 minutes, without jumping in front of other windows: look for it on the taskbar. (To bring it back sooner, open it from the Start menu.)
   5. When it is back, check that the Meet tab still shows the meeting (if it ended, note it). Wait until the long check says **done** (about 2 minutes after the app comes back), and note its result line. **Still in the meeting**, press **Measure the delay** and say "pa-ta-ka" until it stops: this shows how the delay grew during the hour, and whether the meeting made Windows turn the sound down. Then leave the meeting.
   6. **Only if it says "too many clicks":** step 2 → Advanced → Output route **Through an audio element (test)**. Press **Measure the delay** again. Run the long check again with Minutes **30** (no meeting needed; the app can stay open). Then set Output route back to **Automatic**.
8. **A short check with your voice** (7 min). Long check → Send **your microphone**, Minutes **5** → **Start the long check**. Minimize the app and read anything aloud (a news article) with normal pauses for 5 minutes. Then open the app and note the result.
9. **Restart Windows Audio** (5 min). Start → type `services` → right-click **Services** → **Run as administrator** → **Yes**. Find **Windows Audio** → right-click → **Restart**. If Windows asks whether to restart other services too, press **Yes**. Then look at step 2 → **Recoveries**, and wait until a new line appears there (up to 30 seconds). It should say that your voice came back, and after how long. Speak: the bars move again.
10. **Connect only** (1 min) in step 5 of the page.
11. **Copy results** and paste them into your message, with your notes from steps 4, 5, 7.4 and 7.5 (and anything odd, with the time). Do not close the app before you have pasted them. The "Session B checklist" in step 3 shows what passed. Also send the log file: press Windows key + R, paste the line below and press Enter:

    ```
    %LOCALAPPDATA%\io.github.devasahan.accentchanger\logs
    ```

    Attach **Accent Changer.log** from the folder that opens. It holds the first start's timings and the permission answers, and no device names.

**If I ask you to compare with Edge** (only then): start the test server as in Part 1, step 2, open http://localhost:8080/src/ in Edge, press **Start** if step 2 of the page shows it, and do steps 6 to 8 there. Instead of Hide, minimize the Edge window.

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
| Page or app: "Origin … is not allowed for this group" | In the Sanas Console, Allowed origins must contain exactly `http://localhost:8080` for the test page, or `http://tauri.localhost` for the app (Session A2): no slash at the end, and `localhost` rather than an IP. |
| "Model not entitled" | Copy the exact model name from the Console, including any suffix. |
| "The browser blocked the microphone for this page" | Click the icon left of the address bar → Permissions for this site → Microphone → Allow, then reload. The setting is per port: after `--port 8090`, allow it again. |
| "Windows blocked the microphone" or no microphones listed | Windows Settings → Privacy & security → Microphone: allow access, including "Let desktop apps access your microphone", then reload the page. |
| "Sanas answered, but no audio connection came up" | A firewall or VPN is blocking WebRTC (UDP). Try without the VPN, or on another network. |
| A run reports "dropped the call" | The connection to Sanas broke during the run. Note the time; if it happens again, try another network. |
| Run (step 3) or Start (step 6) is grey | Record the script first (step 2). A reopened page has the text but no recording. |
| Edge asks "Leave site?" or "Reload site?" | It asks every time, even right after a download. If a step is still running, choose **Cancel**. If you changed anything since you last downloaded the results (a run, a rating, a blind-test count or a note), choose **Cancel** and download them first: leaving loses the runs, ratings, notes and recording. Otherwise choose **Leave** (or **Reload**). |
| Step 4 shows far fewer lines than your script has | You paused too briefly between lines: record or read again with about one second of pause. |
| Step 7: the other microphone "is silent" or "stayed silent" | The app must be running, with your headset as its microphone and accent conversion on. Some apps convert only while a call app uses their microphone: the page counts as one. |
| Accent Changer (the test build) doesn't open, or closes at once | Send me its log file: see [Session A2](#session-a2-try-the-apps-test-build-about-15-minutes), step 4. |
| Session B: step 2 says VB-CABLE is not installed | Do Session B step 1 again, then restart Windows. |
| Zoom's Test Mic plays nothing | In Zoom the microphone must be CABLE Output, and the app must be open with step 2 green. |
| I hear myself all the time | "Listen to this device" on CABLE Output is ticked: see Session B step 2.3. |
| The meeting hears a tone | The long check is running (that is expected), or it was stopped early: press **Stop and check**. |
| The app came back, but I can't see it | It is behind the meeting window: click it on the taskbar. |
| Meet left the call by itself | "Leave empty calls" was on (Session B step 7.2). Note the time, and do step 7 again if I ask. |

## Privacy

- **API key, test page (Parts 1 and 2):** only in the test server's memory. It never reaches the browser, the disk or the logs.
- **API key, app (Session A2):** you paste it once into the app's page. The app checks it with Sanas and keeps it in Windows Credential Manager until you press **Remove key**. It is never written to the app's log or to the results; the page shows only its last 4 characters.
- **Session B results and log:** they hold no device ids. Device names are hidden, except VB-CABLE's own names and Windows' generic ones such as "Headset Microphone". The log holds codes and numbers only.
- **Audio:** goes to Sanas Cloud (Ohio or Mumbai). Sanas says it is processed in real time and not stored.
- **Krisp and the Sanas desktop app:** their vendors say accent conversion runs on your laptop. Their meeting-notes features upload transcripts, so keep those off.
- **Recordings and downloads:** stay on your PC (your Downloads folder). If you copy them into this folder, `.gitignore` keeps WAV files and `sanas-check-*.json` results out of git.

## Development

```
npm test               # unit tests (Node 20+, no install)
npm run test:browser   # the probe page in headless Chromium with fake microphones and the Mock engine (needs Playwright)
npm run test:app       # the app's page the same way: in Edge dev mode, and as the installed app with its Rust side, Sanas and VB-CABLE faked
cd src-tauri && cargo test   # the app's Rust side
```

| Path | What |
|---|---|
| `spike/` | The Step 0 probe:<ul><li>`serve.mjs`: local server, key check, Sanas address check, token exchange</li><li>`index.html` / `probe.js`: the UI</li><li>`engines.js`: Sanas and Mock</li><li>`quiet-test.js`: the quiet test's rules</li><li>`webrtc-stats.js`</li></ul> |
| `src/` | The app's page (no bundler): `index.html`, `main.js`, `ui/` (its steps 2 and 3), `audio/`, `engines/`, `platform/`, and `core/`, the pure logic shared with the probe |
| `src/audio/` | The voice into VB-CABLE: `graph.js` (the passthrough and its recovery), `devices.js`, `sink.js`, `monitor.js` (beeps and the test tone, never on the cable), `measure.js` (the Session B checks), and `worklets/` (the recorder the probe uses too) |
| `src-tauri/` | The app's Rust side (Tauri 2): key in Windows Credential Manager, token exchange, window and microphone rules |
| `src/vendor/` | The Sanas Browser SDK, unchanged (see its README for version and hashes) |
| `tests/` | `node --test` unit tests and the headless browser checks |
