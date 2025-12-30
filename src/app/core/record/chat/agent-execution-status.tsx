import * as React from "react"
import { Loader2, ChevronRight, Brain, CheckCircle, XCircle, Clock } from "lucide-react"
import useChatStore from "@/stores/chat"
import { Button } from "@/components/ui/button"

function extractToolContent(call: any): string {
  const data = call?.result?.data
  const content =
    data?.data?.content ??
    data?.data?.tool_result?.results?.[0]?.content ??
    ''
  return typeof content === 'string' ? content : ''
}

function extractToolMeta(call: any): any {
  const data = call?.result?.data
  return data?.data?.tool_result?.results?.[0]?.meta ?? {}
}

function getDiffLineClass(line: string): string {
  const first = line.slice(0, 1)
  if (first === '+') return 'agent-diff-line agent-diff-plus'
  if (first === '-') return 'agent-diff-line agent-diff-minus'
  if (line.startsWith('@@')) return 'agent-diff-line agent-diff-hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'agent-diff-line agent-diff-header'
  return 'agent-diff-line'
}

export function AgentExecutionStatus() {
  const { agentState, resolveAgentConfirmation } = useChatStore()
  const [isThoughtExpanded, setIsThoughtExpanded] = React.useState(false)
  const [expandedToolCalls, setExpandedToolCalls] = React.useState<Set<string>>(new Set())
  const [expandedRaw, setExpandedRaw] = React.useState<Set<string>>(new Set())

  // 只在 Agent 运行时显示
  if (!agentState.isRunning) {
    return null
  }

  const toggleToolCallExpand = (id: string) => {
    const next = new Set(expandedToolCalls)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpandedToolCalls(next)
  }

  const toggleRawExpand = (id: string) => {
    const next = new Set(expandedRaw)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpandedRaw(next)
  }

  // 提取思考内容的标题（第一行或前 50 个字符）
  const extractTitle = (thought: string): string => {
    const firstLine = thought.split('\n')[0]
    if (firstLine.length > 50) {
      return firstLine.substring(0, 50) + '...'
    }
    return firstLine || thought.substring(0, 50) + '...'
  }

  // 合并连续思考为一条展示（展开后可看完整内容）
  const mergedThoughts = [...(agentState.thoughtHistory || []), agentState.currentThought]
    .filter(Boolean)
    .join('\n\n')
  const mergedTitle = mergedThoughts ? extractTitle(mergedThoughts) : ''
  const lastConfirmation = agentState.confirmationHistory[agentState.confirmationHistory.length - 1]
  const statusTitle =
    agentState.pendingConfirmation
      ? `等待确认：${agentState.pendingConfirmation.toolName}`
      : agentState.currentAction
        ? `执行：${agentState.currentAction}`
        : agentState.phase === 'planning'
          ? '规划中...'
          : agentState.phase === 'executing'
            ? '执行中...'
            : '运行中...'

  return (
    <div className="w-full space-y-1">
      {/* 计划 */}
      {agentState.plan.length > 0 && (
        <div className="py-1.5 px-3 rounded bg-muted/40">
          <div className="text-xs font-medium text-muted-foreground mb-1">
            计划（{agentState.plan.length}） · {agentState.currentIteration}/{agentState.maxIterations}
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            {agentState.plan.map((item, i) => (
              <div key={i}>{i + 1}. {item}</div>
            ))}
          </div>
        </div>
      )}

      {/* 思考：合并展示为一条 */}
      {mergedThoughts && (
        <div className="space-y-1">
          <div
            className="flex items-center gap-2 py-1.5 px-3 rounded hover:bg-muted/50 cursor-pointer group bg-muted/40"
            onClick={() => setIsThoughtExpanded(v => !v)}
          >
            {(agentState.phase === 'planning' || agentState.phase === 'executing') ? (
              <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" />
            ) : (
              <Brain className="size-3.5 text-blue-500 flex-shrink-0" />
            )}
            <span className="text-xs text-muted-foreground flex-1 break-words">
              {mergedTitle || statusTitle}
            </span>
            <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${isThoughtExpanded ? 'rotate-90' : ''}`} />
          </div>

          {isThoughtExpanded && (
            <div className="pl-6 pr-3 pb-2 text-xs text-muted-foreground whitespace-pre-wrap">
              {mergedThoughts}
            </div>
          )}

          {/* 最近一次确认记录：合并后只展示最后一条即可 */}
          {lastConfirmation && (
            <div className="flex items-center gap-2 py-1.5 px-3 rounded">
              {lastConfirmation.status === 'confirmed' ? (
                <CheckCircle className="size-3.5 text-green-500 flex-shrink-0" />
              ) : (
                <XCircle className="size-3.5 text-red-500 flex-shrink-0" />
              )}
              <code className="text-xs text-muted-foreground flex-1 break-words font-mono">
                {lastConfirmation.toolName}
              </code>
            </div>
          )}
        </div>
      )}

      {/* 没有 reasoning 思考内容时，也保留一条状态行，避免空白 */}
      {!mergedThoughts && (
        <div className="py-1.5 px-3 rounded bg-muted/40 flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" />
          <span className="text-xs text-muted-foreground break-words">{statusTitle}</span>
        </div>
      )}

      {/* 当前确认请求：无论是否有思考内容都显示 */}
      {agentState.pendingConfirmation && (
        <div className="flex items-center gap-2 py-1.5 px-3 rounded bg-muted">
          <Clock className="size-3.5 text-orange-500 flex-shrink-0 animate-pulse" />
          <code className="text-xs text-muted-foreground flex-1 break-words font-mono">
            {agentState.pendingConfirmation.toolName}
          </code>
          <div className="flex gap-1 flex-shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => resolveAgentConfirmation(false)}
              aria-label="取消"
              title="取消"
            >
              <XCircle className="size-3.5 text-red-500" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              onClick={() => resolveAgentConfirmation(true)}
              aria-label="确认"
              title="确认"
            >
              <CheckCircle className="size-3.5 text-green-500" />
            </Button>
          </div>
        </div>
      )}

      {/* 工具调用 */}
      {agentState.toolCalls.length > 0 && (
        <div className="pt-1">
          {agentState.toolCalls.map((call) => {
            const expanded = expandedToolCalls.has(call.id)
            const showRaw = expandedRaw.has(call.id)
            const statusIcon =
              call.status === 'success' ? <CheckCircle className="size-3.5 text-green-500 flex-shrink-0" /> :
              call.status === 'error' ? <XCircle className="size-3.5 text-red-500 flex-shrink-0" /> :
              call.status === 'running' ? <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" /> :
              <Clock className="size-3.5 text-muted-foreground flex-shrink-0" />

            return (
              <div key={call.id} className="space-y-1">
                <div
                  className="flex items-center gap-2 py-1.5 px-3 rounded hover:bg-muted/50 cursor-pointer"
                  onClick={() => toggleToolCallExpand(call.id)}
                >
                  {statusIcon}
                  <code className="text-xs text-muted-foreground flex-1 break-words font-mono">
                    {(call as any).label || call.toolName}
                  </code>
                  <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
                </div>
                {expanded && (
                  <div className="pl-6 pr-3 pb-2 text-xs text-muted-foreground">
                    {call?.result?.success && call.toolName === 'diff_preview' && (
                      <div className="mt-2">
                        <div className="font-medium text-xs mb-1 text-foreground/80">Diff</div>
                        <div className="agent-diff-box">
                          {(extractToolContent(call) || '(no diff)').split('\n').map((line, idx) => (
                            <div key={idx} className={getDiffLineClass(line)}>
                              {line || ' '}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {call?.result?.success && call.toolName === 'replace_snippet' && (
                      <div className="mt-2">
                        <div className="font-medium text-xs mb-1 text-foreground/80">Snippet Change</div>
                        <pre className="text-xs p-2 rounded bg-muted/60 overflow-auto max-h-64 whitespace-pre font-mono">
                          {(() => {
                            const m = extractToolMeta(call) || {}
                            const before = String(m.before_preview || '')
                            const after = String(m.after_preview || '')
                            if (!before && !after) return '(no preview)'
                            return `--- before\\n${before}\\n\\n+++ after\\n${after}`
                          })()}
                        </pre>
                      </div>
                    )}

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        className="text-xs underline text-muted-foreground hover:text-foreground/80"
                        onClick={(e) => { e.stopPropagation(); toggleRawExpand(call.id) }}
                        type="button"
                      >
                        {showRaw ? '隐藏详情' : '显示详情'}
                      </button>
                    </div>

                    {showRaw && (
                      <div className="mt-2 whitespace-pre-wrap">
                        <div>Params: {JSON.stringify(call.params, null, 2)}</div>
                        {call.result && <div className="mt-2">Result: {JSON.stringify(call.result, null, 2)}</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
