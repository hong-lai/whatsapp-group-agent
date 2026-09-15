import { useEffect, useState } from 'react'

type BeforeInstallPromptEvent = Event & {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone(): boolean {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        ('standalone' in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
    )
}

function isIos(): boolean {
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
}

export default function InstallApp({ variant = 'icon' }: { variant?: 'icon' | 'item' }) {
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
    const [installed, setInstalled] = useState(isStandalone)
    const [helpOpen, setHelpOpen] = useState(false)

    useEffect(() => {
        const onPrompt = (event: Event) => {
            event.preventDefault()
            setDeferred(event as BeforeInstallPromptEvent)
        }
        const onInstalled = () => {
            setInstalled(true)
            setDeferred(null)
            setHelpOpen(false)
        }
        window.addEventListener('beforeinstallprompt', onPrompt)
        window.addEventListener('appinstalled', onInstalled)
        return () => {
            window.removeEventListener('beforeinstallprompt', onPrompt)
            window.removeEventListener('appinstalled', onInstalled)
        }
    }, [])

    if (installed || (!deferred && !isIos())) return null

    async function install() {
        if (deferred) {
            await deferred.prompt()
            const choice = await deferred.userChoice
            if (choice.outcome === 'accepted') setInstalled(true)
            setDeferred(null)
            return
        }
        setHelpOpen(true)
    }

    return (
        <>
            <button
                type="button"
                className={variant === 'item' ? 'overflow-item' : 'settings-toggle'}
                aria-label="Install app"
                title="Install app"
                onClick={() => void install()}
            >
                {variant === 'item' ? (
                    'Install app'
                ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3v12" />
                        <path d="m8 11 4 4 4-4" />
                        <path d="M5 21h14" />
                    </svg>
                )}
            </button>
            {helpOpen && (
                <div className="settings-overlay" role="presentation" onClick={() => setHelpOpen(false)}>
                    <div
                        className="settings-panel install-sheet"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="install-title"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <header className="settings-header">
                            <div>
                                <h2 id="install-title">Add to Home Screen</h2>
                                <p>Install Group Archive so it opens like an app.</p>
                            </div>
                            <button
                                type="button"
                                className="settings-close"
                                onClick={() => setHelpOpen(false)}
                                aria-label="Close"
                            >
                                ×
                            </button>
                        </header>
                        <ol className="install-steps">
                            <li>
                                Tap{' '}
                                <span className="install-share" aria-label="Share">
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                        <path d="M12 14V4" />
                                        <path d="m8 8 4-4 4 4" />
                                        <path d="M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" />
                                    </svg>
                                </span>{' '}
                                in Safari.
                            </li>
                            <li>
                                Scroll down and tap <strong>Add to Home Screen</strong>.
                            </li>
                            <li>
                                Tap <strong>Add</strong>.
                            </li>
                        </ol>
                    </div>
                </div>
            )}
        </>
    )
}
