import * as React from "react"
import { ChevronRight, Brain } from "lucide-react"
import { CheckCircle, XCircle, Loader2, Clock } from "lucide-react"

interface AgentHistoryData {
  thought: string
  toolCalls: Array<{
    id: string
    toolName: string
    params: Record<string, any>
    status: 'pending' | 'running' | 'success' | 'error'
    result?: {
      success: boolean
      message?: string
      data?: any
      error?: string
    }
  }>
  iterations: number
}

interface AgentHistoryProps {
  historyJson: string
}

export function AgentHistory({ historyJson }: AgentHistoryProps) {
  const [expandedItems, setExpandedItems] = React.useState<Set<number>>(new Set())
  const [expandedToolCalls, setExpandedToolCalls] = React.useState<Set<string>>(new Set())

  let history: AgentHistoryData | null = null
  try {
    history = JSON.parse(historyJson)
  } catch {
    return null
  }

  if (!history || !history.thought) {
    return null
  }

  // 将思考内容按 \n\n 分割成多个思考步骤
  const thoughts = history.thought.split('\n\n').filter(t => t.trim())

  const toggleExpand = (index: number) => {
    const newExpanded = new Set(expandedItems)
    if (newExpanded.has(index)) {
      newExpanded.delete(index)
    } else {
      newExpanded.add(index)
    }
    setExpandedItems(newExpanded)
  }

  // 提取思考内容的标题（第一行或前50个字符）
  const extractTitle = (thought: string): string => {
    const firstLine = thought.split('\n')[0]
    if (firstLine.length > 50) {
      return firstLine.substring(0, 50) + '...'
    }
    return firstLine || thought.substring(0, 50) + '...'
  }

  const toggleToolCallExpand = (id: string) => {
    setExpandedToolCalls(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toolCalls = Array.isArray(history.toolCalls) ? history.toolCalls : []

  return (
    <div className="w-full space-y-1 mb-3">
      {thoughts.map((thought, index) => {
        const isExpanded = expandedItems.has(index)
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
          </div>
        )
      })}

      {toolCalls.length > 0 && (
        <div className="pt-1">
          {toolCalls.map((call) => {
            const expanded = expandedToolCalls.has(call.id)
            const statusIcon =
              call.status === 'success' ? <CheckCircle className="size-3.5 text-green-500 flex-shrink-0" /> :
              call.status === 'error' ? <XCircle className="size-3.5 text-red-500 flex-shrink-0" /> :
              call.status === 'running' ? <Loader2 className="size-3.5 animate-spin text-blue-500 flex-shrink-0" /> :
              <Clock className="size-3.5 text-muted-foreground flex-shrink-0" />

            const summary = call.result?.success
              ? (call.result?.message || 'success')
              : (call.result?.error || call.result?.message || 'error')

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
                    <div>Params: {JSON.stringify(call.params || {}, null, 2)}</div>
                    <div className="mt-2">Result: {summary}</div>
                    {call.result?.data !== undefined && (
                      <div className="mt-2">Data: {JSON.stringify(call.result.data, null, 2)}</div>
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
