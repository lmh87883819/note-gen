import * as React from "react"
import { Loader2, ChevronRight, Brain, CheckCircle, XCircle, Clock } from "lucide-react"
import useChatStore from "@/stores/chat"
import { Button } from "@/components/ui/button"

export function AgentExecutionStatus() {
  const { agentState, resolveAgentConfirmation } = useChatStore()
  const [expandedItems, setExpandedItems] = React.useState<Set<number>>(new Set())
  const [expandedToolCalls, setExpandedToolCalls] = React.useState<Set<string>>(new Set())

  // 只在 Agent 运行时显示
  if (!agentState.isRunning) {
    return null
  }

  const toggleExpand = (index: number) => {
    const newExpanded = new Set(expandedItems)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedItems(newExpanded)
  }

  const toggleToolCallExpand = (id: string) => {
    const next = new Set(expandedToolCalls)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpandedToolCalls(next)
  }

  // 提取思考内容的标题（第一行或前50个字符）
  const extractTitle = (thought: string): string => {
    const firstLine = thought.split('\n')[0]
    if (firstLine.length > 50) {
      return firstLine.substring(0, 50) + '...'
    }
    return firstLine || thought.substring(0, 50) + '...'
  }

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

      {/* 历史思考过程 */}
      {agentState.thoughtHistory.map((thought, index) => {
        const isExpanded = expandedItems.has(index)
        const confirmationRecord = agentState.confirmationHistory[index]
        const title = extractTitle(thought)
        
        return (
          <div key={index} className="space-y-1">
            {/* 思考卡片 - 单行 */}
            <div 
              className="flex items-center gap-2 py-1.5 px-3 rounded hover:bg-muted/50 cursor-pointer group"
              onClick={() => toggleExpand(index)}
            >
              <Brain className="size-3.5 text-blue-500 flex-shrink-0" />
              <span className="text-xs text-muted-foreground flex-1 break-words">
                {title}
              </span>
              <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
            </div>
            
            {/* 展开的详细内容 */}
            {isExpanded && (
              <div className="pl-6 pr-3 pb-2 text-xs text-muted-foreground whitespace-pre-wrap">
                {thought}
              </div>
            )}
            
            {/* 确认记录 - 单行 */}
            {confirmationRecord && (
              <div className="flex items-center gap-2 py-1.5 px-3 rounded">
                {confirmationRecord.status === 'confirmed' ? (
                  <CheckCircle className="size-3.5 text-green-500 flex-shrink-0" />
                ) : (
                  <XCircle className="size-3.5 text-red-500 flex-shrink-0" />
                )}
                <code className="text-xs text-muted-foreground flex-1 break-words font-mono">
                  {confirmationRecord.toolName}
                </code>
              </div>
            )}
          </div>
        )
      })}
      
      {/* 当前思考过程 - 完整显示，loading 图标 */}
      {agentState.currentThought && (
        <div className="space-y-1">
          <div className="py-1.5 px-3 rounded bg-muted">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" />
              <span className="text-xs font-medium text-blue-500">
                {agentState.phase === 'planning' ? '规划中...' : '执行中...'}
              </span>
            </div>
            <div className="text-xs text-muted-foreground whitespace-pre-wrap">
              {agentState.currentThought}
            </div>
          </div>
          
          {/* 当前确认请求 - 单行，按钮在右侧 */}
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
                >
                  <XCircle className="size-3.5 text-red-500" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0"
                  onClick={() => resolveAgentConfirmation(true)}
                >
                  <CheckCircle className="size-3.5 text-green-500" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 工具调用 */}
      {agentState.toolCalls.length > 0 && (
        <div className="pt-1">
          {agentState.toolCalls.map((call) => {
            const expanded = expandedToolCalls.has(call.id)
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
                    {call.toolName}
                  </code>
                  <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
                </div>
                {expanded && (
                  <div className="pl-6 pr-3 pb-2 text-xs text-muted-foreground whitespace-pre-wrap">
                    <div>Params: {JSON.stringify(call.params, null, 2)}</div>
                    {call.result && <div className="mt-2">Result: {JSON.stringify(call.result, null, 2)}</div>}
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
