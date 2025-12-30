"use client"
import { Send, Square } from "lucide-react"
import useSettingStore from "@/stores/setting"
import useChatStore from "@/stores/chat"
import useArticleStore from "@/stores/article"
import { fetchAiStream, getAISettings, createOpenAIClient } from "@/lib/ai"
import { TooltipButton } from "@/components/tooltip-button"
import { useImperativeHandle, forwardRef, useRef } from "react"
import { useTranslations } from "next-intl"
import useVectorStore from "@/stores/vector"
import { getContextForQuery } from '@/lib/rag'
import { invoke } from "@tauri-apps/api/core"
import { WorkspaceFile } from "@/lib/files"
import { readTextFile } from "@tauri-apps/plugin-fs"
import { getFilePathOptions, getWorkspacePath } from "@/lib/workspace"
import { useMcpStore } from "@/stores/mcp"
import { getOpenAIFunctions } from "@/lib/mcp/tools"
import { BackendAgentHandler } from "@/lib/agent/backend-agent-handler"

interface ChatSendProps {
  inputValue: string;
  onSent?: () => void;
  linkedFiles?: WorkspaceFile[];
  linkedSnippets?: { id: string; filePath: string; snippet: string }[];
  inlineImages?: { id: string; name: string; dataUrl: string }[];
}

