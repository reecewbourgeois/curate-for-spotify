# Curate for Spotify

An open-source, client-only Spotify playlist builder. Pick any source playlist (or Liked Songs) and any target playlist, listen through your queue at your own pace, add favorites straight to your target, or skip tracks for later. Curate remembers every source-to-target pairing and every song you have added, played, or skipped—even when shuffle is turned on.

## Features

- **Per-pair progress memory**: Switch between pairings (e.g., _Liked Songs → Driving_, _Liked Songs → Focus_) without losing your place.
- **Direct playlist adds & Undo**: Add songs directly to your target playlist via Spotify's `/playlists/{id}/items` endpoint. Undoing an add removes the track from the target playlist and puts it back in Remaining.
- **Tracked shuffle**: Shuffle your remaining queue while still tracking every reviewed track.
- **Resilient Spotify playback sync**: Uses `GET /me/player` with fallback to `currently-playing`, retry/backoff on transient drops and `429` rate limits, visibility-aware re-sync, interactive seeking, and active device discovery.
- **Local-first & static**: Runs completely in your browser with PKCE OAuth (no backend, no Client Secret). Export or import your local progress as JSON anytime.

## Local Development

1. **Create a Spotify Developer App**:
   - Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app with **Web API** enabled.
   - Add `http://127.0.0.1:3000/` (including the trailing slash) as a Redirect URI.
   - Copy your app's **Client ID**.

2. **Configure environment variables** (optional—you can also paste your Client ID in the UI):

   ```bash
   cp .env.example .env
   ```

   Set `VITE_SPOTIFY_CLIENT_ID` and `VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/`.

3. **Install and run**:
   ```bash
   pnpm install
   pnpm dev
   ```
   Open `http://127.0.0.1:3000/` in your browser (Spotify does not accept `http://localhost` as a redirect URI).

## Spotify OAuth Scopes

Curate requests the following scopes via Authorization Code with PKCE:

- `user-read-private`
- `user-library-read`
- `playlist-read-private`, `playlist-read-collaborative`
- `playlist-modify-public`, `playlist-modify-private`
- `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`

## Scripts

- `pnpm dev` — start local dev server on port 3000
- `pnpm build` — production build (`dist/` includes `404.html` SPA fallback for GitHub Pages)
- `pnpm lint` — run `oxlint`
- `pnpm fmt` — format with `oxfmt`

## Deploying to GitHub Pages

A GitHub Actions workflow is included at `.github/workflows/deploy.yml`.

1. Enable **Settings → Pages → Source: GitHub Actions** in your repository.
2. Add your deployed URL (e.g. `https://<username>.github.io/<repo>/`) as a Redirect URI in your Spotify Developer App.
3. Push to `main` to build and deploy.
