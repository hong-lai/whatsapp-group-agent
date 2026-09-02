import { useEffect, useMemo, useState, type FormEvent } from 'react'

export const FILENAME_MEDIA_TYPES = [
    'images',
    'videos',
    'documents',
    'stickers',
    'audios',
] as const

export type FilenameMediaType = (typeof FILENAME_MEDIA_TYPES)[number]

export const FILENAME_TOKENS = [
    'datetime',
    'filename',
    'groupName',
    'messageId',
    'mediaIndex',
    'senderName',
] as const

export type FilenameToken = (typeof FILENAME_TOKENS)[number]

type FilenameTypePattern = {
    tokens: FilenameToken[]
    groupNameRegex: string
}

export type FilenameFormatSettings = Record<FilenameMediaType, FilenameTypePattern>

const TYPE_LABELS: Record<FilenameMediaType, string> = {
    images: 'Images',
    videos: 'Videos',
    documents: 'PDFs / docs',
    stickers: 'Stickers',
    audios: 'Audios',
}

const TOKEN_LABELS: Record<FilenameToken, string> = {
    datetime: 'Datetime',
    messageId: 'Message ID',
    filename: 'Filename',
    groupName: 'Group name',
    mediaIndex: 'Media index',
    senderName: 'Sender name',
}

const SAMPLE = {
    datetime: '2026-08-25_15-19-52',
    messageId: '3A734EE1B9B3EDCE4FC4',
    groupName: 'Happy Family Chat',
    senderName: 'Hong Lai',
    mediaIndex: null as number | null,
}

const SAMPLE_FILENAME: Record<FilenameMediaType, string> = {
    images: '',
    videos: '',
    documents: 'cat_food_report.pdf',
    stickers: '',
    audios: '',
}

const SAMPLE_EXT: Record<FilenameMediaType, string> = {
    images: '.jpeg',
    videos: '.mp4',
    documents: '.pdf',
    stickers: '.webp',
    audios: '.ogg',
}

function sanitize(value: string): string {
    const sanitized = value
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\.+$/g, '')
        .trim()
        .slice(0, 100)
    return sanitized
}

function fileStem(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return ''
    const base = trimmed.replace(/^.*[/\\]/, '')
    const dot = base.lastIndexOf('.')
    return sanitize(dot > 0 ? base.slice(0, dot) : base)
}

function extractGroupNameToken(groupName: string, regexSource: string): string | null {
    const trimmed = regexSource.trim()
    if (!trimmed) {
        const sanitized = sanitize(groupName)
        return sanitized || null
    }
    try {
        const regex = new RegExp(trimmed, 'g')
        const captures: string[] = []
        for (const match of groupName.matchAll(regex)) {
            if (match.length > 1) {
                for (let i = 1; i < match.length; i++) {
                    const group = match[i]
                    if (group) captures.push(group)
                }
            } else if (match[0]) {
                captures.push(match[0])
            }
        }
        if (captures.length === 0) return null
        const sanitized = sanitize(captures.join('_'))
        return sanitized || null
    } catch {
        return null
    }
}

function regexWarning(source: string): string | null {
    const trimmed = source.trim()
    if (!trimmed) return null
    try {
        void new RegExp(trimmed, 'g')
        return null
    } catch (error) {
        return error instanceof Error ? error.message : 'Invalid regular expression'
    }
}

function previewFilename(type: FilenameMediaType, pattern: FilenameTypePattern): string {
    const selected = new Set(pattern.tokens)
    const parts: string[] = []
    for (const token of FILENAME_TOKENS) {
        if (!selected.has(token)) continue
        let value: string | null = null
        if (token === 'datetime') value = SAMPLE.datetime
        else if (token === 'filename') value = fileStem(SAMPLE_FILENAME[type]) || null
        else if (token === 'groupName') value = extractGroupNameToken(SAMPLE.groupName, pattern.groupNameRegex)
        else if (token === 'messageId') value = SAMPLE.messageId
        else if (token === 'mediaIndex')
            value = SAMPLE.mediaIndex == null ? null : String(SAMPLE.mediaIndex + 1)
        else if (token === 'senderName') value = sanitize(SAMPLE.senderName) || null
        if (value) parts.push(value)
    }
    if (parts.length === 0) parts.push(SAMPLE.messageId)
    return `${parts.join('_')}${SAMPLE_EXT[type]}`
}

async function readJson<T>(response: Response): Promise<T> {
    const body = (await response.json()) as T & { error?: string }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
    return body
}

