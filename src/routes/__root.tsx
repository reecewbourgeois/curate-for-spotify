import { TanStackDevtools } from '@tanstack/react-devtools'
import {
  Link,
  Outlet,
  createRootRoute,
  useRouter,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { BrandLogo, Icon } from '../components/Icons'
import { ToastProvider } from '../components/Toast'
import { AuthorizationRequired } from '../lib/auth'
import { formatSpotifyError, spotifySession } from '../lib/spotify-runtime'
import type { ErrorComponentProps } from '@tanstack/react-router'
import '../styles.css'

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: RootNotFoundComponent,
})

function RootComponent() {
  return (
    <ToastProvider>
      <div className="main-shell">
        <Outlet />
      </div>
      {import.meta.env.DEV ? (
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'TanStack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
      ) : null}
    </ToastProvider>
  )
}

function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  const isAuthError = error instanceof AuthorizationRequired
  const message = formatSpotifyError(error)

  return (
    <>
      <header className="topbar">
        <Link
          to="/"
          className="brand-link"
          aria-label="Curate home"
        >
          <BrandLogo />
        </Link>
      </header>
      <main className="route-state">
        <span className="complete-icon">
          <Icon name="info" />
        </span>
        <h2>{isAuthError ? 'Session expired' : 'Something went wrong'}</h2>
        <p>{message}</p>
        <div className="route-state-actions">
          {!isAuthError ? (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                reset()
                void router.invalidate()
              }}
            >
              <Icon name="refresh" /> Try again
            </button>
          ) : null}
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              spotifySession.disconnect()
              void router.navigate({
                to: '/',
                search: { authError: isAuthError ? message : undefined },
                replace: true,
              })
            }}
          >
            Back to sign in
          </button>
        </div>
      </main>
    </>
  )
}

function RootNotFoundComponent() {
  return (
    <>
      <header className="topbar">
        <Link
          to="/"
          className="brand-link"
          aria-label="Curate home"
        >
          <BrandLogo />
        </Link>
      </header>
      <main className="route-state">
        <span className="complete-icon">
          <Icon name="music" />
        </span>
        <h2>Page not found</h2>
        <p>The page you’re looking for doesn’t exist.</p>
        <div className="route-state-actions">
          <Link
            to="/"
            className="button primary"
          >
            Go home <Icon name="arrow" />
          </Link>
        </div>
      </main>
    </>
  )
}
