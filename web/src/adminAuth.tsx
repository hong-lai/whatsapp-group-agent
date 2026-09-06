import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from 'react'

export type AdminRole = 'guest' | 'admin'

const STORAGE_KEY = 'adminPassword'

type AdminAuthContextValue = {
    role: AdminRole
    adminPassword: string | null
    login: (password: string) => Promise<void>
    logout: () => void
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null)

function readStoredPassword(): string | null {
    try {
        const value = sessionStorage.getItem(STORAGE_KEY)
        return value?.trim() ? value : null
    } catch {
        return null
    }
}

function writeStoredPassword(password: string | null): void {
    try {
        if (password) sessionStorage.setItem(STORAGE_KEY, password)
        else sessionStorage.removeItem(STORAGE_KEY)
    } catch {
        // Ignore quota / private-mode failures
    }
}

export function AdminAuthProvider({ children }: { children: ReactNode }) {
    const [adminPassword, setAdminPassword] = useState<string | null>(() => readStoredPassword())

    const logout = useCallback(() => {
        setAdminPassword(null)
        writeStoredPassword(null)
    }, [])

    const login = useCallback(async (password: string) => {
        const trimmed = password.trim()
        if (!trimmed) throw new Error('Enter the admin password')

        const response = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'x-admin-password': trimmed },
        })
        const body = (await response.json()) as { error?: string; ok?: boolean }
        if (!response.ok) {
            throw new Error(body.error || `Login failed (${response.status})`)
        }
        setAdminPassword(trimmed)
        writeStoredPassword(trimmed)
    }, [])

    const value = useMemo<AdminAuthContextValue>(
        () => ({
            role: adminPassword ? 'admin' : 'guest',
            adminPassword,
            login,
            logout,
        }),
        [adminPassword, login, logout]
    )

    return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>
}

export function useAdminAuth(): AdminAuthContextValue {
    const context = useContext(AdminAuthContext)
    if (!context) {
        throw new Error('useAdminAuth must be used within AdminAuthProvider')
    }
    return context
}

export function adminHeaders(password: string, json = false): HeadersInit {
    return {
        'x-admin-password': password,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
}
