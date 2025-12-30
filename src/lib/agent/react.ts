import OpenAI from 'openai'
import { getAISettings, createOpenAIClient } from '@/lib/ai'
import { ReActStep, ToolCall, ToolResult, ToolParameter } from './types'
import { allTools, getToolByName } from './tools'
import { useMcpStore } from '@/stores/mcp'
import { callTool, formatToolResult, getOpenAIFunctions } from '@/lib/mcp/tools'
import { parseChatCompletionStream } from '@/lib/llm/tool-calls'

export interface ReActConfig {
  maxIterations: number
  onThought?: (thought: string) => void
  onContent?: (content: string) => void
  onPlan?: (plan: string[]) => void
  onAction?: (action: string, params: Record<string, any>) => void
  onObservation?: (observation: string) => void
  onToolCall?: (toolCall: ToolCall) => void
  onIterationStart?: (iteration: number) => void
  requestConfirmation?: (toolName: string, params: Record<string, any>) => Promise<boolean>
}

type OpenAIToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export class ReActAgent {
  private config: ReActConfig
  private steps: ReActStep[] = []
  private currentIteration = 0
  private toolCallCounter = 0
  private stopped = false
  private abortController: AbortController | null = null
  private openai: OpenAI | null = null
  private model: string | null = null
  private toolCallHistory: ToolCall[] = []

  constructor(config: ReActConfig) {
    this.config = config
    if (!this.config.maxIterations) {
      this.config.maxIterations = 15
    }
  }

  stop() {
    this.stopped = true
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  async runWithMessages(options: {
    openai: OpenAI
    model: string
    messages: any[]
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
    temperature?: number
    topP?: number
    maxIterations?: number
    abortSignal?: AbortSignal
  }): Promise<string> {
    this.steps = []
    this.currentIteration = 0
    this.toolCallCounter = 0
    this.stopped = false
    this.toolCallHistory = []

    this.openai = options.openai
    this.model = options.model

    const tools = options.tools || []
    const { finalAnswer } = await this.runToolLoop({
      openai: options.openai,
      model: options.model,
      messages: options.messages,
      tools,
      temperature: options.temperature,
      topP: options.topP,
      maxIterations: options.maxIterations ?? this.config.maxIterations,
      abortSignal: options.abortSignal,
      extractThinkBlocks: false,
      suppressContentAfterToolCall: true,
      clearContentOnFirstToolCall: true,
    })

    return finalAnswer
  }

  async run(userInput: string, context?: string, attachments?: { imageUrls?: string[] }): Promise<string> {
    this.steps = []
    this.currentIteration = 0
    this.toolCallCounter = 0
    this.stopped = false
    this.toolCallHistory = []

    const aiConfig = await getAISettings()
    if (!aiConfig?.baseURL || !aiConfig?.model) {
      return 'AI 未配置：请先在设置中选择主模型并填写服务地址。'
    }

    const openai = await createOpenAIClient(aiConfig)
    this.openai = openai
    this.model = aiConfig.model
    const tools = this.getOpenAITools()
    const systemPrompt = this.buildSystemPrompt()

    const plan = await this.generatePlan(openai, aiConfig.model, userInput, context)
    if (this.stopped) return ''
    if (plan.length) {
      this.config.onPlan?.(plan)
    }

    const initialUserContent: any = attachments?.imageUrls && attachments.imageUrls.length > 0
      ? ([
          { type: 'text', text: userInput },
          ...attachments.imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))
        ])
      : userInput

    let messages: any[] = [
      { role: 'system', content: systemPrompt },
      ...(plan.length ? [{ role: 'system', content: `执行计划：\n${plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` }] : []),
      ...(context ? [{ role: 'system', content: `上下文信息：\n${context}` }] : []),
      { role: 'user', content: initialUserContent },
    ]

    const { finalAnswer } = await this.runToolLoop({
      openai,
      model: aiConfig.model,
      messages,
      tools,
      temperature: aiConfig.temperature,
      topP: aiConfig.topP,
      maxIterations: this.config.maxIterations,
      abortSignal: undefined,
      extractThinkBlocks: true,
      suppressContentAfterToolCall: false,
      clearContentOnFirstToolCall: false,
    })

    if (this.stopped) return ''

    const summarized = await this.generateSummary(
      openai,
      aiConfig.model,
      userInput,
      plan,
      this.toolCallHistory,
      finalAnswer
    )

    return summarized || finalAnswer
  }

  private async runToolLoop(options: {
    openai: OpenAI
    model: string
    messages: any[]
    tools: OpenAI.Chat.Completions.ChatCompletionTool[]
    temperature?: number
    topP?: number
    maxIterations: number
    abortSignal?: AbortSignal
    extractThinkBlocks: boolean
    suppressContentAfterToolCall: boolean
    clearContentOnFirstToolCall: boolean
  }): Promise<{ finalAnswer: string; messages: any[] }> {
    let messages = options.messages
    let finalAnswer = ''

    while (this.currentIteration < options.maxIterations) {
      if (this.stopped) return { finalAnswer: '', messages }
      if (options.abortSignal?.aborted) return { finalAnswer: '', messages }

      this.currentIteration++
      this.config.onIterationStart?.(this.currentIteration)

      const { content, toolCalls, thought } = await this.callModel(
        options.openai,
        options.model,
        messages,
        options.tools,
        options.temperature,
        options.topP,
        {
          abortSignal: options.abortSignal,
          extractThinkBlocks: options.extractThinkBlocks,
          suppressContentAfterToolCall: options.suppressContentAfterToolCall,
          clearContentOnFirstToolCall: options.clearContentOnFirstToolCall,
        }
      )
      if (this.stopped) return { finalAnswer: '', messages }
      if (options.abortSignal?.aborted) return { finalAnswer: '', messages }

      if (!toolCalls.length) {
        finalAnswer = content?.trim() || '任务执行完成。'
        break
      }

      if (options.clearContentOnFirstToolCall) {
        this.config.onContent?.('')
      }

      const toolResults: any[] = []
      for (const toolCall of toolCalls) {
        if (this.stopped) return { finalAnswer: '', messages }
        if (options.abortSignal?.aborted) return { finalAnswer: '', messages }

        const toolName = toolCall.function.name
        const params = safeParseJson(toolCall.function.arguments)

        this.config.onAction?.(toolName, params)

        const observation = await this.act(toolName, params)
        this.config.onObservation?.(observation)

        this.steps.push({
          thought: thought || content || '',
          action: { tool: toolName, params },
          observation,
        })

        toolResults.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: observation,
        })
      }

      messages = [
        ...messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls,
        },
        ...toolResults,
      ]
    }

    if (!finalAnswer && this.currentIteration >= options.maxIterations) {
      finalAnswer = '已达到最大迭代次数，任务可能未完全完成。'
    }

    return { finalAnswer, messages }
  }

  private buildSystemPrompt(): string {
    return [
      '你是一个高效的智能助手 Agent，需要通过工具来完成用户的任务。',
      '',
      '要求：',
      '- 能用工具就用工具，不要编造结果。',
      '- 每次只做必要步骤，完成后直接给出最终答案。',
      '- 如果缺少关键信息，先向用户提出明确问题。',
      '- 最终回答请包含：结论/概要/下一步（用简洁的要点）。',
      '',
      '你可以通过函数调用（tool calls）来使用工具。',
      '',
      '兼容性要求（非常重要）：',
      '- 如果当前模型/服务端不支持原生 tool calls，你必须在正文中输出一个 <tool_calls>...</tool_calls> 块，里面是 JSON 数组。',
      '- <tool_calls> 块内每一项格式：{ "toolName": string, "params": object }',
      '- 除 <tool_calls> 块外，可以正常输出中文说明；但不要声称“已写入/已更新”除非工具真实执行成功。',
    ].join('\n')
  }

  private getOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    // 将内部 Tool 映射为 OpenAI function tool schema
    const internalTools: OpenAI.Chat.Completions.ChatCompletionTool[] = allTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toolParametersToJsonSchema(tool.parameters),
      },
    }))

    const selectedServerIds = useMcpStore.getState().selectedServerIds
    const mcpTools: OpenAI.Chat.Completions.ChatCompletionTool[] = selectedServerIds.length
      ? (getOpenAIFunctions(selectedServerIds) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[])
      : []

    return [...internalTools, ...mcpTools]
  }

  private async generatePlan(openai: OpenAI, model: string, userInput: string, context?: string): Promise<string[]> {
    if (this.stopped) return []

    const prompt = [
      '你是任务规划助手。请基于用户请求输出一个可执行计划。',
      '要求：只输出 JSON 数组，例如：["步骤1", "步骤2"]，最多 6 条。',
      context ? `上下文：\n${context}` : '',
      `用户请求：\n${userInput}`,
    ].filter(Boolean).join('\n\n')

    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: '只输出 JSON 数组，不要输出其它文本。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      })

      const content = completion.choices[0]?.message?.content || '[]'
      const parsed = safeParseJsonArray(content)
      return parsed.slice(0, 6)
    } catch {
      return []
    }
  }

  private async callModel(
    openai: OpenAI,
    model: string,
    messages: any[],
    tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    temperature?: number,
    topP?: number,
    options?: {
      abortSignal?: AbortSignal
      extractThinkBlocks?: boolean
      suppressContentAfterToolCall?: boolean
      clearContentOnFirstToolCall?: boolean
    }
  ): Promise<{ content: string; thought: string; toolCalls: OpenAIToolCall[] }> {
    const controller = new AbortController()
    this.abortController = controller

    const externalAbortSignal = options?.abortSignal
    const onAbort = () => {
      try {
        controller.abort()
      } catch {}
    }
    if (externalAbortSignal?.aborted) onAbort()
    externalAbortSignal?.addEventListener('abort', onAbort, { once: true })

    const requestParams: any = {
      model,
      messages,
      stream: true,
      temperature,
      top_p: topP,
    }

    if (tools.length > 0) {
      requestParams.tools = tools
      requestParams.tool_choice = 'auto'
    }

    try {
      const stream = await openai.chat.completions.create(requestParams, {
        signal: controller.signal,
      }) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>

      let thought = ''
      let streamedContent = ''
      const parsed = await parseChatCompletionStream(stream, {
        abortSignal: controller.signal,
        suppressContentAfterToolCall: Boolean(options?.suppressContentAfterToolCall),
        clearContentOnFirstToolCall: Boolean(options?.clearContentOnFirstToolCall),
        onReasoningDelta: (delta) => {
          thought += delta
          if (thought) this.config.onThought?.(thought)
        },
        onContentDelta: (delta) => {
          streamedContent += delta
          this.config.onContent?.(streamedContent)
        },
      })

      this.abortController = null
      externalAbortSignal?.removeEventListener('abort', onAbort)

      const extractThinkBlocks = options?.extractThinkBlocks !== false
      const { content: cleanedContent, extractedThought } = extractThinkBlocks
        ? stripThinkBlocks(parsed.content)
        : { content: String(parsed.content || ''), extractedThought: '' }

      const mergedThought = [parsed.reasoning, extractedThought].filter(Boolean).join('\n\n')

      const normalizedToolCalls = parsed.toolCalls.filter(Boolean) as OpenAIToolCall[]
      if (normalizedToolCalls.length > 0) {
        return { content: cleanedContent, thought: mergedThought, toolCalls: normalizedToolCalls }
      }

      // 兼容：从正文中解析 <tool_calls> JSON（适配不支持原生 tool call 的模型）
      const parsedFromContent = parseToolCallsFromContent(cleanedContent)
      if (parsedFromContent.length > 0) {
        return { content: removeToolCallsBlock(cleanedContent), thought: mergedThought, toolCalls: parsedFromContent }
      }

      // 兜底：如果模型“口头说要写文件/用工具”但没发 tool calls，则再走一轮“结构化工具提取”
      if (shouldSynthesizeToolCalls(cleanedContent)) {
        const synthesized = await this.synthesizeToolCalls(openai, model, messages, cleanedContent, tools, temperature)
        if (synthesized.length > 0) {
          return { content: removeToolCallsBlock(cleanedContent), thought: mergedThought, toolCalls: synthesized }
        }
      }

      return { content: cleanedContent, thought: mergedThought, toolCalls: [] }
    } catch (error) {
      this.abortController = null
      externalAbortSignal?.removeEventListener('abort', onAbort)

      if (controller.signal.aborted || externalAbortSignal?.aborted || this.stopped) {
        return { content: '', thought: '', toolCalls: [] }
      }

      throw error
    }
  }

  private async synthesizeToolCalls(
    openai: OpenAI,
    model: string,
    messages: any[],
    assistantDraft: string,
    tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    temperature?: number
  ): Promise<OpenAIToolCall[]> {
    if (this.stopped) return []

    // 只暴露最常用/最安全的一小撮工具，避免模型乱选
    const allow = new Set([
      'get_current_article',
      'read_workspace_file',
      'list_workspace_files',
      'replace_current_article_lines',
      'update_article',
      'write_workspace_file',
      'write_file',
    ])

    const exposed = tools
      .filter(t => t.type === 'function' && allow.has((t as any)?.function?.name))
      .map(t => (t as any).function)

    if (exposed.length === 0) return []

    const lastUser = [...messages].reverse().find(m => m?.role === 'user')?.content

    const prompt = [
      '你是工具调用提取器。当前模型可能不支持原生 tool calls。',
      '请基于用户请求与当前草稿，输出下一步应该执行的工具调用列表。',
      '',
      '输出要求：',
      '- 只输出 JSON 数组，不要输出其它文本。',
      '- 每一项格式：{ "toolName": string, "params": object }',
      '- 只能从“可用工具”里选择 toolName。',
      '- 不要编造“已写入/已更新”，这里只负责生成要调用的工具。',
      '',
      `用户请求：${typeof lastUser === 'string' ? lastUser : JSON.stringify(lastUser ?? '')}`,
      assistantDraft ? `草稿（可能包含“下一步/工具名”的文字，但未必真的执行过）：\n${assistantDraft}` : '',
      `可用工具(JSON Schema)：${JSON.stringify(exposed)}`,
    ].filter(Boolean).join('\n\n')

    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: '只输出 JSON 数组，不要输出其它文本。' },
          { role: 'user', content: prompt },
        ],
        temperature: typeof temperature === 'number' ? Math.min(0.2, Math.max(0, temperature)) : 0.1,
      })

      const raw = completion.choices[0]?.message?.content || '[]'
      const parsedAny = (() => {
        try {
          return JSON.parse(raw)
        } catch {
          const match = String(raw).match(/\[[\s\S]*\]/)
          if (!match) return []
          try {
            return JSON.parse(match[0])
          } catch {
            return []
          }
        }
      })()

      if (!Array.isArray(parsedAny)) return []

      return parsedAny
        .map((item: any, idx: number) => {
          const toolName = String(item?.toolName || item?.name || item?.tool || '')
          const params = item?.params || item?.arguments || item?.args || {}
          if (!toolName) return null
          return {
            id: `synth-${Date.now()}-${idx}-${Math.random().toString(36).slice(2)}`,
            type: 'function' as const,
            function: {
              name: toolName,
              arguments: JSON.stringify(params ?? {}),
            },
          }
        })
        .filter(Boolean) as OpenAIToolCall[]
    } catch {
      return []
    }
  }

  private async act(toolName: string, params: Record<string, any>): Promise<string> {
    const internalTool = getToolByName(toolName)
    const mcpParsed = parseMcpToolName(toolName)
    if (!internalTool && !mcpParsed) {
      return `错误：未找到工具 "${toolName}"。`
    }

    this.toolCallCounter++
    const toolCall: ToolCall = {
      id: `${Date.now()}-${this.toolCallCounter}-${Math.random().toString(36).substr(2, 9)}`,
      toolName,
      params,
      status: 'pending',
      timestamp: Date.now(),
    }

    this.config.onToolCall?.(toolCall)
    this.upsertToolCallHistory(toolCall)

    // 参数校验 + 自动修复一次（优先解决“参数乱填”导致的失败）
    const { normalizedParams, errors, schemaHint } = await this.validateAndNormalizeToolArgs(toolName, internalTool, mcpParsed, params)
    let finalParams = normalizedParams

    if (errors.length > 0) {
      const repaired = await this.repairToolArgsOnce(toolName, schemaHint, errors, finalParams)
      if (repaired) {
        const recheck = await this.validateAndNormalizeToolArgs(toolName, internalTool, mcpParsed, repaired)
        if (recheck.errors.length === 0) {
          finalParams = recheck.normalizedParams
        } else {
          toolCall.status = 'error'
          toolCall.params = finalParams
          toolCall.result = { success: false, error: `参数校验失败：${recheck.errors.join('; ')}` }
          this.config.onToolCall?.(toolCall)
          this.upsertToolCallHistory(toolCall)
          return `参数校验失败：${recheck.errors.join('; ')}`
        }
      } else {
        toolCall.status = 'error'
        toolCall.params = finalParams
        toolCall.result = { success: false, error: `参数校验失败：${errors.join('; ')}` }
        this.config.onToolCall?.(toolCall)
        this.upsertToolCallHistory(toolCall)
        return `参数校验失败：${errors.join('; ')}`
      }
    }

    toolCall.params = finalParams

    const requiresConfirmation = Boolean(internalTool?.requiresConfirmation) || Boolean(mcpParsed)
    if (requiresConfirmation && this.config.requestConfirmation) {
      const confirmed = await this.config.requestConfirmation(toolName, finalParams)
      if (!confirmed) {
        toolCall.status = 'error'
        toolCall.result = { success: false, error: '用户取消了操作' }
        this.config.onToolCall?.(toolCall)
        this.upsertToolCallHistory(toolCall)
        return '用户取消了操作'
      }
    }

    toolCall.status = 'running'
    this.config.onToolCall?.(toolCall)
    this.upsertToolCallHistory(toolCall)

    try {
      const result: ToolResult = internalTool
        ? await internalTool.execute(finalParams)
        : await executeMcpToolCall(mcpParsed, finalParams)

      toolCall.status = result.success ? 'success' : 'error'
      toolCall.result = result
      this.config.onToolCall?.(toolCall)
      this.upsertToolCallHistory(toolCall)
      return result.success ? (result.message || '工具执行成功') : `工具执行失败：${result.error}`
    } catch (error) {
      toolCall.status = 'error'
      toolCall.result = { success: false, error: String(error) }
      this.config.onToolCall?.(toolCall)
      this.upsertToolCallHistory(toolCall)
      return `工具执行出错：${error}`
    }
  }

  private upsertToolCallHistory(toolCall: ToolCall) {
    const existingIndex = this.toolCallHistory.findIndex(c => c.id === toolCall.id)
    if (existingIndex >= 0) {
      this.toolCallHistory[existingIndex] = { ...this.toolCallHistory[existingIndex], ...toolCall }
    } else {
      this.toolCallHistory.push(toolCall)
    }
  }

  private async validateAndNormalizeToolArgs(
    toolName: string,
    internalTool: ReturnType<typeof getToolByName> | undefined,
    mcpParsed: { serverId: string; toolName: string } | null,
    params: Record<string, any>
  ): Promise<{ normalizedParams: Record<string, any>; errors: string[]; schemaHint: Record<string, any> }> {
    if (internalTool) {
      const { normalized, errors } = validateInternalToolArgs(internalTool.parameters, params)
      return {
        normalizedParams: normalized,
        errors,
        schemaHint: toolParametersToJsonSchema(internalTool.parameters),
      }
    }

    // MCP 参数校验（复用现有 schema）
    const schemaHint = { type: 'object', properties: {}, required: [] as string[] }
    if (!mcpParsed) {
      return { normalizedParams: params || {}, errors: [`未找到工具 "${toolName}"`], schemaHint }
    }

    const { mcpServerManager } = await import('@/lib/mcp/server-manager')
    const mcpTools = mcpServerManager.getServerTools(mcpParsed.serverId) as any[]
    const mcpTool = mcpTools.find(t => t.name === mcpParsed.toolName)
    if (!mcpTool) {
      return { normalizedParams: params || {}, errors: [`未找到 MCP 工具 "${toolName}"`], schemaHint }
    }

    const { validateToolArgs } = await import('@/lib/mcp/tools')
    const validation = validateToolArgs(mcpTool, params || {})
    return {
      normalizedParams: params || {},
      errors: validation.valid ? [] : validation.errors,
      schemaHint: mcpTool.inputSchema || schemaHint,
    }
  }

  private async repairToolArgsOnce(
    toolName: string,
    schema: Record<string, any>,
    errors: string[],
    params: Record<string, any>
  ): Promise<Record<string, any> | null> {
    if (this.stopped) return null
    if (!this.openai || !this.model) return null

    const prompt = [
      '你是参数修复器。需要为一个工具调用生成正确的 JSON 参数对象。',
      '要求：只输出 JSON 对象本身，不要输出其它文本。',
      `工具名：${toolName}`,
      `参数 schema：${JSON.stringify(schema)}`,
      `当前参数：${JSON.stringify(params)}`,
      `校验错误：${errors.join('; ')}`,
    ].join('\n\n')

    try {
      const completion = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: '只输出 JSON 对象，不要输出其它文本。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      })
      const content = completion.choices[0]?.message?.content || ''
      const repaired = safeParseJson(content)
      return Object.keys(repaired).length ? repaired : null
    } catch {
      return null
    }
  }

  private async generateSummary(
    openai: OpenAI,
    model: string,
    userInput: string,
    plan: string[],
    toolCalls: ToolCall[],
    finalAnswer: string
  ): Promise<string> {
    const toolSummary = toolCalls.map(c => ({
      toolName: c.toolName,
      status: c.status,
      message: c.result?.message,
      error: c.result?.error,
    }))

    const prompt = [
      '你是总结器。请把 Agent 的执行结果整理成固定结构的 Markdown。',
      '必须包含以下小节（按顺序）：',
      '1) 结论',
      '2) 执行概览（列出计划与执行情况）',
      '3) 工具调用（精简列出工具名 + 成功/失败 + 关键信息）',
      '4) 下一步',
      '',
      '强约束：',
      '- “工具调用”小节只能基于 `工具调用摘要(JSON)`，不得编造不存在的工具名/状态。',
      '- 如果 `工具调用摘要(JSON)` 为空数组，工具调用小节必须写“无”。',
      '- 不要输出 <think> / <thinking> 之类的思维链。',
      '',
      `用户请求：${userInput}`,
      plan.length ? `计划：\n${plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '计划：无',
      `工具调用摘要(JSON)：${JSON.stringify(toolSummary)}`,
      `原始最终回答：${finalAnswer}`,
    ].join('\n\n')

    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: '输出 Markdown，简洁、可执行、不要输出代码块 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      })
      return completion.choices[0]?.message?.content?.trim() || ''
    } catch {
      return ''
    }
  }

  getSteps(): ReActStep[] {
    return this.steps
  }

  getCurrentIteration(): number {
    return this.currentIteration
  }
}

function stripThinkBlocks(text: string): { content: string; extractedThought: string } {
  const raw = String(text || '')
  let extracted = ''
  let cleaned = raw

  const patterns = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
  ]

  for (const re of patterns) {
    const matches = cleaned.match(re) || []
    if (matches.length) {
      extracted += (extracted ? '\n\n' : '') + matches.map(m => m.replace(/^<\w+>|<\/\w+>$/g, '')).join('\n\n')
      cleaned = cleaned.replace(re, '')
    }
  }

  return { content: cleaned.trim(), extractedThought: extracted.trim() }
}

function removeToolCallsBlock(text: string): string {
  const s = String(text || '')
  return s.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, '').trim()
}

function shouldSynthesizeToolCalls(content: string): boolean {
  const c = String(content || '').toLowerCase()
  return (
    c.includes('tool calls') ||
    c.includes('工具调用') ||
    c.includes('write_file') ||
    c.includes('write file') ||
    c.includes('write_workspace_file') ||
    c.includes('update_article') ||
    c.includes('replace_current_article_lines') ||
    c.includes('写入') ||
    c.includes('更新') ||
    c.includes('同步至原文件')
  )
}

function parseToolCallsFromContent(content: string): OpenAIToolCall[] {
  const text = String(content || '')
  const match = text.match(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/i)
  if (!match) return []

  const jsonText = match[1].trim()
  const parsed = safeParseJson(jsonText)

  let arr: any[] = []
  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (Array.isArray((parsed as any)?.tool_calls)) {
    arr = (parsed as any).tool_calls
  } else if (Array.isArray((parsed as any)?.toolCalls)) {
    arr = (parsed as any).toolCalls
  } else if (Array.isArray((parsed as any)?.calls)) {
    arr = (parsed as any).calls
  }

  return arr
    .map((item, idx) => {
      const toolName = String(item?.toolName || item?.name || item?.tool || '')
      const params = item?.params || item?.arguments || item?.args || {}
      if (!toolName) return null
      return {
        id: `synthetic-${Date.now()}-${idx}-${Math.random().toString(36).slice(2)}`,
        type: 'function' as const,
        function: {
          name: toolName,
          arguments: JSON.stringify(params ?? {}),
        },
      }
    })
    .filter(Boolean) as OpenAIToolCall[]
}

function toolParametersToJsonSchema(parameters: ToolParameter[]): Record<string, any> {
  const properties: Record<string, any> = {}
  const required: string[] = []

  for (const parameter of parameters) {
    const base: Record<string, any> = {
      description: parameter.description,
    }

    if (parameter.type === 'array') {
      properties[parameter.name] = { ...base, type: 'array', items: {} }
    } else if (parameter.type === 'object') {
      properties[parameter.name] = { ...base, type: 'object', additionalProperties: true }
    } else {
      properties[parameter.name] = { ...base, type: toolParamTypeToJsonSchemaType(parameter.type) }
    }

    if (parameter.required) {
      required.push(parameter.name)
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function toolParamTypeToJsonSchemaType(type: ToolParameter['type']): string {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
      return type
    default:
      return 'string'
  }
}

function safeParseJson(input: string): Record<string, any> {
  if (!input) return {}
  try {
    return JSON.parse(input)
  } catch {
    let jsonStr = input.trim()
    jsonStr = jsonStr.replace(/,\s*$/, '')
    jsonStr = jsonStr.replace(/,\s*}/, '}')
    jsonStr = jsonStr.replace(/:\s*$/, ': ""')

    const quotes = (jsonStr.match(/"/g) || []).length
    if (quotes % 2 !== 0) {
      jsonStr += '"'
    }

    const openBraces = (jsonStr.match(/{/g) || []).length
    const closeBraces = (jsonStr.match(/}/g) || []).length
    if (openBraces > closeBraces) {
      jsonStr += '}'.repeat(openBraces - closeBraces)
    }

    try {
      return JSON.parse(jsonStr)
    } catch {
      return {}
    }
  }
}

function validateInternalToolArgs(
  parameters: ToolParameter[],
  input: Record<string, any>
): { normalized: Record<string, any>; errors: string[] } {
  const normalized: Record<string, any> = { ...(input || {}) }
  const errors: string[] = []
  const allowedKeys = new Set(parameters.map(p => p.name))

  for (const param of parameters) {
    if (!(param.name in normalized) || normalized[param.name] === undefined) {
      if (param.default !== undefined) {
        normalized[param.name] = param.default
      } else if (param.required) {
        errors.push(`Missing required parameter: ${param.name}`)
      }
    }
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (!allowedKeys.has(key)) continue
    const spec = parameters.find(p => p.name === key)
    if (!spec) continue
    if (value === null || value === undefined) continue

    if (spec.type === 'array') {
      if (!Array.isArray(value)) errors.push(`Parameter "${key}" should be array`)
    } else if (spec.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) errors.push(`Parameter "${key}" should be object`)
    } else if (spec.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`Parameter "${key}" should be number`)
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`Parameter "${key}" should be boolean`)
    } else if (spec.type === 'string') {
      if (typeof value !== 'string') errors.push(`Parameter "${key}" should be string`)
    }
  }

  return { normalized, errors }
}

function safeParseJsonArray(input: string): string[] {
  if (!input) return []
  try {
    const parsed = JSON.parse(input)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    const match = input.match(/\[[\s\S]*\]/)
    if (!match) return []
    try {
      const parsed = JSON.parse(match[0])
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
}

function parseMcpToolName(fullName: string): { serverId: string; toolName: string } | null {
  if (!fullName.includes('__')) return null
  const [serverId, ...toolNameParts] = fullName.split('__')
  const toolName = toolNameParts.join('__')
  if (!serverId || !toolName) return null
  return { serverId, toolName }
}

async function executeMcpToolCall(parsed: { serverId: string; toolName: string } | null, params: Record<string, any>): Promise<ToolResult> {
  if (!parsed) {
    return { success: false, error: '未找到工具' }
  }
  const result = await callTool(parsed.serverId, parsed.toolName, params)
  const text = formatToolResult(result)
  if (result.isError) {
    return { success: false, error: text, message: text, data: result }
  }
  return { success: true, message: text, data: result }
}
