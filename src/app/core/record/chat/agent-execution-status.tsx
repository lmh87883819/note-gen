import React from "react"
import { Brain, CheckCircle, ChevronRight, Clock, Loader2, XCircle } from "lucide-react"
import useChatStore from "@/stores/chat"

function extractToolContent(call: any): string {
  const data = call?.result?.data
  const content =
    data?.data?.content ??
    data?.data?.tool_result?.results?.[0]?.content ??
    ""
  return typeof content === "string" ? content : ""
}

function extractToolMeta(call: any): any {
  const data = call?.result?.data
  return data?.data?.tool_result?.results?.[0]?.meta ?? {}
}

function isDiffLike(call: any): boolean {
  if (!call?.result?.success) return false
  if (call.toolName === "diff_preview") return true

  const tr = call?.result?.data?.data?.tool_result
  const first = Array.isArray(tr?.results) ? tr.results[0] : undefined
  const mime = String(first?.mime || "")
  if (mime.includes("diff")) return true

  const text = extractToolContent(call)
  return typeof text === "string" && (text.includes("\n@@") || text.startsWith("--- ") || text.startsWith("diff "))
}

function getDiffLineClass(line: string): string {
  const first = line.slice(0, 1)
  if (first === "+") return "agent-diff-line agent-diff-plus"
  if (first === "-") return "agent-diff-line agent-diff-minus"
  if (line.startsWith("@@")) return "agent-diff-line agent-diff-hunk"
  if (line.startsWith("+++")) return "agent-diff-line agent-diff-header"
  if (line.startsWith("---")) return "agent-diff-line agent-diff-header"
  return "agent-diff-line"
}

export function AgentExecutionStatus() {
  const { agentState, resolveAgentConfirmation } = useChatStore()
  const [isThoughtExpanded, setIsThoughtExpanded] = React.useState(false)
  const [expandedToolCalls, setExpandedToolCalls] = React.useState<Set<string>>(new Set())
  const [expandedRaw, setExpandedRaw] = React.useState<Set<string>>(new Set())

  React.useEffect(() => {
    if (agentState.pendingConfirmation) {
      // Undo is supported in editor, auto-confirm to keep flow smooth.
      resolveAgentConfirmation(true)
    }
  }, [agentState.pendingConfirmation, resolveAgentConfirmation])

  if (!agentState.isRunning) return null

  const toggleToolCallExpand = (id: string) => {
    setExpandedToolCalls((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleRawExpand = (id: string) => {
    setExpandedRaw((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const mergedThoughts = [...(agentState.thoughtHistory || []), agentState.currentThought]
    .filter(Boolean)
    .join("\n\n")

  const extractTitle = (thought: string): string => {
    const firstLine = thought.split("\n")[0] || ""
    return firstLine.length > 50 ? `${firstLine.slice(0, 50)}...` : firstLine
  }

  const statusTitle =
    agentState.pendingConfirmation
      ? `等待确认：${agentState.pendingConfirmation.toolName}`
      : agentState.currentAction
        ? `执行：${agentState.currentAction}`
        : agentState.phase === "planning"
          ? "规划中..."
          : agentState.phase === "executing"
            ? "执行中..."
            : "运行中..."

  return (
    <div className="w-full space-y-1">
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

      {mergedThoughts ? (
        <div className="space-y-1">
          <div
            className="flex items-center gap-2 py-1.5 px-3 rounded hover:bg-muted/50 cursor-pointer group bg-muted/40"
            onClick={() => setIsThoughtExpanded((v) => !v)}
          >
            {(agentState.phase === "planning" || agentState.phase === "executing") ? (
              <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" />
            ) : (
              <Brain className="size-3.5 text-blue-500 flex-shrink-0" />
            )}
            <span className="text-xs text-muted-foreground flex-1 break-words">
              {extractTitle(mergedThoughts) || statusTitle}
            </span>
            <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${isThoughtExpanded ? "rotate-90" : ""}`} />
          </div>
          {isThoughtExpanded && (
            <pre className="text-xs p-3 rounded bg-muted/40 overflow-auto max-h-64 whitespace-pre-wrap break-words">
              {mergedThoughts}
            </pre>
          )}
        </div>
      ) : (
        <div className="py-1.5 px-3 rounded bg-muted/40 flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" />
          <span className="text-xs text-muted-foreground break-words">{statusTitle}</span>
        </div>
      )}

      {agentState.pendingConfirmation && (
        <div className="flex items-center gap-2 py-1.5 px-3 rounded bg-muted/40">
          <Clock className="size-3.5 text-orange-500 flex-shrink-0 animate-pulse" />
          <span className="text-xs text-muted-foreground flex-1 break-words">
            正在自动确认：{agentState.pendingConfirmation.toolName}
          </span>
        </div>
      )}

      {agentState.toolCalls.length > 0 && (
        <div className="pt-1">
          {agentState.toolCalls.map((call) => {
            const expanded = expandedToolCalls.has(call.id)
            const showRaw = expandedRaw.has(call.id)
            const statusIcon =
              call.status === "success" ? <CheckCircle className="size-3.5 text-green-500 flex-shrink-0" /> :
              call.status === "error" ? <XCircle className="size-3.5 text-red-500 flex-shrink-0" /> :
              call.status === "running" ? <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" /> :
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
                  <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
                </div>

                {expanded && (
                  <div className="pl-6 pr-3 pb-2 text-xs text-muted-foreground">
                    {isDiffLike(call) && (
                      <div className="mt-2">
                        <div className="font-medium text-xs mb-1 text-foreground/80">Diff</div>
                        <div className="agent-diff-box">
                          {(extractToolContent(call) || "(no diff)").split("\n").map((line, idx) => (
                            <div key={idx} className={getDiffLineClass(line)}>
                              {line || " "}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {call?.result?.success && call.toolName === "replace_snippet" && (
                      <div className="mt-2">
                        <div className="font-medium text-xs mb-1 text-foreground/80">Snippet Change</div>
                        <pre className="text-xs p-2 rounded bg-muted/60 overflow-auto max-h-64 whitespace-pre font-mono">
                          {(() => {
                            const meta = extractToolMeta(call) || {}
                            const before = String(meta.before_preview || "")
                            const after = String(meta.after_preview || "")
                            if (!before && !after) return "(no preview)"
                            return `--- before\n${before}\n\n+++ after\n${after}`
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
                        {showRaw ? "隐藏详情" : "显示详情"}
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

