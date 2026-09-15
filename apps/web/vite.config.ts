import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        headers: {
            'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
            'Referrer-Policy': 'no-referrer',
        },
        proxy: {
            '/api': 'http://localhost:3000',
        },
    },
    preview: {
        headers: {
            'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
            'Referrer-Policy': 'no-referrer',
        },
    },
})
