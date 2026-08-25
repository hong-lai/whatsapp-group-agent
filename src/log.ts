import pino from 'pino'
import { config } from './config.js'

export const log = pino({
    name: 'whatsapp-agent',
    level: config.logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'event',
    formatters: {
        level(label) {
            return { level: label }
        },
    },
})
