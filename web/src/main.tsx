import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AdminAuthProvider } from './adminAuth'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <AdminAuthProvider>
            <App />
        </AdminAuthProvider>
    </StrictMode>
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        void navigator.serviceWorker.register('/sw.js')
    })
}