export const ChatSend = forwardRef<{ sendChat: () => void }, ChatSendProps>(({ inputValue, onSent, linkedFiles, linkedSnippets, inlineImages }, ref) => {
  const { primaryModel } = useSettingStore()
  const { insert, loading, setLoading, saveChat, chats, chatMode, requestAgentConfirmation, agentMemorySummary, setAgentMemorySummary } = useChatStore()
  const { activeFilePath, currentArticle } = useArticleStore()
  const { isRagEnabled } = useVectorStore()
  const { selectedServerIds } = useMcpStore()
  const abortControllerRef = useRef<AbortController | null>(null)
  const agentHandlerRef = useRef<BackendAgentHandler | null>(null)
  const t = useTranslations()

  useImperativeHandle(ref, () => ({
    sendChat: handleSubmit
  }))

  // Agent 模式处理
  async function handleAgentMode(
    userInput: string,
    opts: { linkedFiles?: WorkspaceFile[]; linkedSnippets?: { id: string; filePath: string; snippet: string }[] } = {}
  ) {
    // 先创建一个占位的 AI 消息
    const placeholderMessage = await insert({
      role: 'system',
      content: '',
      type: 'chat',
      inserted: false,
    })

    if (!placeholderMessage) return

    // Agent 上下文：把 @ 引用的文件内容作为 context 传入（避免污染用户输入本身）
    const attachments = await buildLinkedFileAttachments(opts.linkedFiles)
    const inlineImageUrls = (inlineImages || []).map(i => i.dataUrl).filter(Boolean)
    const imageUrls = [...attachments.imageUrls, ...inlineImageUrls]
    const agentContext = buildAgentContext({
      activeFilePath,
      currentArticle,
      agentMemorySummary,
      linkedFilesContext: attachments.textContext,
      linkedSnippets: opts.linkedSnippets,
      chats,
    })

    // B2: 使用后端 Planner+Executor（SSE 事件）执行编辑器 Agent
    const agentHandler = new BackendAgentHandler({
      onComplete: async (result) => {
        // 获取 Agent 执行历史
        const { agentState } = useChatStore.getState()
        // 合并所有思考内容
        const allThoughts = [...agentState.thoughtHistory]
        if (agentState.currentThought) {
          allThoughts.push(agentState.currentThought)
        }
        const agentHistory = {
          thought: allThoughts.join('\n\n'),
          toolCalls: agentState.toolCalls,
          iterations: agentState.currentIteration,
        }
        
        // 更新占位消息
        await saveChat({
          ...placeholderMessage,
          content: result,
          agentHistory: JSON.stringify(agentHistory),
        }, true)

        // 触发式：接近“超窗/变慢”时才更新“记忆摘要”
        const shouldUpdateMemory = shouldUpdateAgentMemory({
          contextLength: agentContext.length,
          toolCallsCount: agentState.toolCalls.length,
          iterations: agentState.currentIteration,
          finalAnswerLength: (result || '').length,
        })
        if (shouldUpdateMemory) {
          const memory = await generateAgentMemorySummary({
            userRequest: userInput,
            plan: agentState.plan,
            toolCalls: agentState.toolCalls,
            finalAnswer: result,
          })
          if (memory) setAgentMemorySummary(memory)
        }
        
        // 清空 ref
        agentHandlerRef.current = null
      },
      onError: async (error) => {
        // 更新占位消息为错误信息
        await saveChat({
          ...placeholderMessage,
          content: `Error: ${error}`,
        }, true)
        
        // 清空 ref
        agentHandlerRef.current = null
      },
    })

    // 保存到 ref
    agentHandlerRef.current = agentHandler

    try {
      await agentHandler.execute(userInput, { agentContext, selectedSnippets: opts.linkedSnippets })
    } catch (error) {
      console.error('Agent execution error:', error)
    } finally {
      // 清空 ref
      agentHandlerRef.current = null
    }
  }

  // 对话
  async function handleSubmit() {
    const linkedFilesSnapshot = linkedFiles || []
    const linkedSnippetsSnapshot = linkedSnippets || []

    const hasAnyAttachment =
      (linkedFilesSnapshot.length || 0) > 0 ||
      (linkedSnippetsSnapshot.length || 0) > 0 ||
      (inlineImages?.length || 0) > 0

    if (!inputValue.trim() && !hasAnyAttachment) return
    const effectiveInputValue = inputValue.trim() ? inputValue : '[Attachments]'
    onSent?.()

    const serializedLinkedFiles = linkedFilesSnapshot.length
      ? JSON.stringify(linkedFilesSnapshot.map(f => ({ path: f.path, name: f.name, relativePath: f.relativePath })))
      : undefined
    const serializedLinkedSnippets = linkedSnippetsSnapshot.length
      ? JSON.stringify(linkedSnippetsSnapshot.map(s => ({ filePath: s.filePath, snippet: s.snippet })))
      : undefined
    
    // Agent 模式
    if (chatMode === 'agent') {
      setLoading(true)
      await insert({
        role: 'user',
        content: effectiveInputValue,
        type: 'chat',
        inserted: false,
        linkedFiles: serializedLinkedFiles,
        linkedSnippets: serializedLinkedSnippets,
      })
      await handleAgentMode(effectiveInputValue, { linkedFiles: linkedFilesSnapshot, linkedSnippets: linkedSnippetsSnapshot })
      setLoading(false)
      return
    }

    // Chat 模式（原有逻辑）
    setLoading(true)
    await insert({
      role: 'user',
      content: effectiveInputValue,
      type: 'chat',
      inserted: false,
      image: undefined,
      linkedFiles: serializedLinkedFiles,
      linkedSnippets: serializedLinkedSnippets,
    })

    const message = await insert({
      role: 'system',
      content: '',
      type: 'chat',
      inserted: false,
      image: undefined,
      ragSources: undefined,
    })
    if (!message) return
    const lastClearIndex = chats.findLastIndex(item => item.type === 'clear')
    const chatsAfterClear = chats.slice(lastClearIndex + 1)
    
    // 准备请求内容
    let ragContext = ''
    let ragSources: string[] = []
    const attachments = await buildLinkedFileAttachments(linkedFilesSnapshot)
    const inlineImageUrls = (inlineImages || []).map(i => i.dataUrl).filter(Boolean)
    const imageUrls = [...attachments.imageUrls, ...inlineImageUrls]
    const linkedFilesContent = attachments.textContext
    const snippetContext = buildSnippetContext(linkedSnippetsSnapshot)
    
    // 如果启用RAG，获取相关上下文
    if (isRagEnabled) {
      try {
        // 基于TextRank算法提取前3个关键词
        const keywords = await invoke<{text: string, weight: number}[]>('rank_keywords', { text: inputValue, topK: 5 })
        // 获取相关文档内容
        const ragResult = await getContextForQuery(keywords)
        ragContext = ragResult.context
        ragSources = ragResult.sources
        
        if (ragContext) {
          // 如果获取到了相关内容，将其作为独立部分添加到请求中
          ragContext = `
Your knowledge library is the most relevant content related to this question. Please use these information to answer the question:
${ragContext}
`
        }
      } catch (error) {
        console.error('Failed to get RAG context:', error)
      }
    }

    const request_content = `
      ${chatsAfterClear.length ? 'Refer to the following chat records:' : ''}
      ${
        chatsAfterClear
          .filter((item) => item.type === "chat")
          .map((item, index) => `${index + 1}. ${item.content}`)
          .join(';\n\n')
      }
      ${linkedFilesContent.trim()}
      ${snippetContext.trim()}
      ${ragContext.trim()}
      ${effectiveInputValue.trim()}
    `.trim()

    // 先保存空消息，然后通过流式请求更新
    await saveChat({
      ...message,
      content: '',
      ragSources: ragSources.length > 0 ? JSON.stringify(ragSources) : undefined,
    }, true)
    
    // 创建新的 AbortController 用于终止请求
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal
    
    // 准备 MCP 工具（如果有选中的服务器）
    let mcpTools: any[] | undefined
    if (selectedServerIds.length > 0) {
      mcpTools = getOpenAIFunctions(selectedServerIds)
    }
    
    // 使用流式方式获取AI结果（多模态：图片以 content parts 传入）
    let cache_content = '';
    try {
      const userContent: any = imageUrls.length
        ? ([
            { type: 'text', text: request_content },
            ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))
          ])
        : request_content

      await fetchAiStream(userContent, async (content) => {
        cache_content = content
        // 每次收到流式内容时更新消息
        await saveChat({
          ...message,
          content
        }, false)
      }, signal, mcpTools, t, message.id)
    } catch (error: any) {
      // 如果不是中止错误，则记录错误信息
      if (error.name !== 'AbortError') {
        console.error('Stream error:', error)
      }
    } finally {
      abortControllerRef.current = null
      setLoading(false)
      await saveChat({
        ...message,
        content: cache_content,
        ragSources: ragSources.length > 0 ? JSON.stringify(ragSources) : undefined,
      }, true)
    }
  }

  const handleStop = async () => {
    // 停止普通对话的流式输出
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    
    // 停止 Agent 执行
    if (agentHandlerRef.current) {
      agentHandlerRef.current.stop()
      agentHandlerRef.current = null
    }
    
    // 重置 loading 状态
    setLoading(false)
    
    // 保存终止消息
    const lastChat = chats[chats.length - 1]
    if (lastChat && lastChat.role === 'system') {
      // 如果最后一条消息是系统消息，更新为终止消息
      await saveChat({
        ...lastChat,
        content: t('record.chat.input.stopped'),
      }, true)
    }
  }

  const canSend =
    !!primaryModel &&
    (inputValue.trim() ||
      (linkedFiles?.length || 0) > 0 ||
      (linkedSnippets?.length || 0) > 0 ||
      (inlineImages?.length || 0) > 0)

  return (
    <>
      <TooltipButton 
        variant={loading ? "destructive" : "default"}
        size="sm"
        icon={loading ? <Square className="size-4" /> : <Send className="size-4" />} 
        disabled={!loading && !canSend} 
        tooltipText={loading ? t('record.chat.input.stop') : t('record.chat.input.send')} 
        onClick={loading ? handleStop : handleSubmit} 
      />
    </>
  )
})

