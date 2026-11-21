# Nexus archivist

Unraid/Docker CBZ archivist for HentaiNexus. Same idea as folio-archivist: search, skip what is already on disk, write CBZ with ComicInfo.xml, sleep, repeat. Dashboard on port 8100.

It reads public gallery and read pages. It does not call `/zip/`. Blocked tags (lolicon, shotacon, loli, shota, toddlercon) are always skipped.

## GitHub

1. Create an empty repo named `nexus-archivist` (no generated README).
2. Push this tree to `main`.
3. Settings → Actions → General → Workflow permissions → Read and write.
4. Wait for the Publish image workflow. It pushes `ghcr.io/<you>/nexus-archivist:latest`.
5. Profile → Packages → nexus-archivist → Package settings → Public.

## Unraid

Edit `unraid.xml` and replace `YOUR_USER`. Docker → Add Container → import the XML. Map Library to its own share, not the nhentai folder. Open `http://<tower>:8100/`.

## Local

```bash
docker compose up --build