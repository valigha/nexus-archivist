# Nexus archivist

Unraid/Docker CBZ archivist for HentaiNexus. Same idea as folio-archivist: search, skip what is already on disk, write CBZ with ComicInfo.xml, sleep, repeat. Dashboard on port 8100.

How it works: the search and gallery pages give the metadata (title, artist, tags). The images come from the site's own zip download (`/zip/<id>`), which needs your login. The zip is turned into a CBZ by adding `ComicInfo.xml`. Blocked tags (lolicon, shotacon, loli, shota, toddlercon) are always skipped.

## Authentication (required)

The zip download only works while logged in, so the container needs your session. Put it in the **COOKIE** variable of the Unraid template.

1. Log in to hentainexus.com in a browser.
2. Press F12, open the **Network** tab, and reload the page.
3. Click the first request (the page itself), find **Request Headers**, and copy the whole value after `Cookie:`.
4. Paste it into the **COOKIE** variable and apply.

Notes:

- Paste only the value, not the word `Cookie:`.
- Treat it like a password. Anyone with it can use your session.
- It expires. When downloads fail with `LOGIN REQUIRED`, log in again and replace it. The dashboard shows a red banner when this happens.
- If Cloudflare also blocks the server, set `USER_AGENT` to the exact User-Agent of the same browser, and copy the cookie from a browser on the same network as the server.

## GitHub

1. Create an empty repo named `nexus-archivist` (no generated README).
2. Push this tree to `main`.
3. Settings → Actions → General → Workflow permissions → Read and write.
4. Wait for the Publish image workflow. It pushes `ghcr.io/<you>/nexus-archivist:latest`.
5. Profile → Packages → nexus-archivist → Package settings → Public.

## Unraid

Edit `unraid.xml` and make sure the Repository points at your GitHub user. Docker → Add Container → import the XML. Map Library to its own share, not the nhentai folder. Set COOKIE. Open `http://<tower>:8100/`.

In the dashboard, save a search query (for example `artist:"Aomushi"` or `tag:uncensored`) and press Run now. Or paste a gallery link into Add a book: it downloads right away without waiting for the next cycle.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `COOKIE` | empty | Required. Your logged-in Cookie header. |
| `USER_AGENT` | Chrome | Set to your browser's User-Agent if Cloudflare ties the cookie to it. |
| `HN_TAGS` | empty | Search query. Empty waits for the dashboard. |
| `SLEEP_INTERVAL` | 3600 | Seconds to wait after a cycle. |
| `MAX_PER_CYCLE` | 10 | Cap on new CBZs per cycle. 0 = unlimited. |
| `CATCH_UP_STREAK` | 40 | Stop a cycle after this many already-have galleries in a row. |
| `REQUEST_DELAY_MS` | 1500 | Pause between page requests. Raise if you see 429. |
| `ZIP_DELAY_MS` | 5000 | Pause after each zip download. |
| `ZIP_TIMEOUT_SEC` | 900 | Longest a single zip download may take. |
| `LIBRARY_SPLIT` | 10000 | Folders of this many ids. 0 = flat. |

## Local

```bash
docker compose up --build
```

## Troubleshooting

The dashboard Log box shows the real reason a request failed.

- `LOGIN REQUIRED`: the COOKIE is missing or expired. See Authentication above.
- `ENOTFOUND` / `EAI_AGAIN`: the container cannot resolve the site. Check Pi-hole, AdGuard or router blocking, or add `--dns 1.1.1.1` to Extra Parameters.
- `ENETUNREACH`: often broken IPv6. Add variable `NODE_OPTIONS` = `--dns-result-order=ipv4first`.
- `ECONNRESET` / `ETIMEDOUT` / `ECONNREFUSED`: a firewall, VPN or the site is dropping the connection.
- `403` or `Cloudflare challenge`: use a cookie and User-Agent from a browser that can open the site, on the same network as the server.
- `the zip contains no images` or `not a zip file`: the site returned something unexpected. Paste the log line when asking for help.
