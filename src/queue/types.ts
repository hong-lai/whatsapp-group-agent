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
    /** Optional override for the workflows worker LLM model id. */
    llmModel?: string | null
    /** Optional one-off prompt overrides (debug re-run only). */
    classifierPrompt?: string | null
    extractorPrompt?: string | null
    enqueuedAt: string
}

export const MESSAGE_EVENTS_QUEUE = 'message-events'
