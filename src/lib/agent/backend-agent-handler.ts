import { appDataDir, join } from '@tauri-apps/api/path'
import useArticleStore from '@/stores/article'
import useChatStore from '@/stores/chat'
import { getWorkspacePath } from '@/lib/workspace'

type BackendAgentHandlerConfig = {
  onComplete: (finalText: string) => Promise<void> | void
  onError: (error: string) => Promise<void> | void
}

type EditorRunEvent =
  | { type: 'run_started'; run_id: string; runId?: string }
  | { type: 'plan'; run_id?: string; runId?: string; plan: any[] }
  | { type: 'progress'; run_id?: string; runId?: string; task_id: number; status: string; task?: string; output?: any; error?: string; attempt?: number }
  | { type: 'awaiting_confirmation'; run_id?: string; runId?: string; task_id: number; task: string; args: Record<string, any> }
  | { type: 'run_completed'; run_id?: string; runId?: string; result: any }
  | { type: string; [k: string]: any }

function getBackendBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8060'
  return (localStorage.getItem('agentBackendUrl') || 'http://127.0.0.1:8060').replace(/\/$/, '')
}

async function resolveWorkspaceRootAbsolute(): Promise<string> {
  const workspace = await getWorkspacePath()
  if (workspace.isCustom) return workspace.path
  return await join(await appDataDir(), 'article')
}

async function resolveActiveFileAbsolute(activeFilePath: string): Promise<string> {
  const workspace = await getWorkspacePath()
  if (workspace.isCustom) {
    const isAbsolute =
      /^[a-zA-Z]:[\\/]/.test(activeFilePath) ||
      activeFilePath.startsWith('\\\\') ||
      activeFilePath.startsWith('/')
    return isAbsolute ? activeFilePath : await join(workspace.path, activeFilePath)
  }
  return await join(await appDataDir(), 'article', activeFilePath)
}

function buildRunSummaryFromResult(result: any): string {
  const steps = Array.isArray(result?.steps) ? result.steps : []
  const lines: string[] = []
  lines.push('结论')
  const failed = steps.find((s: any) => s?.status === 'failed')
  if (failed) {
    lines.push(`任务失败：${failed?.error || 'unknown error'}`)
  } else {
    lines.push('任务完成。')
  }
  lines.push('')
  lines.push('执行概览')
  for (const s of steps) {
    const tool = String(s?.task || '')
    const status = String(s?.status || '')
    const out = s?.output?.data?.tool_result
    const filePath = out?.meta?.file_path || out?.meta?.filePath || s?.output?.asset_uri || ''
    lines.push(`- ${tool}: ${status}${filePath ? ` (${filePath})` : ''}`)
  }
  return lines.join('\n')
}

function buildRunSummaryFromResultZh(result: any): string {
  const steps = Array.isArray(result?.steps) ? result.steps : []
  const lines: string[] = []
  lines.push('结论')
  const failed = steps.find((s: any) => s?.status === 'failed')
  if (failed) {
    lines.push(`任务失败：${failed?.error || 'unknown error'}`)
  } else {
    lines.push('任务完成。')
  }
  lines.push('')
  lines.push('执行概览')
  for (const s of steps) {
    const tool = String(s?.task || '')
    const status = String(s?.status || '')
    const out = s?.output?.data?.tool_result
    const filePath = out?.meta?.file_path || out?.meta?.filePath || s?.output?.asset_uri || ''
    const fileName = typeof filePath === 'string' ? filePath.split(/[\\/]/).pop() : ''
    lines.push(`- ${tool}: ${status}${fileName ? ` (${fileName})` : ''}`)
  }
  return lines.join('\n')
}

async function parseSseStream(
  response: Response,
  onEvent: (event: EditorRunEvent) => void,
  abortSignal?: AbortSignal
) {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    if (abortSignal?.aborted) break
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const sepIndex = buffer.indexOf('\n\n')
      if (sepIndex < 0) break
      const chunk = buffer.slice(0, sepIndex)
      buffer = buffer.slice(sepIndex + 2)

      const lines = chunk.split('\n')
      const dataLines = lines.filter(l => l.startsWith('data: '))
      if (!dataLines.length) continue
      const dataStr = dataLines.map(l => l.slice(6)).join('\n')
      if (!dataStr.trim()) continue
      try {
        const parsed = JSON.parse(dataStr)
        onEvent(parsed)
      } catch {
        // ignore malformed chunks
      }
    }
  }
}

export class BackendAgentHandler {
  private config: BackendAgentHandlerConfig
  private abortController: AbortController | null = null

  constructor(config: BackendAgentHandlerConfig) {
    this.config = config
  }

  stop() {
    try {
      this.abortController?.abort()
    } catch {}
    this.abortController = null
    const store = useChatStore.getState()
    store.setAgentState({ phase: 'stopped', isRunning: false })
  }

