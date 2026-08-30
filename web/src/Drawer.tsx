import { useEffect, useRef, type ReactNode, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'

type Props = {
    open: boolean
    onClose: () => void
    title: string
    children: ReactNode
}

export default function Drawer({ open, onClose, title, children }: Props) {
    const panelRef = useRef<HTMLElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const start = useRef<{ x: number; y: number; axis: 'x' | 'y' | null } | null>(null)

    useEffect(() => {
        if (!open) return undefined
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        closeRef.current?.focus()

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
        }
    }, [open, onClose])

    function onTouchStart(event: TouchEvent) {
        const touch = event.touches[0]
        start.current = { x: touch.clientX, y: touch.clientY, axis: null }
    }

    function onTouchMove(event: TouchEvent) {
        if (!start.current || !panelRef.current) return
        const touch = event.touches[0]
        const dx = touch.clientX - start.current.x
        const dy = touch.clientY - start.current.y
        if (start.current.axis == null) {
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
            start.current.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'
        }
        if (start.current.axis !== 'x') return
        panelRef.current.style.transform = `translateX(${Math.min(0, dx)}px)`
    }

    function onTouchEnd(event: TouchEvent) {
        if (!start.current || !panelRef.current) return
        const dx = event.changedTouches[0].clientX - start.current.x
        const close = start.current.axis === 'x' && dx < -64
        panelRef.current.style.transform = ''
        start.current = null
        if (close) onClose()
    }

    if (!open) return null

    return createPortal(
        <div className="drawer-overlay" role="presentation" onClick={onClose}>
            <aside
                ref={panelRef}
                className="drawer-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="drawer-title"
                onClick={(event) => event.stopPropagation()}
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
            >
                <header className="drawer-header">
                    <h2 id="drawer-title">{title}</h2>
                    <button
                        ref={closeRef}
                        type="button"
                        className="sheet-close"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        ×
                    </button>
                </header>
                <div className="drawer-body">{children}</div>
            </aside>
        </div>,
        document.body
    )
}