ChatSend.displayName = 'ChatSend';

async function buildLinkedFileAttachments(linkedFiles?: WorkspaceFile[]): Promise<{
  textContext: string
  imageUrls: string[]
}> {
  if (!linkedFiles || linkedFiles.length === 0) return { textContext: '', imageUrls: [] }

  const fileContents: string[] = []
  const imageUrls: string[] = []
  let totalTextChars = 0

  try {
    const workspace = await getWorkspacePath()

    for (const file of linkedFiles) {
      const ext = (file.name.split('.').pop() || '').toLowerCase()
      const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)

      try {
        if (isImage) {
          const bytes = await readWorkspaceFileBytes(workspace.isCustom, file.path)
          if (!bytes) {
            fileContents.push(`[Image] ${file.relativePath} (无法读取)`)
            continue
          }

          const maxBytes = 4 * 1024 * 1024
          if (bytes.length > maxBytes) {
            fileContents.push(`[Image] ${file.relativePath} (${Math.round(bytes.length / 1024 / 1024)}MB，过大未附加)`)
            continue
          }

          const mime = ext === 'jpg' ? 'image/jpeg'
            : ext === 'jpeg' ? 'image/jpeg'
            : ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
            : ext === 'gif' ? 'image/gif'
            : ext === 'bmp' ? 'image/bmp'
            : ext === 'svg' ? 'image/svg+xml'
            : 'application/octet-stream'

          const base64 = uint8ToBase64(bytes)
          imageUrls.push(`data:${mime};base64,${base64}`)
          fileContents.push(`[Image attached] ${file.relativePath}`)
          continue
        }

        // 文本优先：能读就作为上下文传入（但做 hard cap，避免 @ 多文件导致上下文爆炸；完整内容可用 read_workspace_file 再取）
        const content = await readWorkspaceFileText(workspace.isCustom, file.path)
        if (content) {
          const MAX_PER_FILE_CHARS = 12000
          const MAX_TOTAL_CHARS = 30000

          const remaining = Math.max(0, MAX_TOTAL_CHARS - totalTextChars)
          if (remaining <= 0) {
            fileContents.push(`[Text file omitted] ${file.relativePath} (context budget exceeded; use read_workspace_file)`)
            continue
          }

          const clipped = content.length > MAX_PER_FILE_CHARS
            ? `${content.slice(0, MAX_PER_FILE_CHARS)}\n\n[...truncated ${content.length - MAX_PER_FILE_CHARS} chars...]`
            : content

          const finalContent = clipped.length > remaining
            ? `${clipped.slice(0, remaining)}\n\n[...truncated ${clipped.length - remaining} chars due to total budget...]`
            : clipped

          totalTextChars += finalContent.length
          fileContents.push(`
The following is the content of the linked file "${file.name}" (${file.relativePath}):
${finalContent}
`.trim())
          continue
        }

        // 二进制兜底：附加元信息 + 截断 base64（避免爆 prompt）
        const bytes = await readWorkspaceFileBytes(workspace.isCustom, file.path)
        if (!bytes) {
          fileContents.push(`[Binary file] ${file.relativePath} (无法读取)`)
          continue
        }

        const cap = 128 * 1024
        const capped = bytes.slice(0, Math.min(bytes.length, cap))
        const base64 = uint8ToBase64(capped)
        fileContents.push(`
[Binary file attached (base64, first ${capped.length} bytes / total ${bytes.length} bytes)]
File: ${file.relativePath}
Base64: ${base64}
`.trim())
      } catch (error) {
        console.error('Failed to read linked file:', file, error)
      }
    }

    return { textContext: fileContents.join('\n\n'), imageUrls }
  } catch (error) {
    console.error('Failed to build linked file attachments:', error)
    return { textContext: '', imageUrls: [] }
  }
}

