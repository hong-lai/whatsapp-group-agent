import { useEffect, useRef, type ReactNode, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'

type Props = {
    open: boolean
    onClose: () => void
    title: string
    subtitle?: string
    children: ReactNode
    panelClassName?: string
    bodyClassName?: string
}

export default function Drawer({
    open,
    onClose,
    title,
    subtitle,
    children,
    panelClassName,
    bodyClassName,
}: Props) {
    const panelRef = useRef<HTMLElement>(null)
    const closeRef = useRef<HTMLButtonElement>(null)
    const titleRef = useRef<HTMLHeadingElement>(null)
    const start = useRef<{ x: number; y: number; axis: 'x' | 'y' | null } | null>(null)
    const onCloseRef = useRef(onClose)
    onCloseRef.current = onClose

    useEffect(() => {
        if (!open) return undefined
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        closeRef.current?.focus()

        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') onCloseRef.current()
        }
        window.addEventListener('keydown', onKey)
        return () => {
            document.body.style.overflow = previous
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    function syncTitleTooltip() {
        const el = titleRef.current
        if (!el) return
        const truncated = el.scrollWidth > el.clientWidth + 1
        if (truncated) el.setAttribute('title', title)
        else el.removeAttribute('title')
    }

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
                className={`drawer-panel${panelClassName ? ` ${panelClassName}` : ''}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="drawer-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header
                    className="drawer-header"
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                >
                    <div className="drawer-heading">
                        <h2 id="drawer-title" ref={titleRef} onMouseEnter={syncTitleTooltip}>
                            {title}
                        </h2>
                        {subtitle && <p className="drawer-subtitle">{subtitle}</p>}
                    </div>
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
                <div className={`drawer-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
                    {children}
                </div>
            </aside>
        </div>,
        document.body
    )
}
