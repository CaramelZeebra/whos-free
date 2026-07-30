/**
 * Elias (Un)Availability — backend
 *
 * Each calendar lives in its own Durable Object, addressed by an opaque
 * slug (a hash of name+password, computed in the browser). The Worker
 * itself never sees a password or plaintext — only ciphertext blobs,
 * a write-auth hash (also password-derived, but a *different* derivation
 * than the encryption key), and version numbers for conflict detection.
 *
 * Routes:
 *   GET  /calendar/<slug>        -> { blob, version }  or 404
 *   PUT  /calendar/<slug>        -> body: { blob, expectedVersion, writeAuthHash, adminToken? }
 *
 * Durable Objects give us atomic read-modify-write per calendar, which is
 * what actually prevents two people's simultaneous edits from clobbering
 * each other — a plain KV store can't do this safely.
 */

const ALLOWED_ORIGIN = "https://time.eliasro.de";

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
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const match = url.pathname.match(/^\/calendar\/([a-f0-9]{16,64})$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    const slug = match[1];

    const id = env.CALENDAR_DO.idFromName(slug);
    const stub = env.CALENDAR_DO.get(id);

    let outgoingBody;
    if (request.method === "PUT") {
      const body = JSON.parse(await request.text());

      if (body.isCreate) {
        // Deciding whether this person is allowed to create a NEW calendar.
        // Two paths, checked here (not trusted from the client):
        //   1. Correct admin token (bootstrap path — only useful for the
        //      very first calendar, since it's the only "proof" available then).
        //   2. Proof of access to a *different, already-existing* calendar:
        //      we ask that calendar's own Durable Object "does this hash
        //      match yours?" and only get a boolean back — the other
        //      calendar's real write-auth value is never exposed to us,
        //      to the client, or to this calendar's storage.
        let authorized = false;

        if (body.adminToken && env.ADMIN_TOKEN && body.adminToken === env.ADMIN_TOKEN) {
          authorized = true;
        } else if (body.proofSlug && body.proofWriteAuthHash) {
          const proofId = env.CALENDAR_DO.idFromName(body.proofSlug);
          const proofStub = env.CALENDAR_DO.get(proofId);
          const verifyResp = await proofStub.fetch("https://do/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ writeAuthHash: body.proofWriteAuthHash }),
          });
          const verifyJson = await verifyResp.json();
          authorized = !!verifyJson.valid;
        }

        body._creationAuthorized = authorized;
      }

      outgoingBody = JSON.stringify(body);
    }

    const doResp = await stub.fetch("https://do/", {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body: request.method === "PUT" ? outgoingBody : undefined,
    });

    const respBody = await doResp.text();
    return new Response(respBody, {
      status: doResp.status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};

export class CalendarStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal-only: another calendar's Durable Object asking "does this
    // hash match your stored write-auth?" Returns a boolean only — never
    // the stored value itself. This is what lets someone prove access to
    // an existing calendar without that calendar's secret ever leaving it.
    if (request.method === "POST" && url.pathname === "/verify") {
      const body = await request.json();
      const stored = await this.state.storage.get("record");
      const valid = !!(stored && stored.writeAuthHash === body.writeAuthHash);
      return new Response(JSON.stringify({ valid }), { status: 200 });
    }

    if (request.method === "GET") {
      const stored = await this.state.storage.get("record");
      if (!stored) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      return new Response(
        JSON.stringify({ blob: stored.blob, version: stored.version }),
        { status: 200 }
      );
    }

    if (request.method === "PUT") {
      const body = await request.json();
      const stored = await this.state.storage.get("record");

      if (!stored) {
        // Creating a brand-new calendar — the outer Worker already decided
        // whether this is allowed (admin token, or verified proof of
        // access to another calendar) and tells us via _creationAuthorized.
        if (!body._creationAuthorized) {
          return new Response(JSON.stringify({ error: "forbidden: not authorized to create" }), { status: 403 });
        }
        const record = { blob: body.blob, version: 1, writeAuthHash: body.writeAuthHash };
        await this.state.storage.put("record", record);
        return new Response(JSON.stringify({ version: 1 }), { status: 200 });
      }

      // Existing calendar — must present the correct write-auth hash,
      // derived from the calendar's password. A stranger who doesn't
      // know the password can't produce this, so can't overwrite data.
      if (body.writeAuthHash !== stored.writeAuthHash) {
        return new Response(JSON.stringify({ error: "forbidden: bad write auth" }), { status: 403 });
      }

      // Optimistic concurrency: reject stale writes so two simultaneous
      // edits can't silently clobber each other.
      if (body.expectedVersion !== stored.version) {
        return new Response(
          JSON.stringify({ error: "conflict", version: stored.version }),
          { status: 409 }
        );
      }

      const record = { blob: body.blob, version: stored.version + 1, writeAuthHash: stored.writeAuthHash };
      await this.state.storage.put("record", record);
      return new Response(JSON.stringify({ version: record.version }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }
}
