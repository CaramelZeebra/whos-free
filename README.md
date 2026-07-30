# Who's Free? — a password-locked shared calendar

A tiny static site (goes on GitHub Pages, next to your existing site)
plus one small Cloudflare Worker that stores an **encrypted blob** —
nothing else. Your friends' calendar entries are encrypted and
decrypted entirely in their browser with the shared password; the
Worker and its storage never see plaintext or the password itself
(a "zero-knowledge" design).

## How the security works

1. Someone opens the page and types the shared password.
2. The browser fetches the current ciphertext from the Worker.
3. The browser derives an AES key from the password using PBKDF2
   (250,000 iterations, SHA-256) and decrypts locally.
4. When someone toggles a day, the browser re-encrypts the whole
   dataset with a fresh random salt/IV and PUTs it back to the Worker.
5. The Worker just stores/returns bytes — it has no idea what they mean.

**What this protects against:** anyone who finds your Worker URL or
your GitHub repo can only ever see ciphertext. **What it doesn't
protect against:** anyone who has the shared password (which is by
design — that's your friend group), and anyone running code in the
same browser tab (e.g. a malicious browser extension). This is a
reasonable amount of security for "keep casual eavesdroppers out",
not for legally sensitive data.

If a friend forgets the password, there's no recovery — that's the
tradeoff of zero-knowledge. Pick a password you can share once
(e.g. in a group chat) and everyone saves it.

## Part 1 — Deploy the Worker (the storage backend)

You need a free Cloudflare account.

```bash
npm install -g wrangler
wrangler login
```

From this folder:

```bash
# Create the KV namespace that will hold the one encrypted blob
wrangler kv namespace create CALENDAR_KV
```

This prints something like:
```
[[kv_namespaces]]
binding = "CALENDAR_KV"
id = "abcd1234..."
```

Copy that `id` into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

Open `worker.js` and set `ALLOWED_ORIGIN` to wherever your GitHub
Pages site will live, e.g.:
```js
const ALLOWED_ORIGIN = "https://www.eliasro.de";
```
(This is just CORS — it stops other websites from calling your
Worker from a browser. It's not a security boundary against someone
directly hitting the API with curl, but combined with the encryption
that's fine here.)

Deploy:
```bash
wrangler deploy
```

Wrangler will print your Worker's URL, something like:
```
https://whosfree-calendar.YOUR-SUBDOMAIN.workers.dev
```
Your API endpoint is that URL + `/blob`, e.g.:
```
https://whosfree-calendar.YOUR-SUBDOMAIN.workers.dev/blob
```

## Part 2 — Configure and deploy the frontend

Open `index.html` and set:
```js
const WORKER_URL = "https://whosfree-calendar.YOUR-SUBDOMAIN.workers.dev/blob";
```

Then either:

**A) Add it to your existing GitHub Pages repo**, e.g. as
`www.eliasro.de/calendar/index.html` — just commit this `index.html`
into a `calendar/` folder in your existing repo.

**B) Make it a separate repo/subdomain**, e.g. `calendar.eliasro.de`
— create a new repo, enable Pages on it, and add a CNAME record at
your DNS provider pointing `calendar` → `<username>.github.io`, plus
a `CNAME` file in the repo containing `calendar.eliasro.de`.

Commit and push. GitHub Pages usually goes live within a minute or two.

## Part 3 — First use

The first person to open the page and enter a password **creates**
the calendar — whatever password they type becomes the shared
password. Share that password with your friends once (group chat,
in person, etc.) and everyone uses the same one going forward.

## Local testing before you deploy

You can preview the page locally, but note the Worker call will fail
CORS unless `ALLOWED_ORIGIN` matches. Easiest: temporarily set
`ALLOWED_ORIGIN = "*"` in `worker.js` while testing, then lock it
back down before sharing the link with friends.

```bash
python3 -m http.server 8000
# visit http://localhost:8000
```

## Files in this project

- `index.html` — the whole frontend: UI, AES-GCM/PBKDF2 encryption, calendar rendering
- `worker.js` — the Cloudflare Worker: GET/PUT the encrypted blob to KV
- `wrangler.toml` — Worker deployment config