  async execute(userInput: string) {
    const chatStore = useChatStore.getState()
    const articleStore = useArticleStore.getState()

    const baseUrl = getBackendBaseUrl()
    const sessionId = `editor-${Date.now()}`

    chatStore.resetAgentState()
    chatStore.setAgentState({
      isRunning: true,
      phase: 'planning',
      runId: sessionId,
      maxIterations: 0,
      currentIteration: 0,
      currentThought: '',
      thoughtHistory: [],
      currentAction: '',
      currentObservation: '',
      toolCalls: [],
      pendingConfirmation: undefined,
      lastError: undefined,
    })

    this.abortController = new AbortController()
    const signal = this.abortController.signal

    try {
      const workspaceRoot = await resolveWorkspaceRootAbsolute()
      const activeFilePath = articleStore.activeFilePath || null
      const activeAbsPath = activeFilePath ? await resolveActiveFileAbsolute(activeFilePath) : null
      const activeContent = articleStore.currentArticle || null
      let needsRefreshAfterWrite = false

      const norm = (p: unknown) => String(p || '').replace(/\\/g, '/').toLowerCase()
      const matchesActive = (p: unknown) => {
        const v = norm(p)
        if (!v) return false
        if (activeAbsPath && norm(activeAbsPath) === v) return true
        if (activeFilePath && v.endsWith('/' + norm(activeFilePath))) return true
        if (activeFilePath && norm(activeFilePath) === v) return true
        return false
      }

      const resp = await fetch(`${baseUrl}/api/editor/run_stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          message: userInput,
          workspace_root: workspaceRoot,
          active_file_path: activeAbsPath,
          active_content: activeContent,
        }),
        signal,
      })

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        throw new Error(`Backend error: HTTP ${resp.status} ${txt}`)
      }

      const planById = new Map<number, any>()
      let backendRunId: string | null = null
      let hasErrored = false

      await parseSseStream(resp, (ev) => {
        const type = String((ev as any)?.type || '')
        const errorMsg = typeof (ev as any)?.error === 'string' ? String((ev as any).error) : ''
        if (!hasErrored && (type === 'error' || errorMsg)) {
          hasErrored = true
          const message = errorMsg || 'Unknown backend error'
          chatStore.setAgentState({ phase: 'error', isRunning: false, lastError: message, pendingConfirmation: undefined })
          try {
            this.abortController?.abort()
          } catch {}
          void this.config.onError(message)
          return
        }
        if (type === 'run_started') {
          backendRunId = String((ev as any).run_id || (ev as any).runId || '')
          return
        }
        if (type === 'plan') {
          const plan = (ev as any).plan
          if (Array.isArray(plan)) {
            for (const step of plan) {
              if (typeof step?.id === 'number') planById.set(step.id, step)
            }
            chatStore.setAgentState({
              phase: 'executing',
              plan: plan.map((s: any) => {
                const task = String(s?.task || '')
                const file = s?.args?.file_path ? String(s.args.file_path).split(/[\\/]/).pop() : ''
                return file ? `${task}: ${file}` : task
              }),
              maxIterations: plan.length,
              currentIteration: 0,
            })
            // init tool call list
            for (const step of plan) {
              if (!step?.id) continue
              chatStore.addAgentToolCall({
                id: `${sessionId}:${backendRunId || ''}:${step.id}`,
                toolName: String(step.task || ''),
                params: step.args || {},
                status: 'pending',
                timestamp: Date.now(),
              })
            }
          }
          return
        }

        if (type === 'awaiting_confirmation') {
          const taskId = Number((ev as any).task_id)
          const toolName = String((ev as any).task || '')
          const args = ((ev as any).args || {}) as Record<string, any>
          const runId = backendRunId || String((ev as any).run_id || '')
          chatStore.setAgentState({
            phase: 'awaiting_confirmation',
            pendingConfirmation: {
              id: `${sessionId}:${runId}:${taskId}`,
              toolName,
              params: args,
              backend: { baseUrl, sessionId, runId, taskId },
            },
          })
          return
        }

        if (type === 'progress') {
          const taskId = Number((ev as any).task_id)
          const status = String((ev as any).status || '')
          const plan = planById.get(taskId)
          const callId = `${sessionId}:${backendRunId || ''}:${taskId}`
          const mappedStatus =
            status === 'running' ? 'running' :
            status === 'completed' ? 'success' :
            status === 'failed' ? 'error' :
            status === 'retrying' ? 'running' :
            status === 'skipped' ? 'error' :
            'pending'

          chatStore.updateAgentToolCall(callId, {
            toolName: String((ev as any).task || plan?.task || ''),
            params: plan?.args || {},
            status: mappedStatus as any,
            result: status === 'completed'
              ? { success: true, data: (ev as any).output, message: 'completed' }
              : status === 'failed'
                ? { success: false, error: String((ev as any).error || 'failed') }
                : undefined,
          })

          const currentIteration = Math.max(0, (chatStore.agentState?.currentIteration || 0))
          if (status === 'running') {
            chatStore.setAgentState({ currentIteration: Math.max(currentIteration, taskId) })
          }

          if (status === 'completed') {
            const task = String((ev as any).task || plan?.task || '')
            const out = (ev as any).output || {}
            const toolResult = out?.data?.tool_result
            const outPath =
              toolResult?.meta?.file_path ||
              toolResult?.meta?.filePath ||
              toolResult?.results?.[0]?.url ||
              out?.asset_uri ||
              ''

            if (task === 'write_file' && matchesActive(outPath)) {
              needsRefreshAfterWrite = true
              if (activeFilePath) {
                void useArticleStore.getState().readArticle(activeFilePath)
              }
            }

            if (task === 'read_file' && matchesActive(outPath) && needsRefreshAfterWrite) {
              const content = String(out?.data?.content ?? toolResult?.results?.[0]?.content ?? '')
              if (activeFilePath && content) {
                useArticleStore.getState().setCurrentArticle(content)
              } else if (activeFilePath) {
                void useArticleStore.getState().readArticle(activeFilePath)
              }
              needsRefreshAfterWrite = false
            }
          }
          return
        }

      if (type === 'run_completed') {
        const result = (ev as any).result
        const summary = buildRunSummaryFromResultZh(result)
        chatStore.setAgentState({ phase: 'completed', isRunning: false, pendingConfirmation: undefined })
        void this.config.onComplete(summary)
        return
      }
      }, signal)
    } catch (e: any) {
      const error = e instanceof Error ? e.message : String(e)
      chatStore.setAgentState({ phase: 'error', isRunning: false, lastError: error })
      await this.config.onError(error)
    } finally {
      this.abortController = null
    }
  }
}
