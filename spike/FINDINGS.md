# Step 0 findings: is Sanas good enough?

Status: **documentation checks done; the probe has been reviewed, fixed and extended to compare Sanas with two ready-made apps; laptop measurements pending.** The checklist and the decision rule at the bottom decide what happens next.

## What the Sanas docs say (read 2026-11-26)

| Question | Answer | Source |
|---|---|---|
| Can an individual sign up? | Yes: self-serve at console.sanas.ai, "no sales contact required". Sign-up asks for a work email, or "Sign up with Google". | [Changelog](https://developer.sanas.ai/Docs/Resources/Changelog), [Quickstart](https://developer.sanas.ai/Docs/Getting-Started/Quick-Start) |
| Free credit / card | New accounts start with **$10.00** credit, no card. Prepaid wallet; usage is billed per minute in real time; optional monthly spend cap. | [Quickstart](https://developer.sanas.ai/Docs/Getting-Started/Quick-Start) |
| Price | Accent Translation **AT5.2: $0.0090 per minute** on Sanas Cloud (page updated 2026-10-01). | [Pricing](https://developer.sanas.ai/Docs/Resources/Pricing) |
| Indian English → US? | Source accents India, Philippines, Africa, Middle East; target US or UK. Keeps the speaker's voice ("pitch and frequency characteristics"). | [Help Center](https://help.sanas.ai/docs/accent-translation), [AT5.2](https://developer.sanas.ai/Docs/Models/Human-Human/Accent-Translation/Accent-Translation) |
| Usable from a JavaScript desktop app? | Yes: **Browser SDK** `@sanas-ai/browser-sdk` (MIT, 1.0.0, 2026-08-12): microphone `MediaStream` in, processed `MediaStream` out; model by name (`"AT5.2"`, copy the exact name from the console). Also a Python SDK (Windows x86_64 supported). | [Browser SDK guide](https://developer.sanas.ai/BrowserSDKDevGuide), npm |
| How does auth work? | The key never goes to the browser: a backend exchanges it at `https://identity.sanas.ai/oauth2/api-key/login` for a short-lived token. Each page origin must be listed under **Project settings → Allowed origins**. | Browser SDK guide |
| Transport | SIP over secure WebSocket (port 7443) + WebRTC audio; STUN via Google's public servers, no TURN relay. Codec follows sample rate: 8 kHz → PCMU, 16 kHz → G.722 (default), 48 kHz → Opus. AT5.2's maximum model rate is 24 kHz. Jitter buffer target settable. | SDK types, AT5.2 page |
| Regions | Mumbai (ap-south-1) and Ohio (us-east-2). | [Sanas Cloud](https://developer.sanas.ai/Docs/Deployment/Sanas-Cloud) |
| Delay | **Not stated for AT5.2** ("real-time", "no perceptible delay"; ~40 ms is quoted for noise cancellation only). Must be measured. | FAQ |
| Reconnects | The SDK does **not** reconnect a dropped media session; the app must create a new processor. | Browser SDK guide |
| Is audio stored? | "Processed in real time and not stored on Sanas Cloud"; encrypted in transit. Sub-processors: AWS, Azure (CDN), ClickHouse (telemetry). | [Compliance](https://developer.sanas.ai/Docs/Enterprise/Compliance-and-Data-Residency) |
| Terms | Website Terms of Use (updated 10/09/25) allow use "for your personal, non-commercial purposes"; 18+; no impersonating others. The developer console may show its own terms at sign-up: read them. | [Terms of Use](https://www.sanas.ai/legal-policy) |

So, on paper: **individual access, price, API form and terms pass.** Delay, gaps, quality and stability can only be measured on the laptop.

## What the SDK code does (differs from its docs; matters for the app)

Found by reading the vendored SDK 1.0.0 and running it against a local fake SIP server during the review:

| Behaviour | Consequence for the app |
|---|---|
| A call that drops after it was up (server hang-up, ICE or peer connection failed) is reported as **`disconnected`** with reason "Media connection lost". The README says `failed`; in the code `failed` only covers start-up errors and lost authentication or entitlement. | The safety logic must treat `disconnected` that we didn't cause as a drop. |
| When a call ends, the WebRTC stack **stops the input track** it was given. | Every new processor (reconnect) needs a fresh input stream, for example a new `MediaStreamDestination`. |
| `Ready` fires when Sanas answers, before the audio connection is up. | Wait for the peer connection to be `connected` (or packets to arrive) before relying on it. |
| Nothing watches for a server that keeps the call up but stops sending audio. | The app's own "no converted audio while you speak" check is needed (already in the plan's safety mixer). |
| The output plays through an AudioContext of its own, at the **default playback device's** sample rate. | A Bluetooth headset in call mode as the Windows default would band-limit the converted voice. |

## The ready-made apps to compare (read 2026-11-26)

Both need no build. If one of them beats Sanas cloud on your laptop, you can use it directly.

| | Sanas desktop app ("Sanas For All") | Krisp |
|---|---|---|
| For individuals? | Yes. [sanas.ai/get-sanas](https://www.sanas.ai/get-sanas): "now available for small businesses and individuals"; 0–49 agents leads to "Start your 7-day trial now" (verified) | Yes, individual plans [unverified: krisp.ai is blocked from here] |
| Terms | [EULA](https://www.sanas.ai/end-user-license-agreement) §2.1: an individual user gets a license "solely for your own, non-business, use" (verified) | not read |
| Where it runs | On the laptop's CPU. Requirements list CPU and RAM only:<ul><li>minimum: i3/i5 6th gen, 4 cores, 8 GB;</li><li>recommended: 8 cores, 3.2 GHz base clock, 16 GB, CPU use under 60 %.</li></ul>(help.sanas.ai, verified) | On the laptop [unverified] |
| Model and voice | AT5.7: US English, "Universal" source accents, 16 kHz, "reduced processing latency". Voice Personalization keeps your voice. | Indian English to US English, about 200 ms claimed [unverified] |
| Price | 7-day trial; the price after it is not published | Core about $8/month paid yearly or $16 monthly, with 1 h/day of conversion; Advanced about $15 / $30 with 4 h/day; 7-day trial [unverified] |
| Unknown until measured | Delay and CPU load on your laptop; whether the trial includes conversion of your own voice | Real delay and CPU load |

Your NVIDIA T1200 GPU doesn't change this. All three run their accent model in the cloud or on the CPU. No open-source model converts an accent live while keeping your voice: the live voice tools change only whose voice it sounds like, and the accent models run offline only.

## What the probe measures

`node spike/serve.mjs`, then http://localhost:8080/spike/ in Edge (see the README). The probe sends your recorded script through Sanas at live speed and compares what went in with what came back, recorded side by side:

- **Delay**: overall (envelope cross-correlation refined on syllable onsets), plus per sentence (median, p95, max) to show drift and jumps. It is the whole browser path (into WebRTC, network, Sanas, jitter buffer, back out), close to what the app will add. The Mock run is the baseline of the measuring setup itself: in the headless test the browser plumbing added about 50 ms (a 300 ms mock measured ~350 ms).
- **Gaps**: stretches where you spoke but the output stayed silent. A gap needs at least 100 ms of missing speech containing a loud vowel. Breaths, coughs and room noise that the converter leaves out don't count, and neither does a sentence that comes back late: that shows in the per-sentence delay instead. 20 ms at each edge is allowed for timing slop. Measured sensitivity on simulated dropouts:

  | Dropout length | Found (all material) | Found (real read speech) |
  |---|---|---|
  | 250 ms or longer | 80–98% | 94–98% |
  | 150–200 ms | 40–94% | 79–94% |
  | 100 ms | rarely | rarely |

  Most misses fall largely in a pause between words. No false gaps appeared in any of the clean runs. The number in brackets is the longest gap.
- **Bandwidth, level change, WebRTC stats** (round-trip time, jitter buffer, loss, concealment, codec, Sanas server address).
- **Stability**: one connection for 65 minutes (an interview's length; 10 minutes for a quick look). A drop is a `disconnected` or `failed` call, or a whole loop with no converted audio while the call claims to be up. Each drop is followed by a reconnect, whose time is measured. Delay figures pool every sentence of every loop, so one slow stretch shows in p95 and max.
- **Start-up**: time until the audio connection is up (not just until Sanas answers).
- **Quiet test** (Live, and step 7's long check): Sanas documents no idle timeout, so the README asks for 15 minutes of silence, then speech. Every 3 s the page notes whether your microphone had speech, how many seconds of those 3 were loud, and whether converted speech followed it. It saves the timelines (`speechAtSec`, `speechSoundSec`, `heardAtSec`). Speech ticks at most 3.5 s apart form a stretch of talk; a stretch with less than 1 s of sound in it (a cough, a knock on the headset) doesn't count. From them:
  - `silenceLongestSec`: your longest silence that ended with talk (from the start of the call, or between stretches of talk);
  - `speechResumedAtSec`: when the talk after it started;
  - `convertedBackAfterSec`: how many seconds after that converted speech came back. It is null when it never did, which is not the same as "you stayed silent". A run where you spoke but nothing was converted says so in its reason.
  - `silenceAtEndSec`: the silence from your last words to Stop. It is not a quiet test, as you never spoke after it; the page says so when it is the longest.
- **Other apps** (step 7, "Read the script"): your headset microphone and the other app's virtual microphone, recorded side by side while you read the script aloud. They are analysed like a Sanas run (delay per sentence, gaps, bandwidth, level) and rated the same way. Stop waits 3 s for the app's last words, as the Sanas runs keep recording after the script ends. The page's table marks an app's delay red above 500 ms (INTERVIEW.md's bar), and a Sanas cloud delay above 380 ms (the GO limit).
- **Other apps, long check** (step 7): the same two microphones followed like a Live call for up to 90 minutes, during a full-length rehearsal call, keeping only the last 12 s. It saves the delay and the quiet-test fields for the app.
  - The delay here is the app's whole path, up to its microphone.
  - The Sanas cloud delay (step 3) leaves out the microphone and the virtual cable that our app adds (Gate 1 allows up to 120 ms for those). Add that before comparing.
- **Sanas address check** (server, free: it asks only for the project's entitlements): whether Sanas accepts `http://tauri.localhost` and `https://tauri.localhost`, the page addresses the app would use.
  - This page's own address is a check that must pass.
  - An unlisted address is a check that must fail.
  - Otherwise the result says "inconclusive", and the app's own test (Step 1) decides.
- **Your rating** per sentence and per run: natural, still your voice, every word right, sounds American. A line counts only with all four. A run nobody rated has `rated: false` and no score, not 0/10.
- **Blind listener** per run: the lines played (5 by default, different lines for each run), and how many of them a friend heard with every word right, how many sound like you, and how many sound American.

## Review of the probe (2026-11-26)

An independent three-part review (measurement, Sanas integration, security) with adversarial verification confirmed 11 issues and 16 smaller ones. All are fixed, with regression tests. The ones that could have changed the GO/NO-GO answer:

- **Drops detected:** real drops are reported as `disconnected`, and the probe used to listen only for `failed`. The stability run would have passed after a real drop.
- **Reconnects carry audio:** a reconnect reused the stopped input track. The new call got no audio, but the page still reported a fast reconnect.
- **Silent loops counted:** loops with no converted audio used to be left out of the stability summary.
- **No false gaps:** breaths the converter leaves out, and short takes in a noisy room, used to be reported as gaps. A sentence delayed by the jitter buffer also used to count as missing speech.
- **Honest numbers:** the "longest gap" used to include the pause after a hole. The long-run p95 could never show the worst loop.
- **Key prompt:** the hidden prompt could accept a doubled key, or one with a stray ^V, and only fail later on the page. The server now checks the key with Sanas when it starts.

Known limit: when the delay changes partway through one sentence, for example while a jitter buffer drains after a long stall, the gap detector can still count about one false gap for that sentence. The old code counted 3–4.

## Go / no-go checklist

GO needs every row to pass (from the plan).

| Check | Pass | Fail | Result |
|---|---|---|---|
| Individual sign-up | key within ~3 days | sales/company only | ✅ self-serve per docs (confirm on sign-up) |
| Terms | personal use allowed, nothing forbids this use | forbidden, or you reject the data terms | ✅ website terms allow personal use; read console terms |
| Usable from a desktop JS app | browser SDK or WebSocket/WebRTC API | enterprise only | ✅ Browser SDK (MIT) |
| Delay median / p95 | ≤ 380 / 480 ms (best ≤ 300 / 380) | worse | ⏳ |
| Gaps in speech (3 runs) | ≤ 1 per run | more | ⏳ |
| Listening test (your 15 sentences) | ≥ 8/10, a line counting only if natural, your voice, every word right and American (6–7 = your call) | ≤ 5/10 or words mangled | ⏳ |
| Price | ≤ $0.05/min | more | ✅ $0.009/min |
| Stability (65 min) | no drop and no silent loop; reconnect ≤ 5 s | drops with no recovery | ⏳ |
| Quiet test (15 min) | converted voice comes back within about 6 s of speaking again (`convertedBackAfterSec` ≤ 6) | later, never, or the call drops | ⏳ |

Also recorded. These decide how the app is built, not GO / NO-GO:

| Check | Result |
|---|---|
| Sanas address check: does Sanas accept `http://tauri.localhost` or `https://tauri.localhost`? If both are refused, the app needs a fallback route (plan, Step 1) | ⏳ |
| Region: `sanas.sipHosts` and `webrtc.remote` in the results file (Mumbai is nearer than Ohio) | ⏳ |
| AT5.2 bandwidth at 48 kHz (`bandwidthSigHz`) | ⏳ |

## Decision rule: build our app, or use a ready-made one?

Build the rest of our app (plan Steps 2 and 4–9) only if Sanas cloud passes the GO checklist above **and** one of these holds:

1. It rates at least as well as the best ready-made app, with at most about 100 ms more delay. "Rates" means your score and the blind listener's counts (every word right, sounds like you, and sounds American). Count our app's own path in that delay.
2. After hearing both, you still prefer our own app, for cost or lightness.
3. The ready-made apps are unavailable, too expensive, or their terms don't allow this use.

An app on the laptop whose usual total CPU (not a spike) is above about 60 % in a Zoom video call, with the app on, counts as worse (Sanas's own guidance).

Before a ready-made app is used in a real interview, it must also pass the bar in [INTERVIEW.md](../INTERVIEW.md): your score at least 8/10, the blind listener at least 4 of 5 on every count, at most 1 gap and a delay of about 500 ms or less in its read-aloud run, CPU within the rule above, and enough daily conversion minutes for the interview. Then the rehearsal (INTERVIEW.md, section 4) must go well: the converted voice back at once after 15 minutes of silence, nothing wrong all call, CPU about 60 % or less with OBS and video on.

Otherwise use the winner directly. For lip sync, set OBS "Video Delay (Async)" to its measured delay (INTERVIEW.md, section 3). Wrapping it in our app would only add delay.

Decision: **pending** the laptop runs.
