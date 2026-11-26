# Your interview with a ready-made app

Until our own app is built and tested, you can use Krisp or the Sanas desktop app in an interview, but only one that passes the bar below and the rehearsal in section 4. Its numbers come from Part 2 of the [README](README.md); I'll also check them from your results file.

## 1. Does the app pass?

Every line must hold:

| Check | Pass |
|---|---|
| Your score for its read-aloud run | 8 out of 10 or more. A line counts only with all four boxes ticked: natural, your voice, every word right, sounds American. |
| Blind listener: every word right | at least 4 of 5 lines |
| Blind listener: sounds like you | at least 4 of 5 lines |
| Blind listener: sounds American | at least 4 of 5 lines |
| Delay (Delay ms in the page's table) | about 500 ms or less |
| Gaps (in the page's table, its read-aloud run) | at most 1 |
| CPU during the Zoom video test | the usual Utilization with the app on is about 60 % or less |
| Daily limit | the trial's minutes of accent conversion per day cover the interview (plan 90 minutes) plus your checks |

In the page's table, a red number fails its line.

- **If both apps pass,** pick the one whose lines your friend got right more often. If that is a tie, pick the higher score, then the lower delay.
- **If neither passes, or no trial works,** do the interview without a tool. Mangled technical words are worse than an accent.

## 2. Ask first (as soon as an app passes, about 5 days before)

Email the recruiter, for example: "I sometimes use a real-time AI accent-conversion tool on my microphone in calls. The words are my own. Is it all right if I use it in the interview?"

- If they say no, or the company's rules ban AI tools, don't use it.
- **No answer by the day before?** Then don't use it, or use it only if you say the sentence in section 5 at the very start of the interview.
- Never use it in a proctored or recorded assessment.

## 3. Set it up once (about 45 minutes)

1. **In the app:**
   - Your wired or USB headset is its microphone, not a Bluetooth one (see the README, "Before you start", step 4).
   - Accent conversion is on, for your microphone.
   - Meeting notes, transcription and recording are off (in Krisp: the AI Note Taker's automatic activation).
2. **In Zoom, Teams or Meet:** pick the app's microphone, for example "Krisp Microphone", as your microphone. Don't pick your headset.
3. **Lip sync** (your camera is on). The converted voice is a little late, so the video is delayed by the same amount:
   1. Install OBS Studio from [obsproject.com](https://obsproject.com). When it first starts, choose that you will only use the virtual camera.
   2. **On a laptop with two graphics chips** (Intel and NVIDIA): Windows Settings → System → Display → Graphics. Find OBS Studio (or add `obs64.exe` from `C:\Program Files\obs-studio\bin\64bit`), then Options → **High performance**. Leave Zoom and Teams on the default: on some laptops the NVIDIA chip makes their shared screens black. Then start OBS again.
   3. Under Sources: **+** → **Video Capture Device** → your webcam. Right-click it → **Transform** → **Fit to screen**.
   4. Right-click it → **Filters** → **+** under Audio/Video Filters → **Video Delay (Async)**. Set the delay to the app's Delay ms from Part 2.
   5. Click **Start Virtual Camera**. In the meeting app, choose the camera **OBS Virtual Camera**.
4. **Check the lip sync** (about 15 minutes):
   1. Start a Zoom meeting on the laptop. Join it from your phone as a second participant, muted, with earphones in.
   2. On the laptop: **Record → Record on this Computer**. It works on the free plan.
   3. Say a sharp "Pa!" a few times, with your lips clearly visible, then a few sentences.
   4. End the meeting. Zoom saves the recording as an MP4 file.
   5. Watch it and compare when your lips open with when you hear "Pa":
      - if you hear it before the lips open, lower the OBS delay by 40–50 ms;
      - if the lips open before you hear it, raise it by 40–50 ms.
   6. Stop when you can't see a difference. If you're unsure, keep the measured Delay ms.

## 4. Rehearsal (a day or two before, about an hour)

Hold a test meeting as long as the interview, on the interview's platform, with the app, OBS and video on. A friend plays the interviewer. Plug in the charger and set Power mode to **Best performance** (Windows 11: Windows Settings → System → **Power & battery** → Power mode; Windows 10: click the battery icon at the right of the taskbar and drag the slider to **Best performance**), as on the day.

1. Before the call, open the test page (as in Part 1) in its own tab and start step 7's **Long check**, with the app's microphone as the other microphone. If the meeting runs in the browser, open it in a new tab (Ctrl+T).
2. In the call, stay silent for 15 minutes while your friend talks (not even a "yes" or a laugh), then answer. Your friend tells you whether your converted voice was there from your first word after the silence, and whether anything sounded wrong. (A free Zoom account ends a meeting after 40 minutes: start it again and keep the long check running.)
3. Near the end, note the usual CPU Utilization in Task Manager.
4. Then, still in the call, practise the emergency steps in section 6 once, in order: the voice steps first, then the video step. After each switch, your friend tells you what they see and hear. Then undo them, in this order:
   1. In the meeting app, pick the app's microphone and the camera **OBS Virtual Camera** again. This frees the webcam for OBS; the picture comes back in the next step.
   2. If you closed OBS, start it again and click **Start Virtual Camera**.
   3. Right-click the webcam source → **Filters**, and click the crossed-out eye next to Video Delay (Async) so it is open: the delay is on again.

   Your friend checks that your video and your converted voice are back.
5. After the call, press **Stop** on the long check. Type the CPU % and your friend's answers in the page's **Notes** box, then **Download results (JSON)** and send me the file.

**Use the app in the interview only if all of these hold:**

- After Stop, the page said "Quiet test: after 15.0 min of silence the converted voice came back at once." It says this next to the long check's **Stop** button and at the top of the page. It may say more than 15 minutes; it must say at least 14. A shorter silence, or no quiet test at all, means something broke your silence: start the **Long check** again, stay silent for 15 minutes, then talk for a minute, press **Stop** and download the results again. If you can, do this in a call with your friend, so they can check your first words again. If it happens again, move the microphone a little to the side of your mouth and turn the headphones down.
- Your friend heard your converted voice from your first word after the silence, and nothing sounded wrong at any point in the call, apart from the practice in step 4. (If your own accent came back late in the call, before that practice, a daily limit may have run out.)
- The CPU near the end was about 60 % or less.

Otherwise switch to the other app if it passed section 1:

1. Quit the first app (its tray icon → **Quit**) and start the other one, set up as in section 3, step 1.
2. In the meeting app, pick the other app's microphone.
3. In OBS, right-click the webcam source → **Filters**, click **Video Delay (Async)** and change its delay to the other app's Delay ms from Part 2. Don't add a second delay.
4. Check the lip sync again (section 3, step 4), then give the other app its own rehearsal.

If it didn't pass, or there isn't time for all that, do the interview without a tool.

## 5. On the day

1. Plug in the charger and set Power mode to **Best performance** (as in section 4). Use a cable to the internet if you can.
2. Plug in your wired or USB headset, then start the app and OBS's virtual camera. Keep your own check short (a minute): the trial's daily minutes count.
3. On the meeting's pre-join screen, check that:
   - the microphone is the app's;
   - its level moves when you speak;
   - the camera is **OBS Virtual Camera**, not your webcam;
   - the video shows you, filling the picture;
   - in OBS, the delay is on: right-click the webcam source → **Filters**. The eye next to Video Delay (Async) is open, not crossed out. A crossed-out eye means the delay is off: click it.
4. Share one window, never the whole screen.
5. **Always say it once at the start, even if the recruiter agreed:** "Before we start: I use a real-time AI accent-conversion tool on my microphone. The words are my own. I'm happy to turn it off if you prefer." If they prefer it off, do section 6's voice steps at once.

## 6. If something goes wrong during the call

- **The voice goes wrong** (or the interviewer prefers it off):
  1. Switch the meeting's microphone back to your headset:
     - in Zoom, the **^** next to Mute;
     - in Teams or Meet, the arrow next to the microphone button.
  2. Then in OBS, right-click the webcam source → **Filters**, and click the eye next to Video Delay (Async) so it is crossed out: the delay is off. Your voice is no longer late, so the video mustn't be either.
- **The video freezes or goes black:** close OBS (File → Exit), then pick your webcam in the meeting app.
  - Don't pick the webcam while OBS runs: OBS is holding it.
  - If you can, also switch your voice to the headset (above), so your lips and voice match again.
