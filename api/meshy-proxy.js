// /api/meshy-proxy.js
//
// Vercel Serverless Function — proxies downloads of Meshy-generated assets
// (GLB/FBX/OBJ/etc.) so the browser never has to fetch assets.meshy.ai
// directly, since Meshy's asset CDN does not send Access-Control-Allow-Origin,
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

// Meshy's CDN sits behind Varnish and occasionally answers transient
// congestion (503 Backend.max_conn reached, 502, 504) rather than actually
// failing the request. These are worth a short retry/backoff before we
// give up and tell the user the model can't be loaded — otherwise a
// perfectly good, already-generated model looks "broken" to the app for
// what's really a few seconds of upstream contention.
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 300; // 300, 600, 1200 ... capped below

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, attempt = 1) {
  const upstream = await fetch(url, {
    // Don't let a hung upstream connection tie up the function forever;
    // Vercel already enforces its own maxDuration, but this keeps retries
    // from stacking past that budget.
    signal: AbortSignal.timeout(15000),
  });

  if (RETRYABLE_STATUSES.has(upstream.status) && attempt < MAX_ATTEMPTS) {
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 4000);
    await sleep(delay);
    return fetchWithRetry(url, attempt + 1);
  }

  return { upstream, attempt };
}

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Missing required "url" query parameter.' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: 'Malformed "url" parameter.' });
    return;
  }

  if (!isAllowedHost(parsed.hostname)) {
    res.status(400).json({
      error: `Refusing to proxy host "${parsed.hostname}" — only *.meshy.ai is allowed.`,
    });
    return;
  }

  try {
    const { upstream, attempt } = await fetchWithRetry(parsed.toString());

    if (!upstream.ok) {
      // Never forward the raw upstream body (which may be an HTML error
      // page from Varnish/Meshy's CDN, not JSON/plain text) straight into
      // the client's error message — cap and label it clearly instead so
      // the frontend's setStatus()/addLog() shows something actionable.
      const rawBody = await upstream.text().catch(() => '');
      const isRetryable = RETRYABLE_STATUSES.has(upstream.status);
      res.status(upstream.status).json({
        error: isRetryable
          ? `Meshy's asset CDN is temporarily unavailable (HTTP ${upstream.status}) ` +
            `after ${attempt} attempt(s). This is transient upstream congestion, not ` +
            `a bug in this app — try again in a few seconds.`
          : `Upstream returned HTTP ${upstream.status} ${upstream.statusText}.`,
        upstream_status: upstream.status,
        attempts: attempt,
        upstream_body_snippet: rawBody.replace(/\s+/g, ' ').trim().slice(0, 300),
      });
      return;
    }

    // Stream the successful response straight through.
    res.status(200);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    res.status(502).json({
      error: `Failed to fetch asset from Meshy after retries: ${msg}`,
    });
  }
}
