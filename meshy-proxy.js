// /api/meshy-proxy.js
//
// Vercel Serverless Function — proxies downloads of Meshy-generated assets
// (GLB/FBX/OBJ/etc.) so the browser never has to fetch assets.meshy.ai
// directly. Meshy's asset CDN does not send Access-Control-Allow-Origin,
// so browser-side fetch()/GLTFLoader.load() calls are blocked by CORS —
// this is confirmed in Meshy's own docs (docs.meshy.ai/en/api/errors):
// "Consider using a server-side proxy for such requests."
//
// Server-to-server requests (this function -> assets.meshy.ai) are NOT
// subject to CORS at all — CORS is a browser-enforced restriction only.
// This function fetches the file here, then re-serves the bytes from your
// own Vercel origin (karl-con-bim.vercel.app), which the browser is always
// allowed to load from.
//
// Usage from the browser:
//   /api/meshy-proxy?url=<encodeURIComponent(signedMeshyUrl)>
//
// Security notes:
//  - Only allows fetching from assets.meshy.ai / *.meshy.ai — this is NOT
//    an open proxy. Any other host is rejected with 400.
//  - The Meshy URL itself is already a signed, time-limited URL (it has
//    its own ?Expires=... token), so this proxy adds no new access beyond
//    what the signed URL already grants.
//  - No API key handling happens here — this only proxies the final
//    asset download, not the Meshy API task-creation calls.

export const config = {
  api: {
    // Allow the (potentially large) GLB body to stream through without
    // Vercel's default body-parsing/size assumptions getting in the way.
    bodyParser: false,
  },
};

const ALLOWED_HOST_SUFFIX = '.meshy.ai';
const ALLOWED_EXACT_HOST  = 'meshy.ai';

function isAllowedHost(hostname) {
  return hostname === ALLOWED_EXACT_HOST || hostname.endsWith(ALLOWED_HOST_SUFFIX);
}

export default async function handler(req, res) {
  // Basic CORS for your own frontend (adjust origin if you serve from
  // more than one domain). This is CORS *we* control, on *our* response —
  // totally separate from the Meshy CORS issue this proxy works around.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed — use GET' });
    return;
  }

  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    res.status(400).json({ error: 'Missing required ?url= query parameter' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    res.status(400).json({ error: 'Invalid url parameter' });
    return;
  }

  if (parsed.protocol !== 'https:' || !isAllowedHost(parsed.hostname)) {
    res.status(400).json({ error: 'url must be an https://*.meshy.ai address' });
    return;
  }

  try {
    // Server-to-server fetch — CORS does not apply here at all.
    const upstream = await fetch(parsed.toString());

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: `Upstream fetch failed: HTTP ${upstream.status}`,
      });
      return;
    }

    // Pass through the real content type/length so GLTFLoader (and the
    // browser) treat this exactly like a normal binary download.
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    // Signed Meshy URLs are already time-limited; cache briefly to avoid
    // re-proxying the same asset on every re-render within a session.
    res.setHeader('Cache-Control', 'public, max-age=3600, immutable');

    // Stream the body straight through without buffering the whole file
    // in memory — important for GLBs that can be tens of MB.
    const reader = upstream.body.getReader();
    res.status(200);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    res.status(502).json({ error: 'Proxy fetch failed: ' + e.message });
  }
}
