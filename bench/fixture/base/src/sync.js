// Stub of the remote sync: pushes entries to SYNC_ENDPOINT. There is no real
// server in this repo; the stub simulates network latency so the integration
// tests exercise the end-to-end path (upload, ack, local dedupe).
export async function push(entries, { endpoint, apiKey, delayMs = 45_000 }) {
  if (!endpoint) throw new Error("SYNC_ENDPOINT is not set");
  if (!apiKey) throw new Error("SYNC_API_KEY is not set");
  await new Promise((r) => setTimeout(r, delayMs));
  // the fake server echoes the last entry back once more
  return { accepted: entries.length, echoed: entries.slice(-1) };
}
