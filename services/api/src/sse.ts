import type { Request, Response } from 'express'
import { subscribeReportProcessed, subscribeWorkflowStatus } from '../../../packages/shared/src/events/index.js'

function writeSseHeaders(response: Response): void {
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()
    response.write(': connected\n\n')
}

function attachSseClient(request: Request, response: Response, clients: Set<Response>): void {
    writeSseHeaders(response)
    clients.add(response)
    const heartbeat = setInterval(() => {
        response.write(': heartbeat\n\n')
    }, 15_000)
    const cleanup = () => {
        clearInterval(heartbeat)
        clients.delete(response)
    }
    request.on('close', cleanup)
    request.on('aborted', cleanup)
}

const reportClients = new Set<Response>()
let reportSubscribed = false

export function handleReportProcessedSse(request: Request, response: Response): void {
    if (!reportSubscribed) {
        reportSubscribed = true
        subscribeReportProcessed((message) => {
            const frame = `data: ${message}\n\n`
            for (const client of reportClients) client.write(frame)
        })
    }
    attachSseClient(request, response, reportClients)
}

const workflowClients = new Set<Response>()
let workflowSubscribed = false

export function handleWorkflowStatusSse(request: Request, response: Response): void {
    if (!workflowSubscribed) {
        workflowSubscribed = true
        subscribeWorkflowStatus((message) => {
            const frame = `data: ${message}\n\n`
            for (const client of workflowClients) client.write(frame)
        })
    }
    attachSseClient(request, response, workflowClients)
}
