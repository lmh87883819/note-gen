import OpenAI from 'openai'

export type LlmToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

type AccumulatorState = {
  toolCallsByIndex: Array<LlmToolCall | undefined>
  legacyFunctionCallId: string | null
  sawToolCalls: boolean
}

export type StreamParseOptions = {
  abortSignal?: AbortSignal
  onReasoningDelta?: (delta: string) => void
  onContentDelta?: (delta: string) => void
  suppressContentAfterToolCall?: boolean
  clearContentOnFirstToolCall?: boolean
}

export type StreamParseResult = {
  content: string
  reasoning: string
  toolCalls: LlmToolCall[]
  sawToolCalls: boolean
}

function ensureToolCall(
  state: AccumulatorState,
  index: number,
  id: string,
  name: string
): LlmToolCall {
  if (!state.toolCallsByIndex[index]) {
    state.toolCallsByIndex[index] = {
      id,
      type: 'function',
      function: {
        name: name || '',
        arguments: '',
      },
    }
  }

  const current = state.toolCallsByIndex[index]!
  if (id) current.id = id
  if (name) current.function.name = name
  return current
}

function accumulateFromDelta(
  state: AccumulatorState,
  delta: OpenAI.Chat.Completions.ChatCompletionChunk['choices'][0]['delta']
) {
  if (!delta) return

  // New-style tool calls (array)
  if ((delta as any).tool_calls) {
    state.sawToolCalls = true
    for (const toolCall of (delta as any).tool_calls as any[]) {
      const index = Number.isFinite(toolCall?.index) ? Number(toolCall.index) : 0
      const id = String(toolCall?.id || '')
      const name = String(toolCall?.function?.name || '')
      const argsDelta = toolCall?.function?.arguments

      const current = ensureToolCall(state, index, id, name)
      if (argsDelta) current.function.arguments += String(argsDelta)
    }
  }

  // Legacy function_call (single)
  const legacy = (delta as any).function_call
  if (legacy) {
    state.sawToolCalls = true
    const index = 0
    if (!state.legacyFunctionCallId) {
      state.legacyFunctionCallId = `legacy-fc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    const id = state.legacyFunctionCallId
    const name = String(legacy?.name || '')
    const argsDelta = legacy?.arguments

    const current = ensureToolCall(state, index, id, name)
    if (argsDelta) current.function.arguments += String(argsDelta)
  }
}

export async function parseChatCompletionStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  options: StreamParseOptions = {}
): Promise<StreamParseResult> {
  const state: AccumulatorState = {
    toolCallsByIndex: [],
    legacyFunctionCallId: null,
    sawToolCalls: false,
  }

  let content = ''
  let reasoning = ''
  let suppressed = false

  for await (const chunk of stream) {
    if (options.abortSignal?.aborted) break

    const delta = chunk.choices[0]?.delta
    if (!delta) continue

    const thinkingDelta = String((delta as any)?.reasoning_content || '')
    if (thinkingDelta) {
      reasoning += thinkingDelta
      options.onReasoningDelta?.(thinkingDelta)
    }

    const contentDelta = String(delta.content || '')

    const hadToolCallsBefore = state.sawToolCalls
    accumulateFromDelta(state, delta)
    const hasToolCallsNow = state.sawToolCalls

    if (!hadToolCallsBefore && hasToolCallsNow) {
      if (options.clearContentOnFirstToolCall) {
        content = ''
      }
      if (options.suppressContentAfterToolCall) {
        suppressed = true
      }
    }

    if (!suppressed && contentDelta) {
      content += contentDelta
      options.onContentDelta?.(contentDelta)
    }
  }

  return {
    content,
    reasoning,
    toolCalls: state.toolCallsByIndex.filter(Boolean) as LlmToolCall[],
    sawToolCalls: state.sawToolCalls,
  }
}

