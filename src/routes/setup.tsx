import { createFileRoute, redirect } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import {
  BrandLogo,
  Icon,
  SpotifyAttribution,
  SpotifyIcon,
} from '../components/Icons'
import { useToast } from '../components/Toast'
import {
  getSavedClientId,
  getSetupRedirectUri,
  startSpotifyAuth,
} from '../lib/auth'
import { spotifySession } from '../lib/spotify-runtime'
import type { FormEvent } from 'react'

interface SetupSearch {
  readonly error?: string
}

export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>): SetupSearch => ({
    error: typeof search.error === 'string' ? search.error : undefined,
  }),
  beforeLoad: () => {
    if (spotifySession.isAuthenticated) {
      throw redirect({ to: '/curate', replace: true })
    }
  },
  component: SetupPage,
})

function SetupPage() {
  const { error: routeError } = Route.useSearch()
  const { showToast } = useToast()
  const [clientId, setClientId] = useState(() => getSavedClientId())
  const [authorizing, setAuthorizing] = useState(false)
  const [formError, setFormError] = useState(routeError ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  const redirectUri = getSetupRedirectUri()
  const isLocalhost = window.location.hostname === 'localhost'

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (authorizing) return
    const trimmed = clientId.trim()
    if (!trimmed) {
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      inputRef.current?.focus()
      return
    }
    setAuthorizing(true)
    setFormError('')
    try {
      await startSpotifyAuth(trimmed)
    } catch (error) {
      setAuthorizing(false)
      setFormError(
        error instanceof Error
          ? error.message
          : 'Could not connect to Spotify.',
      )
      inputRef.current?.focus()
    }
  }

  const handleCopyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri)
      showToast('Redirect URI copied.')
    } catch {
      showToast('Could not copy to clipboard. Copy the URI manually.', true)
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
            disabled={authorizing}
            onClick={() => void handleSubmit()}
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
            <Icon name="shield" /> Source playlists stay untouched. No Client
            Secret. Local-first progress.
          </div>
        </section>

        <section
          className="setup-grid"
          aria-label="Getting started"
        >
          <div className="setup-guide">
            <div className="eyebrow">A ONE-TIME SETUP</div>
            <h2>Make yourself at home.</h2>
            <p>
              Spotify requires you to connect with your own developer app Client
              ID. It only takes a minute.
            </p>
            <ol className="setup-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>Log in to Spotify’s API dashboard.</h3>
                  <p>
                    Open the{' '}
                    <a
                      href="https://developer.spotify.com/dashboard"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Spotify developer dashboard <Icon name="external" />
                    </a>{' '}
                    and sign in with your Spotify account.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Create an app for Curate.</h3>
                  <p>
                    Choose <strong>Create app</strong>, give it a name and
                    description, and select <strong>Web API</strong>.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Register your redirect URI.</h3>
                  <p>
                    In the app’s settings, add this exact address—including the
                    trailing slash—and save it.
                  </p>
                  <div className="redirect-value">
                    <code>{redirectUri}</code>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void handleCopyRedirect()}
                      aria-label="Copy redirect URI"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="setup-hint">
                    Use HTTPS when deployed, or http://127.0.0.1 for local
                    development. Never http://localhost or a wildcard.
                  </p>
                </div>
              </li>
              <li>
                <span>04</span>
                <div>
                  <h3>Copy the Client ID and sign in.</h3>
                  <p>
                    Paste your app’s public <strong>Client ID</strong> here. Do
                    not copy or share the Client Secret.
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
                : 'Already have a Spotify app? Paste your Client ID and you’re one step away.'}
            </p>

            <form
              id="connect-form"
              onSubmit={(e) => void handleSubmit(e)}
            >
              <label htmlFor="client-id">Spotify app Client ID</label>
              <input
                ref={inputRef}
                className="form-input"
                id="client-id"
                name="client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Your 32-character public Client ID"
                autoComplete="off"
                required
                pattern="[a-zA-Z0-9]{32}"
                disabled={authorizing}
              />
              <small>
                Your public Client ID is saved on this device. OAuth tokens live
                only in this browser tab’s session storage.
              </small>
              <p
                className="form-error"
                role="alert"
              >
                {formError}
              </p>
              <button
                className="button primary full-width"
                type="submit"
                disabled={authorizing}
              >
                {authorizing ? (
                  <span className="loading-spinner small-spinner" />
                ) : (
                  <SpotifyIcon />
                )}
                {authorizing ? 'Connecting…' : 'Sign in with Spotify'}{' '}
                <Icon name="arrow" />
              </button>
            </form>

            {isLocalhost ? (
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
            <p className="setup-hint">
              In Spotify Development Mode, make sure your account is listed
              under User Management in the Spotify dashboard.
            </p>
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
