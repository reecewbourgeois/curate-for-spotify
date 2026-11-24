import { createFileRoute, redirect } from '@tanstack/react-router'
import { BrandLogo } from '../components/Icons'
import { completeSpotifyAuth, hasPendingCallback } from '../lib/auth'
import { spotifySession } from '../lib/spotify-runtime'

export const Route = createFileRoute('/')({
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
          to: '/setup',
          search: { error: message },
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

    throw redirect({
      to: '/setup',
      replace: true,
    })
  },
  pendingComponent: AuthPendingSplash,
  component: AuthPendingSplash,
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
