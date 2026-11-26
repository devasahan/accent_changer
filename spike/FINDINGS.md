# Step 0 findings: is Sanas good enough?

Status: **documentation checks done; laptop measurements pending.** The checklist at the bottom decides GO or NO-GO.

## What the Sanas docs say (read 2026-11-26)

| Question | Answer | Source |
|---|---|---|
| Can an individual sign up? | Yes: self-serve at console.sanas.ai, "no sales contact required". Sign-up asks for a work email, or "Sign up with Google". | [Changelog](https://developer.sanas.ai/Docs/Resources/Changelog), [Quickstart](https://developer.sanas.ai/Docs/Getting-Started/Quick-Start) |
| Free credit / card | New accounts start with **$10.00** credit, no card. Prepaid wallet; usage is billed per minute in real time; optional monthly spend cap. | [Quickstart](https://developer.sanas.ai/Docs/Getting-Started/Quick-Start) |
| Price | Accent Translation **AT5.2: $0.0090 per minute** on Sanas Cloud (page updated 2026-10-01). | [Pricing](https://developer.sanas.ai/Docs/Resources/Pricing) |
| Indian English → US? | Source accents India, Philippines, Africa, Middle East; target US or UK. Keeps the speaker's voice ("pitch and frequency characteristics"). | [Help Center](https://help.sanas.ai/docs/accent-translation), [AT5.2](https://developer.sanas.ai/Docs/Models/Human-Human/Accent-Translation/Accent-Translation) |
| Usable from a JavaScript desktop app? | Yes: **Browser SDK** `@sanas-ai/browser-sdk` (MIT, 1.0.0, 2026-08-12): microphone `MediaStream` in, processed `MediaStream` out; model by name (`"AT5.2"`, copy the exact name from the console). Also a Python SDK (Windows x86_64 supported). | [Browser SDK guide](https://developer.sanas.ai/BrowserSDKDevGuide), npm |
| How does auth work? | The key never goes to the browser: a backend exchanges it at `https://identity.sanas.ai/oauth2/api-key/login` for a short-lived token. Each page origin must be listed under **Project settings → Allowed origins**. | Browser SDK guide |
| Transport | SIP over secure WebSocket (port 7443) + WebRTC audio; STUN via Google's public servers. Codec follows sample rate: 8 kHz → PCMU, 16 kHz → G.722 (default), 48 kHz → Opus. AT5.2's maximum model rate is 24 kHz. Jitter buffer target settable. | SDK types, AT5.2 page |
| Regions | Mumbai (ap-south-1) and Ohio (us-east-2). | [Sanas Cloud](https://developer.sanas.ai/Docs/Deployment/Sanas-Cloud) |
| Delay | **Not stated for AT5.2** ("real-time", "no perceptible delay"; ~40 ms is quoted for noise cancellation only). Must be measured. | FAQ |
| Reconnects | The SDK does **not** reconnect a dropped media session; the app must create a new processor. | Browser SDK guide |
| Is audio stored? | "Processed in real time and not stored on Sanas Cloud"; encrypted in transit. Sub-processors: AWS, Azure (CDN), ClickHouse (telemetry). | [Compliance](https://developer.sanas.ai/Docs/Enterprise/Compliance-and-Data-Residency) |
| Terms | Website Terms of Use (updated 10/09/25) allow use "for your personal, non-commercial purposes"; 18+; no impersonating others. The developer console may show its own terms at sign-up: read them. | [Terms of Use](https://www.sanas.ai/legal-policy) |

So, on paper: **individual access, price, API form and terms pass.** Delay, gaps, quality and stability can only be measured on the laptop.

## What the probe measures

`node spike/serve.mjs`, then http://localhost:8080/spike/ in Edge (see the README). The probe sends your recorded script through Sanas at live speed and compares what went in with what came back, recorded side by side:

- **Delay**: overall (envelope cross-correlation refined on syllable onsets), plus per utterance (median, p95) to show drift. This is the whole browser path (into WebRTC, network, Sanas, jitter buffer, back out), which is close to what the app will add. In the headless test the browser plumbing alone added about 50 ms (a 300 ms mock measured ~354 ms).
- **Gaps**: stretches of at least 100 ms where you spoke but nothing came back.
- **Bandwidth, level change, WebRTC stats** (round-trip time, jitter buffer, loss, concealment, codec, Sanas server address).
- **Stability**: one connection for 10 minutes, drops and reconnect time.
- **Your rating** per sentence: natural, still your voice, every word right.

## Go / no-go checklist

GO needs every row to pass (from the plan).

| Check | Pass | Fail | Result |
|---|---|---|---|
| Individual sign-up | key within ~3 days | sales/company only | ✅ self-serve per docs (confirm on sign-up) |
| Terms | personal use allowed, nothing forbids this use | forbidden, or you reject the data terms | ✅ website terms allow personal use; read console terms |
| Usable from a desktop JS app | browser SDK or WebSocket/WebRTC API | enterprise only | ✅ Browser SDK (MIT) |
| Delay median / p95 | ≤ 380 / 480 ms (best ≤ 300 / 380) | worse | ⏳ |
| Gaps over 100 ms in speech (3 runs) | ≤ 1 per run | more | ⏳ |
| Listening test (10 sentences) | ≥ 8/10 (6–7 = your call) | ≤ 5/10 or words mangled | ⏳ |
| Price | ≤ $0.05/min | more | ✅ $0.009/min |
| Stability (10 min) | no drop, reconnect ≤ 5 s | drops with no recovery | ⏳ |

Decision: **pending** the laptop runs. If NO-GO, the fallback is Krisp's own app (the probe's step 7 can measure its delay).
