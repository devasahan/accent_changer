# Step 0 findings: is Sanas good enough?

Status: **documentation checks done; the probe has been reviewed and fixed; laptop measurements pending.** The checklist at the bottom decides GO or NO-GO.

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
- **Stability**: one connection for 10 minutes. A drop is a `disconnected` or `failed` call, or a whole loop with no converted audio while the call claims to be up. Each drop is followed by a reconnect, whose time is measured. Delay figures pool every sentence of every loop, so one slow stretch shows in p95 and max.
- **Start-up**: time until the audio connection is up (not just until Sanas answers).
- **Your rating** per sentence and per run: natural, still your voice, every word right.

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
| Listening test (10 sentences) | ≥ 8/10 (6–7 = your call) | ≤ 5/10 or words mangled | ⏳ |
| Price | ≤ $0.05/min | more | ✅ $0.009/min |
| Stability (10 min) | no drop and no silent loop; reconnect ≤ 5 s | drops with no recovery | ⏳ |

Decision: **pending** the laptop runs. If NO-GO, the fallback is Krisp's own app (the probe's step 7 can measure its delay).
