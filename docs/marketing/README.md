# Marketing assets

Screenshots, a short flight GIF and GitHub social preview cards for Asteroids.
Every image is a capture of the real game or is built from those captures and
the game's own ship drawings, with real type. Nothing is generated or mocked.
`manifest.json` lists each file with its size, SHA-256 hash and source.

The images are © Rico Trebeljahr, all rights reserved. Third-party art inside
them (the background photo, the Flaticon asteroid and ammo icons, the
Openclipart heart) keeps its own terms; see the README's licence section.

## Screenshots

Captured on 2026-11-06 from a local client and game server (no database, no
Redis) at commit `7acb232`, in headless Chromium with sound muted. The
client's `Math.random` is seeded, so the singleplayer field is the same on
each run; the duel's field comes from the server and changes.

| File | Pixels | Shows |
| --- | --- | --- |
| `screenshots/singleplayer.jpg` | 3200×2000 (1600×1000 at 2×) | A singleplayer run on the first leg: thrust trail, asteroids, heart pickups, full health, route timer. README hero. |
| `screenshots/duel.jpg` | 3200×2000 | A 1v1 duel between two browser contexts: both ships, ammo pickups, hearts, ammo counter, minimap. |
| `screenshots/phone-landscape.jpg` | 2532×1170 (844×390 at 3×) | A singleplayer run on a phone in landscape, with the touch buttons. |
| `screenshots/menu-ships.jpg` | 3200×2000 | The main menu: the six ships, stats and the three modes. |
| `screenshots/flight.gif` | 560×350, 3.6 s, 15 fps | Thrusting and turning through the field (recorded video, converted with ffmpeg). |

`singleplayer.jpg` and `duel.jpg` were picked by eye from `--burst` frames of
two runs and re-encoded with ffmpeg (`-q:v 4`) to keep them near 300 KiB.

## Social preview cards

1280×640 PNG, each under 700 KiB, key content inside a 64 px margin. Built
from `social-preview/template.html` with Trebuchet MS, the game's menu font.

| File | Idea |
| --- | --- |
| `social-preview/social-preview-a.png` | Screenshot-led: the singleplayer capture fills the card; wordmark, one line and the URL on a darkened left side. |
| `social-preview/social-preview-b.png` | Typographic: the game's space gradient, a large wordmark and the six ship drawings. No third-party art. |
| `social-preview/social-preview-c.png` | Three framed captures: solo run, 1v1 duel, phone. |

None is uploaded to GitHub yet; the repository owner picks one.

## og:image cards

1200×630 PNG, the Open Graph size, built from card A of the same template. The
card is laid out at 1280×672 (the same 1.91:1 shape), shot at 2× and scaled
down to exactly 1200×630 with ImageMagick.

| File | Shows |
| --- | --- |
| `social-preview/og-wordmark.png` | Card A with wordmark and line on the darkened left side, without the URL. |

`og-wordmark.png` is also the site's og:image, as `client/public/og-card.jpg` (JPEG, quality 88, 4:4:4): `magick docs/marketing/social-preview/og-wordmark.png -strip -sampling-factor 4:4:4 -interlace JPEG -quality 88 client/public/og-card.jpg`.
| `social-preview/og-clean.png` | No text: the singleplayer capture reframed so the ship sits right of centre and the HUD falls outside. |

## Rebuilding

Both scripts need Playwright with a Chromium. It is not a dependency of this
repo: install it globally, or point `PLAYWRIGHT_MODULE` at any Playwright
package folder and, if its own browser is missing, `CHROMIUM_PATH` at a
Chromium binary. `--gif` also needs ffmpeg; the og:image cards need
ImageMagick (`magick`).

```bash
# 1. Game server and client on free ports (no Docker needed).
(cd server && PORT=<api port> node --import tsx ./src/server.ts)
(cd client && API_PORT=<api port> npx vite --port <web port> --strictPort --host 127.0.0.1)

# 2. Screenshots into docs/marketing/screenshots/. --burst=6 writes six more
#    frames per scene to BURST_DIR to pick from; --gif records flight.gif.
BASE_URL=http://127.0.0.1:<web port> pnpm marketing:screenshots -- --burst=6 --gif

# 3. Cards into docs/marketing/social-preview/, and manifest.json.
#    REVIEW_DIR=<folder> also writes copies and a labelled review-sheet.jpg there.
pnpm marketing:social-preview
# Only the two og:image cards (leaves the 1280x640 cards alone):
pnpm marketing:social-preview --og
```

Card A and C place the screenshots with fixed `background-position` values.
Check them after a new capture.
