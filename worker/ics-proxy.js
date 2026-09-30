/**
 * ics-proxy: a tiny Cloudflare Worker that fetches an iCalendar file on behalf of
 * the validator page, for servers that block cross-origin (CORS) requests.
 *
 * Request:  POST {"url": "https://example.com/calendar.ics"}
 * Response: the calendar text, readable only by the sites in ALLOWED_ORIGINS.
 *
 * Nothing is stored or logged by this code.
 */

// Sites allowed to use this proxy. Add your custom domain here if you get one.
const ALLOWED_ORIGINS = [
  'https://icalcheck.github.io',
];

// Optional: limit which calendar hosts may be fetched, e.g. ['pitchup.com'].
// Subdomains are included. Leave empty to allow any public host.
const ALLOWED_HOSTS = [];

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const TIMEOUT_MS = 15000;

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
      'Cache-Control': 'no-store',
    };
    const reply = (status, text) =>
      new Response(text, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!allowed) return reply(403, 'This proxy only serves the iCalendar validator site.');
    if (request.method !== 'POST') return reply(405, 'Use POST with a JSON body: {"url": "https://..."}');

    let target;
    try {
      const body = await request.json();
      target = new URL(String(body.url).replace(/^webcals?:\/\//i, 'https://'));
    } catch {
      return reply(400, 'Send a JSON body like {"url": "https://example.com/calendar.ics"}.');
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return reply(400, 'Only http(s) URLs are supported.');
    if (isPrivateHost(target.hostname)) return reply(400, 'That host is not allowed.');
    if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.some(h => target.hostname === h || target.hostname.endsWith('.' + h)))
      return reply(403, `This proxy only fetches calendars from: ${ALLOWED_HOSTS.join(', ')}.`);

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        headers: { 'Accept': 'text/calendar, text/plain;q=0.8, */*;q=0.5', 'User-Agent': 'ics-validator-proxy/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return reply(502, `Could not reach the calendar server (${e.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
    }
    if (!upstream.ok) return reply(502, `The calendar server answered HTTP ${upstream.status}.`);
    if (Number(upstream.headers.get('Content-Length')) > MAX_BYTES) return reply(413, 'The file is larger than 5 MB.');

    // Read with a hard size cap
    const reader = upstream.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { reader.cancel(); return reply(413, 'The file is larger than 5 MB.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
    const text = new TextDecoder('utf-8').decode(bytes);

    // Only pass calendars through, so this cannot be used as a general-purpose proxy
    const type = (upstream.headers.get('Content-Type') || '').toLowerCase();
    if (!type.includes('calendar') && !/BEGIN:VCALENDAR/i.test(text))
      return reply(415, 'That URL did not return an iCalendar file (it may be a login or error page).');

    return reply(200, text);
  },
};

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 literal
  return /^\d+(\.\d+){3}$/.test(h); // IPv4 literal
}
