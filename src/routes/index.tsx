import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  BrandLogo,
  Icon,
  SpotifyAttribution,
  SpotifyIcon,
} from '../components/Icons'
import {
  completeSpotifyAuth,
  getConfiguredClientId,
  getSetupRedirectUri,
  hasPendingCallback,
  startSpotifyAuth,
} from '../lib/auth'
import { spotifySession } from '../lib/spotify-runtime'

interface IndexSearch {
  readonly authError?: string
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    authError:
      typeof search.authError === 'string' ? search.authError : undefined,
  }),
  beforeLoad: async () => {
    if (hasPendingCallback(window.location.search)) {
      try {
        const token = await completeSpotifyAuth(window.location.search)
        spotifySession.setToken(token)
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Could not complete Spotify sign-in. Please try again.'
        throw redirect({
          to: '/',
          search: { authError: message },
          replace: true,
        })
      }
      throw redirect({
        to: '/curate',
        replace: true,
      })
    }

    if (spotifySession.isAuthenticated) {
      throw redirect({
        to: '/curate',
        replace: true,
      })
    }
  },
  pendingComponent: AuthPendingSplash,
  component: LandingPage,
})

function AuthPendingSplash() {
  return (
    <>
      <header className="topbar">
        <BrandLogo />
      </header>
      <main className="route-state">
        <span className="loading-spinner" />
        <h2>Connecting to Spotify…</h2>
        <p>Completing your secure sign-in and loading your library.</p>
      </main>
    </>
  )
}

function LandingPage() {
  const { authError } = Route.useSearch()
  const [authorizing, setAuthorizing] = useState(false)
  const [errorMessage, setErrorMessage] = useState(authError ?? '')

  useEffect(() => {
    setErrorMessage(authError ?? '')
  }, [authError])

  const isConfigured = /^[a-zA-Z0-9]{32}$/.test(getConfiguredClientId())
  const redirectUri = getSetupRedirectUri()
  const isLocalhost = window.location.hostname === 'localhost'

  const handleSignIn = async () => {
    if (authorizing) return
    setAuthorizing(true)
    setErrorMessage('')
    try {
      await startSpotifyAuth()
    } catch (error) {
      setAuthorizing(false)
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Could not connect to Spotify.',
      )
    }
  }

  return (
    <>
      <header className="topbar">
        <BrandLogo />
        <div className="header-actions">
          <button
            type="button"
            className="connect-button"
            disabled={authorizing || !isConfigured}
            onClick={() => void handleSignIn()}
          >
            <SpotifyIcon />
            <span>{authorizing ? 'Connecting…' : 'Sign in with Spotify'}</span>
          </button>
        </div>
      </header>

      <main className="setup-page">
        <section className="setup-intro">
          <div className="eyebrow">
            <span /> YOUR MUSIC. A FRESH START.
          </div>
          <h1>
            Less scrolling.
            <br />
            More <em>listening.</em>
          </h1>
          <p>
            Work through your Liked Songs or any playlist, one track at a time.
            Curate remembers each source-to-target pairing—every song added,
            played, and skipped—even with shuffle on.
          </p>
          <div className="setup-promise">
            <Icon name="shield" /> Source playlists stay untouched. Local-first
            progress.
          </div>
        </section>

        <section
          className="setup-grid"
          aria-label="How Curate works"
        >
          <div className="setup-guide">
            <div className="eyebrow">HOW IT WORKS</div>
            <h2>Pick a source. Build your next favorite.</h2>
            <p>
              Curate connects directly to your Spotify library and active player
              so you can sort tracks without losing your place.
            </p>
            <ol className="setup-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>Pair any source with a target.</h3>
                  <p>
                    Start from your Liked Songs or any playlist, and choose—or
                    create—the target playlist you’re building.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Listen at your own pace.</h3>
                  <p>
                    Play directly on your active Spotify device, add favorites
                    in one click, or skip tracks for later—even with shuffle on.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Pick up right where you left off.</h3>
                  <p>
                    Every pairing and track decision is remembered locally in
                    your browser, with one-click undo whenever you change your
                    mind.
                  </p>
                </div>
              </li>
            </ol>
          </div>

          <div className="signin-card panel">
            <div className="connect-logo">
              <SpotifyIcon />
            </div>
            <div className="eyebrow">BRING YOUR OWN GOOD MUSIC</div>
            <h2>
              {authorizing ? 'Connecting to Spotify…' : 'Ready when you are.'}
            </h2>
            <p>
              {authorizing
                ? 'Opening Spotify for secure sign-in. You may be asked to approve playlist and playback access.'
                : 'Sign in with your Spotify account to load your playlists and start curating.'}
            </p>

            <p
              className="form-error"
              role="alert"
            >
              {errorMessage}
            </p>

            <button
              className="button primary full-width"
              type="button"
              disabled={authorizing || !isConfigured}
              onClick={() => void handleSignIn()}
            >
              {authorizing ? (
                <span className="loading-spinner small-spinner" />
              ) : (
                <SpotifyIcon />
              )}
              {authorizing ? 'Connecting…' : 'Sign in with Spotify'}{' '}
              <Icon name="arrow" />
            </button>

            {!isConfigured ? (
              <div className="redirect-note">
                Spotify sign-in is not configured in this build. Set{' '}
                <code>VITE_SPOTIFY_CLIENT_ID</code> to enable sign-in.
              </div>
            ) : null}

            {import.meta.env.DEV && isLocalhost ? (
              <div className="redirect-note">
                You’re using localhost. Open{' '}
                <a href={redirectUri}>{redirectUri}</a> before signing in.
              </div>
            ) : null}

            <div className="signin-details">
              <p>
                <Icon name="check" /> Library, playlist read/write, and playback
                sync access.
              </p>
              <p>
                <Icon name="check" /> Pairings &amp; listening progress stay in
                this browser.
              </p>
              <p>
                <Icon name="check" /> Spotify Premium is required for remote
                playback controls.
              </p>
            </div>
          </div>
        </section>

        <footer className="setup-footer">
          <span>
            Choose a source. Choose a target. Find your next on repeat.
          </span>
          <SpotifyAttribution />
        </footer>
      </main>
    </>
  )
}
