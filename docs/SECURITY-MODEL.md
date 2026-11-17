# Security model

Nudge has no login of its own, so it protects itself by where it listens and by checking every request: loopback by
default, and Cloudflare Access's signed token for any hostname you put it behind. This page says exactly what is
checked, what it refuses to do, and what leaves your machine. To report a problem, see [SECURITY.md](../SECURITY.md).
Back to the [README](../README.md).

## How requests are checked

Nudge has no login of its own. The server listens on loopback (`127.0.0.1`) only, and every request is checked:

- the `Host` header must be loopback with the right port, or a name in `NUDGE_ACCESS_HOSTS` (blocks DNS rebinding);
- hosts listed in `NUDGE_ACCESS_HOSTS` sit behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/).
  There the signed `Cf-Access-Jwt-Assertion` token is verified (RS256 signature against the team's published keys,
  issuer `https://<NUDGE_ACCESS_TEAM_DOMAIN>`, audience `NUDGE_ACCESS_AUD`, expiry), and the email in the verified token
  must equal one of `NUDGE_ALLOWED_USERS` (exact match, never a domain). The plain `Cf-Access-Authenticated-User-Email`
  header is never read. Any failure rejects the request, and so does Cloudflare traffic carrying a loopback `Host`. A
  stream that is already open (the live event feed) is not re-checked, so it can outlive the token until the page
  reconnects. The token is ignored on every other host. Only the static files a browser fetches without credentials to
  install the PWA (`/manifest.webmanifest`, `/sw.js`, the icons) are served to an Access host without a token, so the
  Access policy needs a bypass for exactly those paths;
- changing requests must have a same-origin `Origin` (when sent) and the `X-Nudge: 1` header;
- stored secrets (API keys, tokens) are never sent back to the browser, and Nudge only reads from GitHub: snoozing or
  clearing an item changes nothing on GitHub, and a drafted follow-up is text you copy and post yourself.

Do not expose the port anywhere else: a request that reaches it directly with a loopback `Host` is treated as local.
Nudge refuses to start if `NUDGE_ACCESS_HOSTS` is set without `NUDGE_ALLOWED_USERS` (that would admit everyone Access
lets in) or if the Access settings are incomplete, and warns when bound to a non-loopback address. Containers need
`0.0.0.0` inside, so publish the port to `127.0.0.1` only, as `compose.yaml` does. See
[Deploying](DEPLOYING.md#docker--cloudflare-access). To report a security problem, see [SECURITY.md](../SECURITY.md).

## Your data and third parties

- Comment text, author names and your refresh token are stored in the local SQLite database, indefinitely. You supply
  your own YouTube API key and Google Cloud project, and you are responsible for complying with the
  [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service) and
  Developer Policies (including how long you keep API data).
- When the optional assistant, or the offline classifier tooling, is enabled, comment text and video titles are sent to
  Anthropic using your own API key. Voice dictation in the browser may send audio to your browser vendor's service.
- Nudge is not affiliated with or endorsed by YouTube, Google, GitHub or Anthropic. "YouTube" is a trademark of
  Google LLC.
