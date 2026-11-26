/**
 * Watches the WebRTC connection and SIP WebSocket the Sanas SDK opens, so the
 * spike can report round-trip time, jitter buffer, packet loss, codec and
 * which Sanas server answered. Installs itself when imported: import this
 * module before anything that may create a peer connection.
 */

const peers = [];
export const socketHosts = [];

function install() {
  if (globalThis.__accentSwitchWatch) return;
  globalThis.__accentSwitchWatch = true;
  const NativePC = globalThis.RTCPeerConnection;
  if (NativePC) {
    const Watched = function RTCPeerConnection(...args) {
      const pc = new NativePC(...args);
      peers.push(pc);
      return pc;
    };
    Watched.prototype = NativePC.prototype;
    Object.setPrototypeOf(Watched, NativePC);
    globalThis.RTCPeerConnection = Watched;
  }
  const NativeWS = globalThis.WebSocket;
  if (NativeWS) {
    const Watched = function WebSocket(url, protocols) {
      try {
        const u = new URL(url, location.href);
        if (u.host !== location.host) socketHosts.push({ host: u.host, at: new Date().toISOString() });
      } catch {
        // not a URL we can read; the socket still opens
      }
      return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    };
    Watched.prototype = NativeWS.prototype;
    Object.setPrototypeOf(Watched, NativeWS);
    globalThis.WebSocket = Watched;
  }
}

install();

/** The newest peer connection that is still open, if any. */
function currentPeer() {
  for (let i = peers.length - 1; i >= 0; i--) {
    const pc = peers[i];
    if (pc.connectionState !== "closed") return pc;
  }
  return null;
}

/** One snapshot of the current Sanas call's audio statistics, or null. */
export async function sampleStats() {
  const pc = currentPeer();
  if (!pc) return null;
  let report;
  try {
    report = await pc.getStats();
  } catch {
    return null;
  }
  const s = { at: performance.now() };
  let pairId = null;
  report.forEach((r) => {
    if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
  });
  report.forEach((r) => {
    if (r.type === "candidate-pair" && (r.id === pairId || (!pairId && r.nominated && r.state === "succeeded"))) {
      if (typeof r.currentRoundTripTime === "number") s.rttMs = r.currentRoundTripTime * 1000;
      s.remoteCandidateId = r.remoteCandidateId;
    } else if (r.type === "inbound-rtp" && r.kind === "audio") {
      s.jitterMs = (r.jitter ?? 0) * 1000;
      s.packetsLost = r.packetsLost ?? 0;
      s.packetsReceived = r.packetsReceived ?? 0;
      s.jbDelay = r.jitterBufferDelay ?? 0;
      s.jbEmitted = r.jitterBufferEmittedCount ?? 0;
      s.jbTargetDelay = r.jitterBufferTargetDelay ?? null;
      s.concealed = r.concealedSamples ?? 0;
      s.totalSamples = r.totalSamplesReceived ?? 0;
      s.codecId = r.codecId;
    } else if (r.type === "remote-inbound-rtp" && r.kind === "audio" && typeof r.roundTripTime === "number") {
      s.remoteRttMs = r.roundTripTime * 1000;
    }
  });
  const rc = s.remoteCandidateId ? report.get(s.remoteCandidateId) : null;
  if (rc) s.remote = `${rc.address ?? rc.ip ?? "?"}:${rc.port ?? "?"} ${rc.protocol ?? ""}`.trim();
  const codec = s.codecId ? report.get(s.codecId) : null;
  if (codec) s.codec = `${codec.mimeType}/${codec.clockRate}${codec.channels ? `/${codec.channels}` : ""}`;
  delete s.remoteCandidateId;
  delete s.codecId;
  return s;
}

/** Collects snapshots once a second until stopped; returns a summary. */
export function watchStats() {
  const samples = [];
  let timer = setInterval(async () => {
    const s = await sampleStats();
    if (s) samples.push(s);
  }, 1000);
  return {
    async stop() {
      clearInterval(timer);
      timer = null;
      const last = await sampleStats();
      if (last) samples.push(last);
      return summarizeStats(samples);
    },
  };
}

const med = (list) => {
  const v = list.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

export function summarizeStats(samples) {
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const d = (k) => (last[k] ?? 0) - (first[k] ?? 0);
  const emitted = d("jbEmitted");
  const received = d("packetsReceived");
  const lost = d("packetsLost");
  const total = d("totalSamples");
  return {
    samples: samples.length,
    rttMs: med(samples.map((s) => s.rttMs ?? s.remoteRttMs)),
    jitterMs: med(samples.map((s) => s.jitterMs)),
    jitterBufferMs: emitted > 0 ? (d("jbDelay") / emitted) * 1000 : null,
    concealedPct: total > 0 ? (d("concealed") / total) * 100 : null,
    packetLossPct: received + lost > 0 ? (lost / (received + lost)) * 100 : null,
    codec: last.codec ?? null,
    remote: last.remote ?? null,
  };
}
