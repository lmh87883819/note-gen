"use client"
import * as React from "react"
import { useEffect, useRef, useState } from "react"
import useSettingStore from "@/stores/setting"
import useChatStore from "@/stores/chat"
import { useTranslations } from 'next-intl'
import { useLocalStorage } from 'react-use';
import { ModelSelect } from "./model-select"
import { ChatSend } from "./chat-send"
import { McpButton } from "./mcp-button"
import { RagSwitch } from "./rag-switch"
import { TooltipButton } from "@/components/tooltip-button"
import { ClearContext } from "./clear-context"
import { ClearChat } from "./clear-chat"
import { ChatModeSelect } from "./chat-mode-select"
import { FileSelector } from "./file-selector"
import { WorkspaceFile } from "@/lib/files"
import emitter from "@/lib/emitter"
import { useIsMobile } from '@/hooks/use-mobile'
import { Brain, Globe, X } from "lucide-react"

type SnippetRef = {
  id: string
  filePath: string
  snippet: string
}

type InlineImageAttachment = {
  id: string
  name: string
  size: number
  type: string
  dataUrl: string
}


export function ChatInput() {
  const [text, setText] = useState("")
  const { primaryModel, chatToolbarConfigMobile } = useSettingStore()
  const { chats, loading } = useChatStore()
  const [isComposing, setIsComposing] = useState(false)
  const [placeholder, setPlaceholder] = useState('')
  const t = useTranslations()
  const [inputHistory, setInputHistory] = useLocalStorage<string[]>('chat-input-history', [])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [linkedFiles, setLinkedFiles] = useState<WorkspaceFile[]>([])
  const [linkedSnippets, setLinkedSnippets] = useState<SnippetRef[]>([])
  const [inlineImages, setInlineImages] = useState<InlineImageAttachment[]>([])
  const [showFileSelector, setShowFileSelector] = useState(false)
  const [enableSearch, setEnableSearch] = useLocalStorage<boolean>('agent-enable-search', false)
  const [thinkingMode, setThinkingMode] = useLocalStorage<boolean>('agent-thinking-mode', false)
  const chatSendRef = useRef<any>(null)
  const isMobile = useIsMobile()
  const editorRef = useRef<HTMLDivElement | null>(null)
  const selectionRangeRef = useRef<Range | null>(null)
  const pendingAtCleanupRef = useRef(false)
  const atInsertRangeRef = useRef<Range | null>(null)
  const mentionOpeningRef = useRef(false)


  // 添加输入到历史记录
  function addToHistory(input: string) {
    if (!input.trim()) return
    
    const newHistory = [input, ...(inputHistory || []).filter(item => item !== input)]
    // 限制历史记录数量为50条
    const limitedHistory = newHistory.slice(0, 50)
    setInputHistory(limitedHistory)
  }

  // 处理历史记录导航
  function navigateHistory(direction: 'up' | 'down') {
    if (!inputHistory || inputHistory.length === 0) return

    let newIndex: number
    if (direction === 'up') {
      newIndex = historyIndex + 1
      if (newIndex >= inputHistory.length) {
        newIndex = inputHistory.length - 1
      }
    } else {
      newIndex = historyIndex - 1
      if (newIndex < -1) {
        newIndex = -1
      }
    }

    setHistoryIndex(newIndex)
    
    if (newIndex === -1) {
      setText('')
    } else {
      setText(inputHistory[newIndex])
    }
  }

  // 处理发送后的清理工作
  function handleSent() {
    // 添加到历史记录
    addToHistory(text)
    setText('')
    setHistoryIndex(-1)
    setLinkedFiles([])
    setLinkedSnippets([])
    setInlineImages([])
    if (editorRef.current) {
      editorRef.current.innerHTML = ''
    }
  }

  useEffect(() => {
    if (!primaryModel) {
      setPlaceholder(t('record.chat.input.placeholder.noPrimaryModel'))
      return
    }
    setPlaceholder(t('record.chat.input.placeholder.default'))
  }, [primaryModel, chats, t])

  useEffect(() => {
    emitter.on('revertChat', (event: unknown) => {
      setContentText(event as string)
    })
    emitter.on('chat-add-snippet', (event: unknown) => {
      const payload = event as { filePath?: string; snippet?: string }
      if (!payload?.filePath || !payload?.snippet?.trim()) return
      addSnippetAndInsert({ filePath: payload.filePath, snippet: payload.snippet })
    })
    emitter.on('chat-prefill-draft', (event: unknown) => {
      const payload = event as {
        mode?: 'replace' | 'append'
        text?: string
        focus?: boolean
        snippet?: { filePath: string; snippet: string }
      }

      const mode = payload?.mode || 'replace'
      const nextText = String(payload?.text || '')

      if (mode === 'replace') {
        setText('')
        setHistoryIndex(-1)
        setLinkedFiles([])
        setLinkedSnippets([])
        setInlineImages([])
        if (editorRef.current) {
          editorRef.current.innerHTML = ''
        }
        selectionRangeRef.current = null
      }

      if (payload?.snippet?.filePath && payload?.snippet?.snippet?.trim()) {
        addSnippetAndInsert({ filePath: payload.snippet.filePath, snippet: payload.snippet.snippet })
      }

      if (nextText.trim()) {
        const el = editorRef.current
        if (el) {
          el.focus()
          const range = getSafeInsertRange(el)
          range.collapse(false)
          const textNode = document.createTextNode((payload?.snippet ? '\n' : '') + nextText)
          range.insertNode(textNode)
          range.collapse(false)
          const selection = window.getSelection()
          if (selection) {
            selection.removeAllRanges()
            selection.addRange(range)
          }
          selectionRangeRef.current = range.cloneRange()
          updateTextFromDom()
        } else {
          setText(nextText)
        }
      }

      if (payload?.focus !== false) {
        editorRef.current?.focus()
      }
    })
    return () => {
      emitter.off('revertChat')
      emitter.off('chat-add-snippet')
      emitter.off('chat-prefill-draft')
    }
  }, [])

  function createId() {
    try {
      return crypto.randomUUID()
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`
    }
  }

  function normalizeFilePathForMention(file: WorkspaceFile) {
    return file.relativePath || file.name || file.path
  }

  function addLinkedFile(file: WorkspaceFile) {
    const key = normalizeFilePathForMention(file)
    setLinkedFiles((prev) => {
      if (prev.some(f => normalizeFilePathForMention(f) === key)) return prev
      return [...prev, file]
    })
  }

  function addSnippet(snippet: Omit<SnippetRef, 'id'>) {
    const id = createId()
    const next: SnippetRef = { id, ...snippet }
    setLinkedSnippets((prev) => [...prev, next])
    return next
  }

  function getSafeInsertRange(el: HTMLDivElement): Range {
    const r = selectionRangeRef.current
    if (r && el.contains(r.startContainer)) {
      return r.cloneRange()
    }

    const next = document.createRange()
    next.selectNodeContents(el)
    next.collapse(false)
    return next
  }

  function insertSnippetMention(snippet: SnippetRef) {
    const el = editorRef.current
    if (!el) return
    el.focus()

    const span = document.createElement('span')
    span.setAttribute('data-mention', 'snippet')
    span.setAttribute('data-id', snippet.id)
    span.setAttribute('data-path', snippet.filePath)
    span.contentEditable = 'false'
    span.className = 'chat-file-mention chat-snippet-mention'
    const name = (snippet.filePath.split('/').pop() || snippet.filePath).trim()
    span.textContent = `@选区:${name}`

    const range = getSafeInsertRange(el)
    range.deleteContents()
    range.insertNode(document.createTextNode(' '))
    range.insertNode(span)
    range.collapse(false)
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    selectionRangeRef.current = range.cloneRange()

    updateTextFromDom()
  }

  function addSnippetAndInsert(snippet: Omit<SnippetRef, 'id'>) {
    const created = addSnippet(snippet)
    insertSnippetMention(created)
  }

  function insertFileMention(file: WorkspaceFile) {
    const el = editorRef.current
    if (!el) return
    el.focus()

    const span = document.createElement('span')
    span.setAttribute('data-mention', 'file')
    span.setAttribute('data-path', file.path)
    span.setAttribute('data-relative-path', file.relativePath || '')
    span.setAttribute('data-name', file.name || '')
    span.contentEditable = 'false'
    span.className = 'chat-file-mention'
    span.textContent = `@${file.name}`

    const range = getSafeInsertRange(el)
    range.deleteContents()
    range.insertNode(document.createTextNode(' '))
    range.insertNode(span)
    range.collapse(false)
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    selectionRangeRef.current = range.cloneRange()

    updateTextFromDom()
  }

  function addLinkedFileAndInsert(file: WorkspaceFile) {
    addLinkedFile(file)
    insertFileMention(file)
  }

  function removeAtBeforeCaretIfAny() {
    const el = editorRef.current
    if (!el) return

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    const container = range.startContainer
    const offset = range.startOffset

    if (container.nodeType === Node.TEXT_NODE) {
      const textNode = container as Text
      const text = textNode.data || ''
      if (offset > 0 && text[offset - 1] === '@') {
        textNode.deleteData(offset - 1, 1)
        const nextRange = document.createRange()
        nextRange.setStart(textNode, Math.max(0, offset - 1))
        nextRange.collapse(true)
        selection.removeAllRanges()
        selection.addRange(nextRange)
        selectionRangeRef.current = nextRange.cloneRange()
      }
    }
  }

  function sanitizeStrayAtCharacters() {
    const el = editorRef.current
    if (!el) return

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let node: Node | null
    while ((node = walker.nextNode())) {
      textNodes.push(node as Text)
    }

    for (const textNode of textNodes) {
      const parent = textNode.parentElement
      if (parent?.dataset?.mention === 'file' || parent?.dataset?.mention === 'snippet') {
        continue
      }
      if (!textNode.data?.includes('@')) continue
      textNode.data = textNode.data.replace(/@/g, '')
    }
  }

  function scheduleAtCleanup() {
    pendingAtCleanupRef.current = true

    const cleanup = () => {
      if (!pendingAtCleanupRef.current) return
      pendingAtCleanupRef.current = false

      const atRange = atInsertRangeRef.current
      if (atRange) {
        try {
          const container = atRange.startContainer
          const offset = atRange.startOffset

          if (container.nodeType === Node.TEXT_NODE) {
            const textNode = container as Text
            const text = textNode.data || ''
            if (offset < text.length && text[offset] === '@') {
              textNode.deleteData(offset, 1)
            }
          } else if (container.nodeType === Node.ELEMENT_NODE) {
            const element = container as Element
            const nodeAtOffset = element.childNodes[offset]
            if (nodeAtOffset && nodeAtOffset.nodeType === Node.TEXT_NODE) {
              const textNode = nodeAtOffset as Text
              if ((textNode.data || '').startsWith('@')) {
                textNode.deleteData(0, 1)
              }
            }
          }
        } catch {
          // ignore
        }
      }

      removeAtBeforeCaretIfAny()
      sanitizeStrayAtCharacters()
      updateTextFromDom()
    }

    queueMicrotask(cleanup)
    requestAnimationFrame(cleanup)
  }

  function updateTextFromDom() {
    const el = editorRef.current
    if (!el) return
    const parts: string[] = []

    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent || '')
        return
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as HTMLElement
        if (element.dataset.mention === 'file' || element.dataset.mention === 'snippet') {
          // mention 不污染输入：不把 @file 写进发送给 AI 的文本，只作为 UI 标记
          parts.push('')
          return
        }
        parts.push(element.textContent || '')
      }
    })

    setText(parts.join('').replace(/\u00A0/g, ' '))

    const fileMentions = Array.from(el.querySelectorAll('span[data-mention="file"]')) as HTMLSpanElement[]
    const nextFiles: WorkspaceFile[] = []
    const seen = new Set<string>()
    for (const span of fileMentions) {
      const path = span.dataset.path || ''
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      nextFiles.push({
        path,
        name: span.dataset.name || (path.split('/').pop() || path),
        relativePath: span.dataset.relativePath || '',
      } as WorkspaceFile)
    }
    setLinkedFiles(nextFiles)

    const snippetMentions = Array.from(el.querySelectorAll('span[data-mention="snippet"]')) as HTMLSpanElement[]
    const activeIds = new Set(snippetMentions.map(s => s.dataset.id).filter(Boolean) as string[])
    setLinkedSnippets((prev) => prev.filter(s => activeIds.has(s.id)))
  }

  function setContentText(next: string) {
    setText(next)
    const el = editorRef.current
    if (el) {
      el.innerText = next
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()

    const files = Array.from(e.dataTransfer?.files || [])
    if (files.length === 0) return

    const nextImages: InlineImageAttachment[] = []
    for (const file of files) {
      if (!file.type?.startsWith('image/')) continue
      const maxBytes = 4 * 1024 * 1024
      if (file.size > maxBytes) continue

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('Failed to read image'))
        reader.readAsDataURL(file)
      }).catch(() => '')

      if (!dataUrl) continue

      nextImages.push({
        id: createId(),
        name: file.name,
        size: file.size,
        type: file.type,
        dataUrl,
      })
    }

    if (nextImages.length) {
      setInlineImages((prev) => [...prev, ...nextImages].slice(0, 8))
    }
  }

  return (
    <footer className="flex flex-col w-full p-1 justify-between items-center">
      <div className="group relative flex flex-col border rounded-xl z-10 gap-2 p-1 w-full bg-background focus-within:border-primary transition-colors">
        <div className="relative w-full flex items-start px-2 pt-2">
          <div
            ref={editorRef}
            className="chat-input-ce flex-1 text-xs md:text-sm outline-none min-h-[96px] max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words"
            contentEditable={!loading && !!primaryModel}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-empty={text.trim() === '' && linkedFiles.length === 0 && linkedSnippets.length === 0 && inlineImages.length === 0 ? 'true' : 'false'}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes?.('Files')) {
                e.preventDefault()
              }
            }}
            onDrop={handleDrop}
            onBeforeInput={(e) => {
              if (loading || !primaryModel) return
              const native = e.nativeEvent as unknown as InputEvent
              if (native?.inputType === 'insertText' && native.data === '@') {
                e.preventDefault()
                mentionOpeningRef.current = true
                const selection = window.getSelection()
                if (selection && selection.rangeCount > 0) {
                  selectionRangeRef.current = selection.getRangeAt(0).cloneRange()
                  atInsertRangeRef.current = selection.getRangeAt(0).cloneRange()
                }
                scheduleAtCleanup()
                setShowFileSelector(true)
              }
            }}
            onInput={() => {
              if (mentionOpeningRef.current) {
                sanitizeStrayAtCharacters()
              }
              updateTextFromDom()
            }}
            onKeyDown={(e) => {
              // 保存光标位置（用于 @ 文件选择器后插入）
              const selection = window.getSelection()
              if (selection && selection.rangeCount > 0) {
                selectionRangeRef.current = selection.getRangeAt(0).cloneRange()
              }

              const isAt =
                e.key === '@' ||
                (e.shiftKey && (e.key === '2' || e.code === 'Digit2'))
              if (isAt) {
                e.preventDefault()
                mentionOpeningRef.current = true
                if (selection && selection.rangeCount > 0) {
                  atInsertRangeRef.current = selection.getRangeAt(0).cloneRange()
                }
                scheduleAtCleanup()
                setShowFileSelector(true)
                return
              }

              if (e.key === "Enter" && !isComposing && !e.shiftKey) {
                e.preventDefault()
                chatSendRef.current?.sendChat()
                return
              }

              if (e.key === "ArrowUp" && !isComposing) {
                e.preventDefault()
                navigateHistory('up')
                return
              }

              if (e.key === "ArrowDown" && !isComposing) {
                e.preventDefault()
                navigateHistory('down')
                return
              }
            }}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setTimeout(() => setIsComposing(false), 0)}
            onFocus={() => {
              const selection = window.getSelection()
              if (selection && selection.rangeCount > 0) {
                selectionRangeRef.current = selection.getRangeAt(0).cloneRange()
              }
            }}
            onBlur={() => {
              const selection = window.getSelection()
              if (selection && selection.rangeCount > 0) {
                selectionRangeRef.current = selection.getRangeAt(0).cloneRange()
              }
            }}
          />
        </div>
        
        {inlineImages.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pb-1">
            {inlineImages.map((img) => (
              <div key={img.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs bg-background">
                <span className="truncate max-w-[220px]">{img.name}</span>
                <button
                  type="button"
                  className="opacity-70 hover:opacity-100"
                  onClick={() => setInlineImages(prev => prev.filter(p => p.id !== img.id))}
                  aria-label="Remove image"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-between items-center w-full">
          <div className="relative flex-1 overflow-x-auto mr-6 px-2 -translate-x-2">
            {/* 左侧渐变遮罩 */}
            <div className="absolute left-0 top-0 bottom-0 w-4 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none md:hidden" />
            
            {/* 右侧渐变遮罩 */}
            <div className="absolute right-0 top-0 bottom-0 w-4 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none md:hidden" />
            
            <div className="flex overflow-x-auto scrollbar-hide md:overflow-visible gap-1">
              <ModelSelect />
              <TooltipButton
                variant="ghost"
                size="icon"
                icon={<Globe className={enableSearch ? 'text-blue-500' : ''} />}
                tooltipText={enableSearch ? '联网搜索：已开启' : '联网搜索：已关闭'}
                side="bottom"
                onClick={() => setEnableSearch(!enableSearch)}
              />
              <TooltipButton
                variant="ghost"
                size="icon"
                icon={<Brain className={thinkingMode ? 'text-purple-500' : ''} />}
                tooltipText={thinkingMode ? '思考模式：已开启' : '思考模式：已关闭'}
                side="bottom"
                onClick={() => setThinkingMode(!thinkingMode)}
              />
              {isMobile &&
                chatToolbarConfigMobile
                  .filter(item => item.enabled)
                  .sort((a, b) => a.order - b.order)
                  .map(item => {
                    switch (item.id) {
                      case 'mcpButton':
                        return <McpButton key={item.id} />
                      case 'ragSwitch':
                        return <RagSwitch key={item.id} />
                      case 'clearContext':
                        return <ClearContext key={item.id} />
                      case 'clearChat':
                        return <ClearChat key={item.id} />
                      default:
                        return null
                    }
                  })}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pr-1">
            <ChatModeSelect />
            <ChatSend
              inputValue={text}
              onSent={handleSent}
              linkedFiles={linkedFiles}
              linkedSnippets={linkedSnippets}
              inlineImages={inlineImages}
              enableSearch={Boolean(enableSearch)}
              thinkingMode={Boolean(thinkingMode)}
              ref={chatSendRef}
            />
          </div>
        </div>

        <FileSelector
          isOpen={showFileSelector}
          onClose={() => {
            mentionOpeningRef.current = false
            setShowFileSelector(false)
          }}
          onFileSelect={(file) => {
            addLinkedFileAndInsert(file)
            mentionOpeningRef.current = false
            setShowFileSelector(false)
          }}
        />
      </div>
    </footer>
  )
}
