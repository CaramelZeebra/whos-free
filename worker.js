/**
 * Zero-knowledge storage endpoint for the "Who's Free?" calendar.
 *
 * This Worker never sees the password or plaintext calendar data —
 * only the encrypted blob the browser already produced. Its whole
 * job is: GET returns the last saved blob, PUT overwrites it.
 *
 * Deploy with Wrangler, and bind a KV namespace called CALENDAR_KV
 * (see README.md for exact steps).
 */

const ALLOWED_ORIGIN = "https://time.eliasro.de"; // or your custom domain, e.g. "https://www.eliasro.de"
const KV_KEY = "calendar-blob";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (request.method === "GET") {
      const blob = await env.CALENDAR_KV.get(KV_KEY);
      if (blob === null) {
        return new Response("not found", { status: 404, headers });
      }
      return new Response(blob, {
        status: 200,
        headers: { ...headers, "Content-Type": "text/plain" },
      });
    }

    if (request.method === "PUT") {
      const body = await request.text();
      // Basic sanity check: it should look like our JSON envelope
      // { salt, iv, data } — we don't decrypt it, just shape-check.
      try {
        const parsed = JSON.parse(body);
        if (!parsed.salt || !parsed.iv || !parsed.data) {
          throw new Error("bad shape");
        }
      } catch (e) {
        return new Response("invalid blob", { status: 400, headers });
      }
      await env.CALENDAR_KV.put(KV_KEY, body);
      return new Response("saved", { status: 200, headers });
    }

    return new Response("method not allowed", { status: 405, headers });
  },
};
