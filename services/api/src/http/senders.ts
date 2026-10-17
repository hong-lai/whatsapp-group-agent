import type { Express } from 'express'
import { isLookupJid, resolveSenderPhone } from '../senderPhone.js'
import { requireAdmin } from './helpers.js'

export function registerSenderRoutes(app: Express): void {
    app.get('/api/admin/sender-phone', requireAdmin, async (request, response) => {
        const jid = request.query.jid
        if (typeof jid !== 'string' || !isLookupJid(jid)) {
            response.status(400).json({ error: 'Invalid sender' })
            return
        }
        const phone = await resolveSenderPhone(jid)
        response.json({ phone })
    })
}
