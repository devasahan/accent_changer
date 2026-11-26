# Vendored code

## `sanas-browser-sdk/`

The Sanas Browser SDK, copied unchanged so the app needs no bundler or `npm install`:

| | |
|---|---|
| Package | [`@sanas-ai/browser-sdk`](https://www.npmjs.com/package/@sanas-ai/browser-sdk) 1.0.0 (published 2026-08-12) |
| License | MIT (the package's `license` field; the package ships no separate LICENSE file) |
| Files | `dist/esm/index.js` → `index.js`, `dist/esm/index.js.map` → `index.js.map` |
| npm integrity | `sha512-MC139gFRIP7gIR8yOMlthrN6kZLh4zm0unQmLWxoGjFg6kjOtpIeOM9NfUH9nRliSvHB8plvVJLqjjGarrsTug==` |
| sha256 `index.js` | `9fe5400a33278ad67824fcba71a35eb0cf166a7099bee6130bb87d2357caddc3` |
| sha256 `index.js.map` | `5a2346d48d384cbc4ef3bcf848ff1cf2d757a31440afabb8e156cd9feb3e9e3d` |
| Docs | [Browser SDK – Developer Guide](https://developer.sanas.ai/BrowserSDKDevGuide) |

What it does: takes a microphone `MediaStream`, sends it to Sanas Cloud over WebRTC (SIP signalling over `wss://…:7443`), and returns the processed audio as a `MediaStream`. It talks to `portal-api.sanas.ai` (entitlements, heartbeat) and `event-producer.sanas.ai` (usage metrics, once a minute), and uses Google's public STUN servers for ICE. It never sees the API key: our local helper exchanges the key for a short-lived token at `identity.sanas.ai`.

To update: `npm pack @sanas-ai/browser-sdk@<version>`, copy the two files, and update this table.
