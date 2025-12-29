"use client"
import { Send, Square } from "lucide-react"
import useSettingStore from "@/stores/setting"
import useChatStore from "@/stores/chat"
import { fetchAiStream } from "@/lib/ai"
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
import { AgentHandler } from "@/lib/agent/agent-handler"

interface ChatSendProps {
  inputValue: string;
  onSent?: () => void;
  linkedFiles?: WorkspaceFile[];
}

export const ChatSend = forwardRef<{ sendChat: () => void }, ChatSendProps>(({ inputValue, onSent, linkedFiles }, ref) => {
  const { primaryModel } = useSettingStore()
  const { insert, loading, setLoading, saveChat, chats, chatMode, requestAgentConfirmation } = useChatStore()
  const { isRagEnabled } = useVectorStore()
  const { selectedServerIds } = useMcpStore()
  const abortControllerRef = useRef<AbortController | null>(null)
  const agentHandlerRef = useRef<AgentHandler | null>(null)
  const t = useTranslations()

  useImperativeHandle(ref, () => ({
    sendChat: handleSubmit
  }))

  // Agent 模式处理
  async function handleAgentMode() {
    // 先创建一个占位的 AI 消息
    const placeholderMessage = await insert({
      role: 'system',
      content: '',
      type: 'chat',
      inserted: false,
    })

    if (!placeholderMessage) return

    // Agent 上下文：把 @ 引用的文件内容作为 context 传入（避免污染用户输入本身）
    const attachments = await buildLinkedFileAttachments(linkedFiles)
    const agentContext = attachments.textContext

    // 每次都创建新的 AgentHandler，使用当前的 placeholderMessage
    const agentHandler = new AgentHandler({
      requestConfirmation: requestAgentConfirmation,
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
      await agentHandler.execute(inputValue, agentContext || undefined, { imageUrls: attachments.imageUrls })
    } catch (error) {
      console.error('Agent execution error:', error)
    } finally {
      // 清空 ref
      agentHandlerRef.current = null
    }
  }

  // 对话
  async function handleSubmit() {
    if (inputValue === '') return
    onSent?.()
    
    // Agent 模式
    if (chatMode === 'agent') {
      setLoading(true)
      await insert({
        role: 'user',
        content: inputValue,
        type: 'chat',
        inserted: false,
      })
      await handleAgentMode()
      setLoading(false)
      return
    }

    // Chat 模式（原有逻辑）
    setLoading(true)
    await insert({
      role: 'user',
      content: inputValue,
      type: 'chat',
      inserted: false,
      image: undefined,
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
    const attachments = await buildLinkedFileAttachments(linkedFiles)
    const linkedFilesContent = attachments.textContext
    
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
      ${ragContext.trim()}
      ${inputValue.trim()}
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
      const userContent: any = attachments.imageUrls.length
        ? ([
            { type: 'text', text: request_content },
            ...attachments.imageUrls.map(url => ({ type: 'image_url', image_url: { url } }))
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

  return (
    <>
      <TooltipButton 
        variant={loading ? "destructive" : "default"}
        size="sm"
        icon={loading ? <Square className="size-4" /> : <Send className="size-4" />} 
        disabled={!loading && (!primaryModel || !inputValue.trim())} 
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

        // 文本优先：能读就作为上下文传入
        const content = await readWorkspaceFileText(workspace.isCustom, file.path)
        if (content) {
          fileContents.push(`
The following is the content of the linked file "${file.name}" (${file.relativePath}):
${content}
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
