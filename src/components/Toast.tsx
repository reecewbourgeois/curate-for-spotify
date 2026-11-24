import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Icon } from './Icons'
import type { ReactNode } from 'react'

interface ToastState {
  readonly id: number
  readonly message: string
  readonly error: boolean
}

interface ToastContextValue {
  readonly showToast: (message: string, error?: boolean) => void
}

const ToastContext = createContext<ToastContextValue>({
  showToast: () => {},
})

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idRef = useRef(0)

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setToast(null)
  }, [])

  const showToast = useCallback((message: string, error = false) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
    }
    idRef.current++
    setToast({ id: idRef.current, message, error })
    timerRef.current = setTimeout(
      () => {
        setToast(null)
        timerRef.current = null
      },
      error ? 12_000 : 5_000,
    )
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        className={`toast ${toast ? 'show' : ''} ${toast?.error ? 'error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {toast ? (
          <>
            <Icon name={toast.error ? 'info' : 'check'} />
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss notification"
            >
              <Icon name="close" />
            </button>
          </>
        ) : null}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
