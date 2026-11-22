# Changelog

Every release is kept as its own image tag, so you can go back to an earlier one.
`latest` always points at the newest build. Pin Unraid to a version to freeze it.

| Unraid Repository | Meaning |
| --- | --- |
| `ghcr.io/valigha/nexus-archivist:latest` | newest, may change |
| `ghcr.io/valigha/nexus-archivist:1.5.3` | that release, frozen |
| `ghcr.io/valigha/nexus-archivist:v1.5.3` | same image, `v` prefix |

To roll back: Unraid → Docker → edit the container → set **Repository** to the older version tag → Apply. Your settings, session and library are untouched. The code for each release is kept on a `release/vX.Y.Z` branch.

## 1.5.3

- Fix: release workflow resolved the commit incorrectly

## 1.5.2

- Fix: automatic GitHub Release now tags with git before creating the release

## 1.5.1

- A GitHub Release (with notes from this file) is now created automatically for every version

## 1.5.0

- Dashboard shows the whole library (every `.cbz`, including folio's) and a separate count of books Nexus saved
- Rescan button, plus an automatic rescan every hour so books other tools add are counted
- The count rises as books are saved, without a rescan

## 1.4.1 (stable fallback: `release/v1.4.1`)

- Library is scanned in the background at startup; the Log reports what it found
- Library path text now allows sharing with folio

## 1.4.0

- Files are named `HN<id> Title.cbz` (`FILE_PREFIX`) so a library shared with folio never mixes up ids

## 1.3.x

- Folio-style dashboard, search chips with suggestions from the site's lists, newest-N-pages limit, add-a-book progress
- Warns when a chip has the wrong type (for example `tag:fakku` vs `publisher:fakku`)
- Bracketed `HN_TAGS` lists are accepted; unsupported filters are skipped
- A search that finds nothing says why

## 1.2.x

- Log in from the dashboard instead of a cookie; Start/Stop; adjustable delay between downloads (default 3 min)
- Downloads follow the site's redirect to its download host with the login; resume after a drop, stall detection, cool-down after a stalled attempt; Stop aborts a running download

## 1.1.0

- Downloads use the site's own zip

## 1.0.x

- Dashboard fixes, real error messages, connection timeout fixes, queue downloads immediately