function adminHeaders(password: string, json = false): HeadersInit {
    return {
        'X-Admin-Password': password,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
}

export default function FilenameSettings({
    open,
    onClose,
}: {
    open: boolean
    onClose: () => void
}) {
    const [settings, setSettings] = useState<FilenameFormatSettings | null>(null)
    const [selectedType, setSelectedType] = useState<FilenameMediaType>('images')
    const [typedPassword, setTypedPassword] = useState('')
    const [adminPassword, setAdminPassword] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)
    const unlocked = Boolean(adminPassword)

    useEffect(() => {
        if (!open || !adminPassword) return
        let cancelled = false
        setLoading(true)
        setError(null)
        setSaved(false)
        void fetch('/api/settings/filename-format', { headers: adminHeaders(adminPassword) })
            .then((response) => readJson<FilenameFormatSettings>(response))
            .then((data) => {
                if (cancelled) return
                setSettings(data)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setAdminPassword(null)
                setError(err instanceof Error ? err.message : 'Failed to load settings')
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [open, adminPassword])

    useEffect(() => {
        if (!open) return
        function onKey(event: KeyboardEvent) {
            if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, onClose])

    const pattern = settings?.[selectedType]
    const preview = useMemo(
        () => (pattern ? previewFilename(selectedType, pattern) : ''),
        [pattern, selectedType]
    )
    const groupRegexWarning =
        pattern?.tokens.includes('groupName') && pattern.groupNameRegex
            ? regexWarning(pattern.groupNameRegex)
            : null

    function toggleToken(token: FilenameToken) {
        setSettings((current) => {
            if (!current) return current
            const selected = new Set(current[selectedType].tokens)
            if (selected.has(token)) selected.delete(token)
            else selected.add(token)
            return {
                ...current,
                [selectedType]: {
                    ...current[selectedType],
                    tokens: FILENAME_TOKENS.filter((item) => selected.has(item)),
                },
            }
        })
        setSaved(false)
    }

    function setGroupNameRegex(groupNameRegex: string) {
        setSettings((current) => {
            if (!current) return current
            return {
                ...current,
                [selectedType]: { ...current[selectedType], groupNameRegex },
            }
        })
        setSaved(false)
    }

    function unlock(event: FormEvent) {
        event.preventDefault()
        const password = typedPassword.trim()
        if (!password) {
            setError('Enter the admin password')
            return
        }
        setError(null)
        setAdminPassword(password)
    }

    async function save() {
        if (!settings || !adminPassword) return
        setSaving(true)
        setError(null)
        try {
            const savedSettings = await readJson<FilenameFormatSettings>(
                await fetch('/api/settings/filename-format', {
                    method: 'PUT',
                    headers: adminHeaders(adminPassword, true),
                    body: JSON.stringify(settings),
                })
            )
            setSettings(savedSettings)
            setSaved(true)
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : 'Failed to save settings'
            if (message === 'Invalid password') {
                setAdminPassword(null)
                setSettings(null)
            }
            setError(message)
        } finally {
            setSaving(false)
        }
    }

    if (!open) return null

    return (
        <div className="settings-overlay" role="presentation" onClick={onClose}>
            <div
                className="settings-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="filename-settings-title"
                onClick={(event) => event.stopPropagation()}
            >
                <header className="settings-header">
                    <div>
                        <h2 id="filename-settings-title">Filename format</h2>
                        <p>
                            {unlocked
                                ? 'Applies only to incoming media. Existing files keep their current names.'
                                : 'Enter the admin password to change how incoming files are named.'}
                        </p>
                    </div>
                    <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
                        ×
                    </button>
                </header>

                {error && <p className="settings-error">{error}</p>}

                {!unlocked && (
                    <form className="settings-unlock" onSubmit={unlock}>
                        <label className="settings-regex">
                            <span>Password</span>
                            <input
                                type="password"
                                name="admin-password"
                                autoComplete="current-password"
                                autoFocus
                                value={typedPassword}
                                onChange={(event) => setTypedPassword(event.target.value)}
                            />
                        </label>
                        <footer className="settings-actions">
                            <button type="submit" className="settings-save" disabled={loading}>
                                {loading ? 'Checking…' : 'Continue'}
                            </button>
                        </footer>
                    </form>
                )}

                {unlocked && !settings && <p className="settings-status">Loading…</p>}

                {unlocked && settings && pattern && (
                    <>
                        <div className="settings-types" role="tablist" aria-label="File type">
                            {FILENAME_MEDIA_TYPES.map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    role="tab"
                                    aria-selected={selectedType === type}
                                    className={selectedType === type ? 'active' : ''}
                                    onClick={() => setSelectedType(type)}
                                >
                                    {TYPE_LABELS[type]}
                                </button>
                            ))}
                        </div>

                        <fieldset className="settings-tokens">
                            <legend>Include in filename</legend>
                            <div className="settings-token-list">
                                {FILENAME_TOKENS.map((token) => {
                                    const checked = pattern.tokens.includes(token)
                                    return (
                                        <label key={token} className={checked ? 'is-checked' : ''}>
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggleToken(token)}
                                            />
                                            {TOKEN_LABELS[token]}
                                        </label>
                                    )
                                })}
                            </div>
                        </fieldset>

                        {pattern.tokens.includes('groupName') && (
                            <label className="settings-regex">
                                <span>Group name regex</span>
                                <input
                                    type="text"
                                    value={pattern.groupNameRegex}
                                    maxLength={200}
                                    placeholder="_(\\w+)_"
                                    spellCheck={false}
                                    onChange={(event) => setGroupNameRegex(event.target.value)}
                                />
                                <small>
                                    Capture groups are extracted and joined with underscores. No match omits
                                    the group name. Leave empty to use the full group name.
                                </small>
                                {groupRegexWarning && (
                                    <small className="settings-regex-error">{groupRegexWarning}</small>
                                )}
                            </label>
                        )}

                        <div className="settings-preview">
                            <span>Preview</span>
                            <code>{preview}</code>
                            <small>
                                Sample group {SAMPLE.groupName}
                                {SAMPLE_FILENAME[selectedType]
                                    ? ` · filename ${SAMPLE_FILENAME[selectedType]}`
                                    : ' · no original filename'}{' '}
                                · no album index
                            </small>
                        </div>

                        <footer className="settings-actions">
                            <button type="button" className="settings-save" onClick={() => void save()} disabled={saving}>
                                {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
                            </button>
                        </footer>
                    </>
                )}
            </div>
        </div>
    )
}
