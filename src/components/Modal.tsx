import { useEffect, useRef } from 'react'
import { Icon } from './Icons'
import type { MouseEvent, ReactNode } from 'react'

export function Modal({
  open,
  onClose,
  children,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    if (outside) {
      onClose()
    }
  }

  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={handleBackdropClick}
    >
      <button
        type="button"
        className="modal-close icon-button"
        aria-label="Close dialog"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      {open ? children : null}
    </dialog>
  )
}
