"use client"
import * as React from "react"
import { useEffect, useRef, useState } from "react"
import useSettingStore from "@/stores/setting"
import useChatStore from "@/stores/chat"
import { fetchAiPlaceholder } from "@/lib/ai"
import { useTranslations } from 'next-intl'
import { useLocalStorage } from 'react-use';
import { ModelSelect } from "./model-select"
import { PromptSelect } from "./prompt-select"
import { ChatLanguage } from "./chat-language"
import { ChatSend } from "./chat-send"
import { FileLink } from "./file-link"
import { FileSelector } from "./file-selector"
import { McpButton } from "./mcp-button"
import { RagSwitch } from "./rag-switch"
import ChatPlaceholder from "./chat-placeholder"
import { ClearContext } from "./clear-context"
import { ClearChat } from "./clear-chat"
import { ChatModeSelect } from "./chat-mode-select"
import { WorkspaceFile } from "@/lib/files"
import emitter from "@/lib/emitter"
import { useIsMobile } from '@/hooks/use-mobile'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'


export function ChatInput() {
  const [text, setText] = useState("")
  const { primaryModel, chatToolbarConfigPc, setChatToolbarConfigPc, chatToolbarConfigMobile } = useSettingStore()
  const { chats, loading, isPlaceholderEnabled } = useChatStore()
  const [showFileSelector, setShowFileSelector] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [placeholder, setPlaceholder] = useState('')
  const t = useTranslations()
  const [inputHistory, setInputHistory] = useLocalStorage<string[]>('chat-input-history', [])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [linkedFiles, setLinkedFiles] = useState<WorkspaceFile[]>([])
  const chatSendRef = useRef<any>(null)
  const isMobile = useIsMobile()
  const editorRef = useRef<HTMLDivElement | null>(null)
  const selectionRangeRef = useRef<Range | null>(null)
  const pendingAtCleanupRef = useRef(false)
  const atInsertRangeRef = useRef<Range | null>(null)
  const mentionOpeningRef = useRef(false)

  // 拖拽传感器配置（仅桌面端）
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 移动8px后才开始拖拽，避免误触
      },
    })
  )


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
    if (editorRef.current) {
      editorRef.current.innerHTML = ''
    }
  }

  // 获取输入框占位符
  async function genInputPlaceholder() {
    setPlaceholder(t('record.chat.input.placeholder.default'))
    if (!primaryModel) return
    // 检查是否启用了AI占位符功能
    if (!isPlaceholderEnabled) {
      setPlaceholder(t('record.chat.input.placeholder.default'))
      return
    }
    const lastClearIndex = chats.findLastIndex(item => item.type === 'clear')
    const chatsAfterClear = chats.slice(lastClearIndex + 1)
    const request_content = `
      ${chatsAfterClear
        .slice(0, 5)
        .map(item => item.content?.replace(/<thinking>[\s\S]*?<thinking>/g, '').slice(0, 60))
        .join(';\n\n')}
    `.trim()
    // 使用非流式请求获取placeholder内容
    const content = await fetchAiPlaceholder(request_content)
    if (content) {
      setPlaceholder(content + ' [Tab]')
    }
  }


  // 插入占位符
  function insertPlaceholder() {
    if (placeholder.includes('[Tab]')) {
      setContentText(placeholder.replace('[Tab]', ''))
      setPlaceholder('')
    }
  }

  // 处理拖拽结束（仅 PC 端底部工具栏）
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const bottomTools = ['modelSelect', 'promptSelect', 'chatLanguage']
      const bottomItems = chatToolbarConfigPc.filter(item => bottomTools.includes(item.id))
      const oldIndex = bottomItems.findIndex((item) => item.id === active.id)
      const newIndex = bottomItems.findIndex((item) => item.id === over.id)
      
      const reorderedItems = arrayMove(bottomItems, oldIndex, newIndex)
      const allItems = [...chatToolbarConfigPc]
      
      reorderedItems.forEach((item, index) => {
        const globalIndex = allItems.findIndex(i => i.id === item.id)
        if (globalIndex !== -1) {
          allItems[globalIndex] = { ...item, order: bottomItems[0].order + index }
        }
      })
      
      setChatToolbarConfigPc(allItems)
    }
  }

  useEffect(() => {
    if (!primaryModel) {
      setPlaceholder(t('record.chat.input.placeholder.noPrimaryModel'))
      return
    }
    if (!isPlaceholderEnabled) {
      setPlaceholder(t('record.chat.input.placeholder.default'))
      return
    }
    genInputPlaceholder()
  }, [primaryModel, chats, isPlaceholderEnabled, t])

  useEffect(() => {
    if (!isPlaceholderEnabled) {
      setPlaceholder(t('record.chat.input.placeholder.default'))
    }
  }, [placeholder, isPlaceholderEnabled])

  useEffect(() => {
    emitter.on('revertChat', (event: unknown) => {
      setContentText(event as string)
    })
    emitter.on('fileSelected', (event: unknown) => {
      addLinkedFileAndInsert(event as WorkspaceFile)
    })
    return () => {
      emitter.off('revertChat')
      emitter.off('fileSelected')
    }
  }, [])

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

  function insertFileMention(file: WorkspaceFile) {
    const el = editorRef.current
    if (!el) return

    const span = document.createElement('span')
    span.setAttribute('data-mention', 'file')
    span.setAttribute('data-path', file.path)
    span.setAttribute('data-relative-path', file.relativePath || '')
    span.setAttribute('data-name', file.name || '')
    span.contentEditable = 'false'
    span.className = 'chat-file-mention'
    span.textContent = `@${file.name}`

    const range = selectionRangeRef.current || window.getSelection()?.getRangeAt(0) || null
    if (range) {
      range.deleteContents()
      range.insertNode(document.createTextNode(' '))
      range.insertNode(span)
      range.collapse(false)
      const selection = window.getSelection()
      if (selection) {
        selection.removeAllRanges()
        selection.addRange(range)
      }
    } else {
      el.appendChild(span)
      el.appendChild(document.createTextNode(' '))
    }

    updateTextFromDom()
  }

  function removeAtBeforeCaretIfAny() {
    const el = editorRef.current
    if (!el) return

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    const container = range.startContainer
    const offset = range.startOffset

    // 仅处理文本节点：删除光标前一个字符是 @ 的情况
    if (container.nodeType === Node.TEXT_NODE) {
      const textNode = container as Text
      const text = textNode.data || ''
      if (offset > 0 && text[offset - 1] === '@') {
        textNode.deleteData(offset - 1, 1)
        // 重置光标位置
        const nextRange = document.createRange()
        nextRange.setStart(textNode, offset - 1)
        nextRange.collapse(true)
        selection.removeAllRanges()
        selection.addRange(nextRange)
        selectionRangeRef.current = nextRange.cloneRange()
        updateTextFromDom()
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
      if (!textNode.data?.includes('@')) continue
      textNode.data = textNode.data.replace(/@/g, '')
    }
  }

  function scheduleAtCleanup() {
    pendingAtCleanupRef.current = true

    const cleanup = () => {
      if (!pendingAtCleanupRef.current) return
      pendingAtCleanupRef.current = false

      // 1) 精准删除：尝试删除“刚插入”的 @（基于触发时的 range）
      const atRange = atInsertRangeRef.current
      if (atRange) {
        try {
          const container = atRange.startContainer
          const offset = atRange.startOffset

          // A) @ 被插入到同一个 Text 节点里
          if (container.nodeType === Node.TEXT_NODE) {
            const textNode = container as Text
            const text = textNode.data || ''
            if (offset < text.length && text[offset] === '@') {
              textNode.deleteData(offset, 1)
            }
          } else if (container.nodeType === Node.ELEMENT_NODE) {
            // B) @ 作为独立 Text 节点插入到元素子节点位置
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

      // 2) 兜底删除：光标前一个字符是 @
      removeAtBeforeCaretIfAny()

      // 3) 兜底删除：末尾多出来一个 @
      const el = editorRef.current
      if (el) {
        // 只要是 “打开 mention 的那一下” 产生的 @，这里一律清理（@ 作为保留字符）
        sanitizeStrayAtCharacters()

        const text = el.innerText || ''
        if (text.endsWith('@')) {
          el.innerText = text.slice(0, -1)
          const selection = window.getSelection()
          if (selection) {
            const range = document.createRange()
            range.selectNodeContents(el)
            range.collapse(false)
            selection.removeAllRanges()
            selection.addRange(range)
            selectionRangeRef.current = range.cloneRange()
          }
        }
        updateTextFromDom()
      }
    }

    // 某些输入法会在 keydown 之后才触发插入，因此做两次：microtask + 下一帧
    queueMicrotask(cleanup)
    requestAnimationFrame(cleanup)
  }

  function addLinkedFileAndInsert(file: WorkspaceFile) {
    addLinkedFile(file)
    insertFileMention(file)
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
        if (element.dataset.mention === 'file') {
          // mention 不污染输入：不把 @file 写进发送给 AI 的文本，只作为 UI 标记
          parts.push('')
          return
        }
        parts.push(element.textContent || '')
      }
    })

    setText(parts.join('').replace(/\u00A0/g, ' '))
  }

  function setContentText(next: string) {
    setText(next)
    const el = editorRef.current
    if (el) {
      el.innerText = next
    }
  }

  return (
    <footer className="flex flex-col w-full p-1 justify-between items-center">
      <div className="group relative flex flex-col border rounded-xl z-10 gap-2 p-1 w-full bg-background focus-within:border-primary transition-colors">
        <div className="relative w-full flex items-start px-2 pt-2">
          <div
            ref={editorRef}
            className="chat-input-ce flex-1 text-xs md:text-sm outline-none min-h-[72px] max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words"
            contentEditable={!loading && !!primaryModel}
            suppressContentEditableWarning
            data-placeholder={placeholder}
            data-empty={text.trim() === '' && linkedFiles.length === 0 ? 'true' : 'false'}
            onBeforeInput={(e) => {
              if (loading || !primaryModel) return
              const native = e.nativeEvent as unknown as InputEvent
              if (native?.inputType === 'insertText' && native.data === '@') {
                e.preventDefault()
                mentionOpeningRef.current = true
                // 保留当前光标位置
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
              // 如果正在打开 @mention，确保 stray @ 不污染 inputValue
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

              // 某些键盘布局/输入法下，@ 可能表现为 Shift+2（e.key='2', e.code='Digit2'）
              const isAt =
                e.key === '@' ||
                (e.shiftKey && (e.key === '2' || e.code === 'Digit2'))

              if (isAt) {
                e.preventDefault()
                mentionOpeningRef.current = true
                // 记录 @ 将要插入的位置（用于后续精准删除）
                const selection = window.getSelection()
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

              if (e.key === "Tab") {
                e.preventDefault()
                insertPlaceholder()
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
        
        <div className="flex justify-between items-center w-full">
          <div className="relative flex-1 overflow-x-auto mr-6 px-2 -translate-x-2">
            {/* 左侧渐变遮罩 */}
            <div className="absolute left-0 top-0 bottom-0 w-4 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none md:hidden" />
            
            {/* 右侧渐变遮罩 */}
            <div className="absolute right-0 top-0 bottom-0 w-4 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none md:hidden" />
            
            {/* 可拖拽排序的按钮容器（桌面端）或普通容器（移动端） */}
            {!isMobile ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={chatToolbarConfigPc.filter(item => ['modelSelect', 'promptSelect', 'chatLanguage'].includes(item.id) && item.enabled).map(item => item.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  <div className="flex overflow-x-auto scrollbar-hide md:overflow-visible">
                    {chatToolbarConfigPc
                      .filter(item => ['modelSelect', 'promptSelect', 'chatLanguage'].includes(item.id) && item.enabled)
                      .sort((a, b) => a.order - b.order)
                      .map(item => (
                        <SortableToolbarItem
                          key={item.id}
                          id={item.id}
                        />
                      ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="flex overflow-x-auto scrollbar-hide md:overflow-visible gap-1">
                {chatToolbarConfigMobile
                  .filter(item => item.enabled)
                  .sort((a, b) => a.order - b.order)
                  .map(item => {
                    switch (item.id) {
                      case 'modelSelect':
                        return <ModelSelect key={item.id} />
                      case 'promptSelect':
                        return <PromptSelect key={item.id} />
                      case 'chatLanguage':
                        return <ChatLanguage key={item.id} />
                      case 'fileLink':
                        return <FileLink key={item.id} onFileLinkClick={() => setShowFileSelector(true)} disabled={!primaryModel || loading} />
                      case 'mcpButton':
                        return <McpButton key={item.id} />
                      case 'ragSwitch':
                        return <RagSwitch key={item.id} />
                      case 'chatPlaceholder':
                        return <ChatPlaceholder key={item.id} />
                      case 'clearContext':
                        return <ClearContext key={item.id} />
                      case 'clearChat':
                        return <ClearChat key={item.id} />
                      default:
                        return null
                    }
                  })}
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 pr-1">
            <ChatModeSelect />
            <ChatSend inputValue={text} onSent={handleSent} linkedFiles={linkedFiles} ref={chatSendRef} />
          </div>
        </div>

        {/* 文件选择器（移动端） */}
        {showFileSelector && (
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
        )}
      </div>
    </footer>
  )
}

// 可排序的工具栏项组件
interface SortableToolbarItemProps {
  id: string
}

function SortableToolbarItem({ id }: SortableToolbarItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // 渲染对应的工具栏组件
  const renderToolbarItem = () => {
    switch (id) {
      case 'modelSelect':
        return <ModelSelect />
      case 'promptSelect':
        return <PromptSelect />
      case 'chatLanguage':
        return <ChatLanguage />
      default:
        return null
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="cursor-grab active:cursor-grabbing"
    >
      {renderToolbarItem()}
    </div>
  )
}
