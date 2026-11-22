# Nexus archivist

Unraid/Docker CBZ archivist for HentaiNexus. Same idea as folio-archivist: search, skip what is already on disk, write CBZ with ComicInfo.xml, sleep, repeat. Dashboard on port 8100.

How it works: the search and gallery pages give the metadata (title, artist, tags). The images come from the site's own zip download (`/zip/<id>`), which needs your login. The zip is turned into a CBZ by adding `ComicInfo.xml`. Blocked tags (lolicon, shotacon, loli, shota, toddlercon) are always skipped.

## Login and Start

The zip download only works while logged in. Open the dashboard and use the **Login** box with your HentaiNexus username and password. The password is sent once to the site and is never saved or logged; only the resulting session is stored in the config folder (`session.json`, readable by the container user only). When the session expires the dashboard shows a banner: just log in again, no cookies needed.

Nothing runs until you press **Start**. The container always boots stopped. Books you add with **Add a book** download on their own (still respecting the delay), even while stopped.

**Delay between downloads** is set in the dashboard in minutes (default 3). It applies immediately, even in the middle of a wait, so you can raise it quickly if you want to be gentler on your account.

If the site shows a CAPTCHA on its login form, the archivist cannot complete it and the Log will say so.

## Search chips and page limit

The Search query box works like folio's. Type in the box and pick a suggestion, then **Include** or **Exclude** it. Suggestions come from the site's own lists (tags, artists, authors, circles, events, magazines, parodies, publishers), with how often each is used. Anything the list does not have can still be added as typed, and **title** and **description** chips search those fields. The line under the chips shows the exact search that is sent, including the blocked-tag excludes that are always added. Chips save instantly.

**Each run, search only the newest N pages** sets how many result pages are searched every run. The box shows how many pages the site has for your search. `0` means every page. The default is 10.

## Sharing a folder with folio

You can point this and folio at the same library folder. Each tool decides "already have it" from the number at the start of a file name, and the two sites use overlapping numbers, so this tool names its files `HN22433 Title.cbz`. Folio ignores names that do not start with a digit, and this tool only counts names that start with `HN`, so neither skips or overwrites the other's books. Keep the default `FILE_PREFIX=HN`. An empty prefix brings the collisions back.

Files written by an earlier version have no prefix (`22433 Title.cbz`) and are not recognised, so rename them to `HN22433 Title.cbz` or they will be downloaded again.

## GitHub

1. Create an empty repo named `nexus-archivist` (no generated README).
2. Push this tree to `main`.
3. Settings → Actions → General → Workflow permissions → Read and write.
4. Wait for the Publish image workflow. It pushes `ghcr.io/<you>/nexus-archivist:latest`.
5. Profile → Packages → nexus-archivist → Package settings → Public.

## Unraid

Edit `unraid.xml` and make sure the Repository points at your GitHub user. Docker → Add Container → import the XML. Map Library to its own share, not the nhentai folder. Open `http://<tower>:8100/`, log in, and press Start.

In the dashboard, save a search query (for example `artist:"Aomushi"` or `tag:uncensored`) and press Start. Or paste a gallery link into Add a book: it downloads right away without waiting for the next cycle.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `FILE_PREFIX` | HN | Prefix on file names, so a folder shared with folio never mixes up ids. |
| `USER_AGENT` | Chrome | Override the browser User-Agent sent to the site. |
| `HN_TAGS` | empty | Optional starting filters, space separated (`tag:uncensored -tag:unbirth`). The dashboard chips replace it once saved. The site has no `language:` search. |
| `SLEEP_INTERVAL` | 3600 | Seconds to wait after a cycle. |
| `MAX_PER_CYCLE` | 10 | Cap on new CBZs per cycle. 0 = unlimited. |
| `CATCH_UP_STREAK` | 40 | Stop a cycle after this many already-have galleries in a row. |
| `REQUEST_DELAY_MS` | 1500 | Pause between page requests. Raise if you see 429. |
| `ZIP_TIMEOUT_SEC` | 900 | Longest a single zip download may take. |
| `LIBRARY_SPLIT` | 10000 | Folders of this many ids. 0 = flat. |

## Updating and rolling back

Every version is published as its own image tag (see CHANGELOG.md), and `latest` moves to the newest. To go back to an earlier version, set the container's **Repository** to that tag, for example `ghcr.io/valigha/nexus-archivist:1.4.1`, and apply. Settings, your saved login and the library are not touched. Pin a version tag if you do not want updates.

## Local

```bash
docker compose up --build
```

## Troubleshooting

The dashboard Log box shows the real reason a request failed.

- `LOGIN REQUIRED`: you are not logged in or the session expired. Log in again from the dashboard.
- `ENOTFOUND` / `EAI_AGAIN`: the container cannot resolve the site. Check Pi-hole, AdGuard or router blocking, or add `--dns 1.1.1.1` to Extra Parameters.
- `ENETUNREACH`: often broken IPv6. Add variable `NODE_OPTIONS` = `--dns-result-order=ipv4first`.
- `ECONNRESET` / `ETIMEDOUT` / `ECONNREFUSED`: a firewall, VPN or the site is dropping the connection.
- `403` or `Cloudflare challenge`: the site is refusing this server (bot protection or a block). Try a different `USER_AGENT`.
- `the zip contains no images` or `not a zip file`: the site returned something unexpected. Paste the log line when asking for help.
