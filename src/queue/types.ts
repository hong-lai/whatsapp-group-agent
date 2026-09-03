export type MessageEventType =
    | 'message.created'
    | 'message.edited'
    | 'message.deleted'
    | 'message.media_ready'

export type MessageEventJob = {
    event: MessageEventType
    messageId: string
    groupJid: string | null
    messageType: string | null
    mediaPath: string | null
    isHistory: boolean
    enqueuedAt: string
}

export const MESSAGE_EVENTS_QUEUE = 'message-events'
