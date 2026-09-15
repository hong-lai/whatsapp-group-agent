import express, { type Express } from 'express'
import { config, WORKFLOW_LABELS } from '../config.js'
import { log } from '../../../../packages/shared/src/log.js'
import { enqueueMessageEvent } from '../../../../packages/shared/src/queue/index.js'
import type { MessageEventType } from '../../../../packages/shared/src/queue/types.js'
import {
    findInProgressWorkflows,
    getMessageForWorkflowEnqueue,
    getMessagesForWorkflowEnqueue,
    getWorkflowDebugSnapshot,
    listDailySiteReportMessageIds,
} from '../../../../packages/shared/src/db/index.js'
import {
    listLlmModels,
    markWorkflowsQueued,
    optionalPromptOverride,
    parseDateRangeValues,
    parseFileNameQuery,
    parseReportDateField,
    parseWorkflowNames,
    readWorkflowPrompts,
    rejectIfWorkflowsInProgress,
    requireAdmin,
    resolveTargetWorkflowNames,
} from './helpers.js'


export function registerWorkflowRoutes(app: Express): void {
    app.get(
        '/api/workflows',
        requireAdmin,
        async (_request, response) => {
            const enabled = new Set(config.enabledWorkflows)
            response.json({
                workflowsEnabled: config.workflowsEnabled,
                workflowsProcessHistory: config.workflowsProcessHistory,
                available: config.availableWorkflows,
                enabled: config.enabledWorkflows,
                workflows: config.availableWorkflows.map((name) => ({
                    name,
                    label: WORKFLOW_LABELS[name] ?? name,
                    enabled: enabled.has(name),
                })),
            })
        }
    )

    app.get(
        '/api/debug/workflows',
        requireAdmin,
        async (request, response) => {
            const messageId =
                typeof request.query.messageId === 'string' ? request.query.messageId.trim() : ''
            if (!messageId) throw new Error('messageId is required')
            const limitRaw =
                typeof request.query.limit === 'string'
                    ? Number.parseInt(request.query.limit, 10)
                    : 20
            const limit = Number.isFinite(limitRaw) ? limitRaw : 20
            const snapshot = await getWorkflowDebugSnapshot(messageId, limit)
            if (!snapshot) {
                response.status(404).json({ error: 'Message not found' })
                return
            }
            const models = await listLlmModels()
            const defaultModel = config.llmModel
            const modelOptions = models.includes(defaultModel)
                ? models
                : [defaultModel, ...models]
            const prompts = readWorkflowPrompts()
            response.json({
                workflowsEnabled: config.workflowsEnabled,
                workflowsProcessHistory: config.workflowsProcessHistory,
                defaultModel,
                models: modelOptions,
                prompts,
                snapshot,
            })
        }
    )

    app.post(
        '/api/debug/workflows/reenqueue',
        requireAdmin,
        express.json({ limit: '256kb' }),
        async (request, response) => {
            if (!config.workflowsEnabled) {
                response.status(503).json({ error: 'Workflows are disabled (WORKFLOWS_ENABLED=false)' })
                return
            }
            const body = (request.body ?? {}) as {
                messageId?: unknown
                llmModel?: unknown
                classifierPrompt?: unknown
                extractorPrompt?: unknown
                workflowNames?: unknown
            }
            const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : ''
            if (!messageId) throw new Error('messageId is required')

            const llmModel =
                typeof body.llmModel === 'string' && body.llmModel.trim()
                    ? body.llmModel.trim()
                    : config.llmModel
            const classifierPrompt = optionalPromptOverride(body.classifierPrompt)
            const extractorPrompt = optionalPromptOverride(body.extractorPrompt)
            const workflowNames = parseWorkflowNames(body.workflowNames)
            const targetWorkflows = resolveTargetWorkflowNames(workflowNames)
            if (targetWorkflows.length === 0) {
                response.status(503).json({ error: 'No workflows enabled' })
                return
            }

            const message = await getMessageForWorkflowEnqueue(messageId)
            if (!message) {
                response.status(404).json({ error: 'Message not found' })
                return
            }

            if (await rejectIfWorkflowsInProgress(response, message.messageId, targetWorkflows)) {
                return
            }

            const event: MessageEventType = message.isEdited
                ? 'message.edited'
                : 'message.created'

            const enqueued = await enqueueMessageEvent({
                event,
                messageId: message.messageId,
                groupJid: message.groupJid,
                messageType: message.messageType,
                mediaPath: message.mediaPath,
                isHistory: false,
                llmModel,
                classifierPrompt,
                extractorPrompt,
                workflowNames: targetWorkflows,
            })
            if (!enqueued) {
                response.status(503).json({ error: 'Failed to enqueue workflow job' })
                return
            }

            await markWorkflowsQueued({
                messageId: message.messageId,
                event,
                workflowNames: targetWorkflows,
            })

            log.info(
                {
                    messageId: message.messageId,
                    event,
                    llmModel,
                    groupJid: message.groupJid,
                    workflowNames: targetWorkflows,
                    classifierPromptOverride: Boolean(classifierPrompt),
                    extractorPromptOverride: Boolean(extractorPrompt),
                },
                'workflow.debug_reenqueued'
            )
            response.json({
                ok: true,
                event,
                llmModel,
                messageId: message.messageId,
                groupJid: message.groupJid,
                messageType: message.messageType,
                workflowNames: targetWorkflows,
                classifierPromptOverride: Boolean(classifierPrompt),
                extractorPromptOverride: Boolean(extractorPrompt),
            })
        }
    )

    app.post(
        '/api/debug/workflows/reenqueue-filtered',
        requireAdmin,
        express.json({ limit: '256kb' }),
        async (request, response) => {
            if (!config.workflowsEnabled) {
                response.status(503).json({ error: 'Workflows are disabled (WORKFLOWS_ENABLED=false)' })
                return
            }

            const body = (request.body ?? {}) as {
                from?: unknown
                to?: unknown
                group?: unknown
                q?: unknown
                dateField?: unknown
                llmModel?: unknown
                classifierPrompt?: unknown
                extractorPrompt?: unknown
                workflowNames?: unknown
                maxRows?: unknown
            }

            const range = parseDateRangeValues(body.from, body.to)
            const groupJid =
                typeof body.group === 'string' && body.group.trim() ? body.group.trim() : undefined
            if (groupJid && !groupJid.endsWith('@g.us')) {
                throw new Error('Invalid group')
            }
            const query = parseFileNameQuery(body.q)
            const dateField = parseReportDateField(body.dateField)
            const maxRowsRaw =
                typeof body.maxRows === 'number'
                    ? body.maxRows
                    : typeof body.maxRows === 'string'
                      ? Number.parseInt(body.maxRows, 10)
                      : 500
            const maxRows = Number.isFinite(maxRowsRaw)
                ? Math.min(Math.max(1, Math.floor(maxRowsRaw)), 500)
                : 500

            const llmModel =
                typeof body.llmModel === 'string' && body.llmModel.trim()
                    ? body.llmModel.trim()
                    : config.llmModel
            const classifierPrompt = optionalPromptOverride(body.classifierPrompt)
            const extractorPrompt = optionalPromptOverride(body.extractorPrompt)
            const workflowNames = parseWorkflowNames(body.workflowNames)
            const targetWorkflows = resolveTargetWorkflowNames(workflowNames)
            if (targetWorkflows.length === 0) {
                response.status(503).json({ error: 'No workflows enabled' })
                return
            }

            const { messageIds, total } = await listDailySiteReportMessageIds({
                fromDate: range.from,
                toDate: range.to,
                dateField,
                maxRows,
                ...(groupJid ? { groupJid } : {}),
                ...(query ? { query } : {}),
            })

            if (total === 0) {
                response.status(404).json({ error: 'No reports match the selected filters' })
                return
            }
            if (total > maxRows) {
                response.status(400).json({
                    error: `Too many reports (${total}). Narrow filters to at most ${maxRows}.`,
                    total,
                    maxRows,
                })
                return
            }

            const messages = await getMessagesForWorkflowEnqueue(messageIds)
            const foundIds = new Set(messages.map((item) => item.messageId))
            const missing = messageIds.filter((id) => !foundIds.has(id))

            let enqueued = 0
            const failed: string[] = []
            const skippedInProgress: string[] = []
            for (const message of messages) {
                const busy = await findInProgressWorkflows(message.messageId, targetWorkflows)
                if (busy.length > 0) {
                    skippedInProgress.push(message.messageId)
                    continue
                }
                const event: MessageEventType = message.isEdited
                    ? 'message.edited'
                    : 'message.created'
                const ok = await enqueueMessageEvent({
                    event,
                    messageId: message.messageId,
                    groupJid: message.groupJid,
                    messageType: message.messageType,
                    mediaPath: message.mediaPath,
                    isHistory: false,
                    llmModel,
                    classifierPrompt,
                    extractorPrompt,
                    workflowNames: targetWorkflows,
                })
                if (ok) {
                    await markWorkflowsQueued({
                        messageId: message.messageId,
                        event,
                        workflowNames: targetWorkflows,
                    })
                    enqueued += 1
                } else {
                    failed.push(message.messageId)
                }
            }

            log.info(
                {
                    from: range.from,
                    to: range.to,
                    dateField,
                    groupJid: groupJid ?? null,
                    query: query ?? null,
                    total,
                    enqueued,
                    failed: failed.length,
                    missing: missing.length,
                    skippedInProgress: skippedInProgress.length,
                    llmModel,
                    workflowNames: targetWorkflows,
                },
                'workflow.debug_reenqueued_filtered'
            )

            response.json({
                ok: true,
                total,
                enqueued,
                failed,
                missing,
                skippedInProgress,
                llmModel,
                workflowNames: targetWorkflows,
                range: { from: range.from, to: range.to },
                dateField,
                groupJid: groupJid ?? null,
                query: query ?? null,
            })
        }
    )
}
