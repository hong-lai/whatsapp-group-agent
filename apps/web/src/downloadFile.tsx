import { useState, type MouseEvent, type ReactNode } from 'react'

export function saveBlob(blob: Blob, fileName: string) {
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
}

export async function downloadFile(url: string, fileName?: string | null) {
    const response = await fetch(url)
    if (!response.ok) throw new Error('Could not download file')
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1]
    const quoted = /filename="([^"]+)"/i.exec(disposition)?.[1]
    const name =
        fileName?.trim() ||
        (encoded ? decodeURIComponent(encoded) : null) ||
        quoted ||
        'download'
    saveBlob(blob, name)
}

function DownloadIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4v12" />
            <path d="m7 11 5 5 5-5" />
            <path d="M5 20h14" />
        </svg>
    )
}

export function DownloadButton({
    url,
    fileName,
    className = 'download-button',
    children,
}: {
    url: string
    fileName?: string | null
    className?: string
    children?: ReactNode
}) {
    const [busy, setBusy] = useState(false)

    async function onClick(event: MouseEvent<HTMLButtonElement>) {
        event.preventDefault()
        event.stopPropagation()
        if (busy) return
        setBusy(true)
        try {
            await downloadFile(url, fileName)
        } catch {
            // Stay in-app even if the save fails; avoid navigating away.
        } finally {
            setBusy(false)
        }
    }

    return (
        <button type="button" className={className} disabled={busy} onClick={onClick}>
            {children ?? (
                <>
                    <DownloadIcon />
                    {busy ? 'Saving…' : 'Download'}
                </>
            )}
        </button>
    )
}

export { DownloadIcon }