function buildAgentContext(args: {
  activeFilePath: string
  currentArticle: string
  agentMemorySummary: string
  linkedFilesContext: string
  linkedSnippets?: { id: string; filePath: string; snippet: string }[]
  chats: any[]
}): string {
  const parts: string[] = []

  if (args.agentMemorySummary) {
    parts.push(`## Previous Agent Summary\n${args.agentMemorySummary}`)
  }

  if (args.activeFilePath) {
    const content = args.currentArticle || ''
    const excerpt = buildTextExcerpt(content, { head: 3500, tail: 1500 })
    parts.push([
      `## Current Article`,
      `Path: ${args.activeFilePath}`,
      `Length: ${content.length} chars`,
      `Note: For full content, use tool "get_current_article" or "read_workspace_file".`,
      '',
      excerpt,
    ].join('\n'))
  }

  if (args.linkedFilesContext) {
    parts.push(`## Mentioned Files\n${args.linkedFilesContext}`)
  }

  const snippetContext = buildSnippetContext(args.linkedSnippets)
  if (snippetContext) {
    parts.push(snippetContext)
  }

  // 最近对话上下文（避免每次都“新对话”）
  const recent = args.chats
    .filter((c: any) => c?.type === 'chat' && c?.content)
    .slice(-12)
    .map((c: any) => `${c.role === 'user' ? 'User' : 'Assistant'}: ${String(c.content).slice(0, 1000)}`)
    .join('\n')

  if (recent) {
    parts.push(`## Recent Chat\n${recent}`)
  }

  return parts.join('\n\n')
}

