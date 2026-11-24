import type { ReactNode } from 'react'

export type IconName =
  | 'arrow'
  | 'check'
  | 'chevron'
  | 'clock'
  | 'close'
  | 'device'
  | 'dots'
  | 'down'
  | 'external'
  | 'headphones'
  | 'heart'
  | 'info'
  | 'logout'
  | 'music'
  | 'pause'
  | 'play'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'settings'
  | 'shield'
  | 'shuffle'
  | 'skip'
  | 'undo'

const ICON_PATHS: Record<IconName, ReactNode> = {
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  clock: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
      />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  device: (
    <>
      <rect
        x="4"
        y="3"
        width="16"
        height="18"
        rx="2"
      />
      <circle
        cx="12"
        cy="14"
        r="3.5"
      />
      <circle
        cx="12"
        cy="7.5"
        r="1"
        fill="currentColor"
      />
    </>
  ),
  dots: (
    <>
      <circle
        cx="5"
        cy="12"
        r="1"
        fill="currentColor"
      />
      <circle
        cx="12"
        cy="12"
        r="1"
        fill="currentColor"
      />
      <circle
        cx="19"
        cy="12"
        r="1"
        fill="currentColor"
      />
    </>
  ),
  down: <path d="m6 9 6 6 6-6" />,
  external: (
    <>
      <path d="M14 3h7v7M21 3 10 14" />
      <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
    </>
  ),
  headphones: (
    <>
      <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
      <rect
        x="3"
        y="12"
        width="4"
        height="9"
        rx="2"
      />
      <rect
        x="17"
        y="12"
        width="4"
        height="9"
        rx="2"
      />
    </>
  ),
  heart: (
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
  ),
  info: (
    <>
      <circle
        cx="12"
        cy="12"
        r="9"
      />
      <path d="M12 11v6M12 7v.5" />
    </>
  ),
  logout: <path d="M9 4H4v16h5M10 12h11m-5-5 5 5-5 5" />,
  music: (
    <>
      <path d="M9 18V5l12-2v13M9 9l12-2" />
      <ellipse
        cx="6"
        cy="18"
        rx="3"
        ry="3"
      />
      <ellipse
        cx="18"
        cy="16"
        rx="3"
        ry="3"
      />
    </>
  ),
  pause: (
    <path
      d="M8 5v14M16 5v14"
      strokeWidth="4"
    />
  ),
  play: (
    <path
      d="m8 5 11 7-11 7Z"
      fill="currentColor"
      strokeLinejoin="round"
    />
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6" />
    </>
  ),
  search: (
    <>
      <circle
        cx="10.5"
        cy="10.5"
        r="6.5"
      />
      <path d="m16 16 5 5" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle
        cx="9"
        cy="7"
        r="3"
        fill="var(--surface)"
      />
      <circle
        cx="15"
        cy="17"
        r="3"
        fill="var(--surface)"
      />
    </>
  ),
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  shuffle: (
    <>
      <path d="M16 3h5v5" />
      <path d="M4 20 21 3" />
      <path d="M21 16v5h-5" />
      <path d="M15 15 21 21" />
      <path d="M4 4l5 5" />
    </>
  ),
  skip: (
    <>
      <path
        d="m5 5 10 7-10 7Z"
        fill="currentColor"
      />
      <path d="M19 5v14" />
    </>
  ),
  undo: (
    <path
      d="M3 9h11a7 7 0 0 1 0 14M3 9l5-5M3 9l5 5"
      transform="translate(0 -2)"
    />
  ),
}

export function Icon({
  name,
  className = '',
}: {
  readonly name: IconName
  readonly className?: string
}) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

export function SpotifyIcon() {
  return (
    <svg
      className="icon spotify-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="11"
        fill="currentColor"
      />
      <path
        d="M7 9.6c3.4-1 7.6-.8 10.6.9M7.7 13c2.8-.8 6.1-.6 8.5.7M8.4 16.1c2.1-.6 4.7-.4 6.5.6"
        fill="none"
        stroke="var(--spotify-lines, #171a15)"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function BrandLogo() {
  return (
    <span className="brand">
      <span className="brand-symbol">
        <i />
        <i />
        <i />
        <i />
      </span>
      curate
      <span className="brand-period">.</span>
    </span>
  )
}

export function SpotifyAttribution() {
  return (
    <a
      className="spotify-attribution"
      href="https://www.spotify.com/"
      target="_blank"
      rel="noopener noreferrer"
    >
      <SpotifyIcon /> Powered by Spotify
    </a>
  )
}
