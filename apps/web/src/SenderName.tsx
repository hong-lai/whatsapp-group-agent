import { useEffect, useState } from 'react'
import { adminHeaders, useAdminAuth } from './adminAuth'

const phoneCache = new Map<string, string | null>()

type Status = 'idle' | 'loading' | 'ready' | 'error'

export function SenderName({
    name,
    jid,
    fallback = 'Unknown sender',
    as = 'strong',
    className,
}: {
    name: string | null
    jid: string | null
    fallback?: string
    as?: 'strong' | 'span'
    className?: string
}) {
    const { role, adminPassword } = useAdminAuth()
    const label = name?.trim() || fallback
    const [open, setOpen] = useState(false)
    const [status, setStatus] = useState<Status>('idle')
    const [phone, setPhone] = useState<string | null>(null)
    const [trackedJid, setTrackedJid] = useState(jid)
    const canReveal = role === 'admin' && Boolean(jid) && Boolean(adminPassword)

    if (jid !== trackedJid) {
        setTrackedJid(jid)
        setOpen(false)
        setStatus('idle')
        setPhone(null)
    }

    useEffect(() => {
        if (!open || !jid || !adminPassword) return
        const cached = phoneCache.get(jid)
        if (cached !== undefined) {
            setPhone(cached)
            setStatus('ready')
            return
        }
        const controller = new AbortController()
        setStatus('loading')
        void (async () => {
            try {
                const response = await fetch(
                    `/api/admin/sender-phone?jid=${encodeURIComponent(jid)}`,
                    { headers: adminHeaders(adminPassword), signal: controller.signal }
                )
                const body = (await response.json()) as { phone?: string | null; error?: string }
                if (!response.ok) throw new Error(body.error || 'Could not load phone number')
                const next = typeof body.phone === 'string' && body.phone ? body.phone : null
                phoneCache.set(jid, next)
                if (controller.signal.aborted) return
                setPhone(next)
                setStatus('ready')
            } catch (error) {
                if (controller.signal.aborted) return
                if (error instanceof DOMException && error.name === 'AbortError') return
                setStatus('error')
            }
        })()
        return () => controller.abort()
    }, [open, jid, adminPassword])

    const Tag = as
    if (!canReveal) {
        return <Tag className={className}>{label}</Tag>
    }

    const phoneText =
        status === 'loading'
            ? 'Looking up…'
            : status === 'error'
              ? "Couldn't load"
              : phone || 'No phone number'

    return (
        <Tag className={['sender-name', className].filter(Boolean).join(' ')}>
            <button
                type="button"
                className="sender-name-btn"
                aria-expanded={open}
                aria-label={open ? `Hide phone number for ${label}` : `Show phone number for ${label}`}
                onClick={(event) => {
                    event.stopPropagation()
                    setOpen((current) => !current)
                }}
            >
                {label}
            </button>
            {open && (
                <span className="sender-phone" role="status">
                    {phoneText}
                </span>
            )}
        </Tag>
    )
}