function buildSnippetContext(linkedSnippets?: { id: string; filePath: string; snippet: string }[]): string {
  if (!linkedSnippets || linkedSnippets.length === 0) return ''

  const maxSnippetChars = 2000
  const items = linkedSnippets.map((s) => {
    const snippet = (s.snippet || '').trim()
    const clipped = snippet.length > maxSnippetChars
      ? `${snippet.slice(0, maxSnippetChars)}\n\n[...truncated ${snippet.length - maxSnippetChars} chars...]`
      : snippet
    return `### ${s.filePath}\n${clipped}`
  })

  return `## Selected Snippets\n${items.join('\n\n')}`
}

async function readWorkspaceFileText(isCustom: boolean, path: string): Promise<string> {
  try {
    if (isCustom) {
      return await readTextFile(path)
    }
    const { path: p, baseDir } = await getFilePathOptions(path)
    return await readTextFile(p, { baseDir })
  } catch {
    return ''
  }
}

async function readWorkspaceFileBytes(isCustom: boolean, path: string): Promise<Uint8Array | null> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    if (isCustom) {
      return await readFile(path)
    }
    const { path: p, baseDir } = await getFilePathOptions(path)
    return await readFile(p, { baseDir })
  } catch {
    return null
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function shouldUpdateAgentMemory(args: { contextLength: number; toolCallsCount: number; iterations: number; finalAnswerLength: number }) {
  // 触发式：综合“上下文体积 + 工具调用密度 + 迭代次数 + 输出长度”判断是否需要生成记忆摘要
  const MAX_CONTEXT_CHARS = 25000
  const MAX_TOOL_CALLS = 8
  const MAX_ITERATIONS = 8
  const MAX_FINAL_ANSWER_CHARS = 6000

  return (
    args.contextLength >= MAX_CONTEXT_CHARS ||
    args.toolCallsCount >= MAX_TOOL_CALLS ||
    args.iterations >= MAX_ITERATIONS ||
    args.finalAnswerLength >= MAX_FINAL_ANSWER_CHARS
  )
}

function buildTextExcerpt(text: string, opts: { head: number; tail: number }) {
  const head = Math.max(0, Math.floor(opts.head))
  const tail = Math.max(0, Math.floor(opts.tail))
  const t = String(text || '')
  if (t.length === 0) return '(empty)'

  if (t.length <= head + tail + 200) return t

  const headPart = t.slice(0, head)
  const tailPart = t.slice(Math.max(0, t.length - tail))
  return [
    headPart,
    '',
    `[...omitted ${(t.length - headPart.length - tailPart.length)} chars...]`,
    '',
    tailPart,
  ].join('\n')
}

async function generateAgentMemorySummary(args: {
  userRequest: string
  plan: string[]
  toolCalls: any[]
  finalAnswer: string
}): Promise<string> {
  try {
    const aiConfig = await getAISettings()
    if (!aiConfig?.baseURL || !aiConfig?.model) return ''

    const openai = await createOpenAIClient(aiConfig)

    const prompt = [
      '你是对话记忆压缩器。请把一次 Agent 执行压缩成“下次继续工作”所需的最小记忆。',
      '要求：',
      '- 只输出 JSON，对象结构：{ \"memory\": string }',
      '- memory <= 1200 字符，包含：目标/已完成/当前文章相关关键事实/未完成事项（如有）',
      '- 不要包含大段原文，不要包含代码块',
      '',
      `用户请求：${args.userRequest}`,
      args.plan?.length ? `计划：\n${args.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '计划：无',
      `工具调用（简要）：${JSON.stringify(args.toolCalls?.map(c => ({ toolName: c.toolName, status: c.status, error: c.result?.error })) || [])}`,
      `最终输出（截断）：${String(args.finalAnswer || '').slice(0, 6000)}`,
    ].join('\n\n')

    const completion = await openai.chat.completions.create({
      model: aiConfig.model,
      messages: [
        { role: 'system', content: '只输出 JSON 对象，不要输出其他文本。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    })

    const content = completion.choices[0]?.message?.content || ''
    const obj = JSON.parse(content)
    const memory = String(obj?.memory || '').trim()
    return memory.length > 1200 ? memory.slice(0, 1200) : memory
  } catch {
    return ''
  }
}
