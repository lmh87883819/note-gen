'use client'
import useArticleStore from '@/stores/article'
import { useEffect, useState, useRef } from 'react'
import Vditor from 'vditor'
import { exists, mkdir, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import "vditor/dist/index.css"
import CustomToolbar from './custom-toolbar'
import './style.scss'
import { useTheme } from 'next-themes'
import { toast } from '@/hooks/use-toast'
import { Store } from '@tauri-apps/plugin-store'
import { useTranslations } from 'next-intl'
import { useI18n } from '@/hooks/useI18n'
import emitter from '@/lib/emitter'
import { appDataDir } from '@tauri-apps/api/path'
import { v4 as uuid } from 'uuid'
import { convertImage } from '@/lib/utils'
import CustomFooter from './custom-footer'
import { useLocalStorage } from 'react-use'
import { open } from '@tauri-apps/plugin-shell'
import { getWorkspacePath } from '@/lib/workspace'
import { convertFileSrc } from "@tauri-apps/api/core";
import useSettingStore from '@/stores/setting'
import useChatStore from '@/stores/chat'
import { uploadImage } from '@/lib/imageHosting'
import FloatBar from './floatbar'
import { createToolbarConfig } from './toolbar.config'

export function MdEditor() {
  const [editor, setEditor] = useState<Vditor>();
  const editorRef = useRef<Vditor | null>(null)
  const { currentArticle, saveCurrentArticle, loading, activeFilePath, matchPosition, setMatchPosition, setActiveFilePath, loadFileTree, setCurrentArticle } = useArticleStore()
  const { assetsPath, contentTextScale } = useSettingStore()
  const [floatBarPosition, setFloatBarPosition] = useState<{left: number, top: number} | null>(null)
  const [selectedText, setSelectedText] = useState<string>('')
  const [editorWidth, setEditorWidth] = useState<number>(0)
  const { theme } = useTheme()
  const t = useTranslations('article.editor')
  const { currentLocale } = useI18n()
  const [localMode, setLocalMode] = useLocalStorage<'ir' | 'sv' | 'wysiwyg'>('useLocalMode', 'ir')
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const isCreatingFileRef = useRef(false)
  const activeFilePathRef = useRef(activeFilePath)
  const isReinitializingRef = useRef(false)
  const pendingConfirmation = useChatStore(s => s.agentState.pendingConfirmation)
  const highlightUiRef = useRef<{
    pre: HTMLElement | null
    wrapper: HTMLElement | null
    layer: HTMLDivElement | null
    inner: HTMLDivElement | null
    cleanup: (() => void) | null
  }>({ pre: null, wrapper: null, layer: null, inner: null, cleanup: null })
  const highlightTimeoutRef = useRef<number | null>(null)
  const lastSelectionRangeRef = useRef<Range | null>(null)
  const aiPendingNeedleRef = useRef<string | null>(null)
  const aiAppliedNeedleRef = useRef<string | null>(null)

  function getLang() {
    switch (currentLocale) {
      case 'en':
        return 'en_US'
      case 'zh':
        return 'zh_CN'
      default:
        return 'zh_CN'
    }
  }

  async function init() {
    const store = await Store.load('store.json');
    const typewriterMode = await store.get<boolean>('typewriterMode') || false
    const outlinePosition = await store.get<'left' | 'right'>('outlinePosition') || 'left'
    const enableOutline = await store.get<boolean>('enableOutline') || false
    const enableLineNumber = await store.get<boolean>('enableLineNumber') || false
    const editorElement = document.getElementById('aritcle-md-editor')
    const currentWidth = editorElement?.clientWidth || 0
    const toolbarConfig = createToolbarConfig(t, currentWidth)

    const vditor = new Vditor('aritcle-md-editor', {
      lang: getLang(),
      height: '100%',
      icon: 'material',
      cdn: '',
      tab: '\t',
      theme: theme === 'dark' ? 'dark' : 'classic',
      toolbar: toolbarConfig,
      typewriterMode,
      customWysiwygToolbar: (type: TWYSISYGToolbar, element: HTMLElement) => {
        console.log(type, element)
      },
      outline: {
        enable: enableOutline,
        position: outlinePosition,
      },
      select: (value: string) => {
        setSelectedText(value)
        setFloatBarPosition(vditor.getCursorPosition())
        try {
          const ctx = getEditorDomContext(vditor)
          const sel = window.getSelection()
          if (ctx && sel && sel.rangeCount > 0) {
            const r = sel.getRangeAt(0)
            if (!r.collapsed && ctx.pre.contains(r.commonAncestorContainer)) {
              lastSelectionRangeRef.current = r.cloneRange()
            }
          }
        } catch {}
      },
      unSelect: () => {
        resetSelectedText()
      },
      link: {
        isOpen: false,
        click: (dom: Element) => {
          const href = dom.getAttribute('href') || dom.innerHTML
          if (!href) return
          open(href)
        }
      },
      preview: {
        hljs: {
          lineNumber: enableLineNumber,
        },
      },
      hint: {
        extend: [
          {
            key: '...',
            hint: async () => {
              emitter.emit('toolbar-continue');
              return []
            }
          },
          {
            key: '???',
            hint: async () => {
              emitter.emit('toolbar-question');
              return []
            }
          },
        ]
      },
      after: () => {
        editorRef.current = vditor
        setEditor(vditor);
        isReinitializingRef.current = false
        try {
          ensureHighlightLayer(vditor)
        } catch {}
        // 切换记录编辑模式
        const editModeButtons = vditor.vditor.element.querySelectorAll('.edit-mode-button .vditor-hint button')
        editModeButtons.forEach(button => {
          button.addEventListener('click', () => {
            const mode = button.getAttribute('data-mode')
            if (!mode) return
            setLocalMode(mode as 'ir' | 'sv' | 'wysiwyg')
          })
        })
        const { currentArticle: latestArticle, activeFilePath: latestActivePath } = useArticleStore.getState()
        // 初始化完成后，确保把当前文件内容写入编辑器并渲染预览（避免双屏预览时右侧不渲染）
        if (!latestActivePath) {
          vditor.setValue('', true)
        } else {
          vditor.setValue(latestArticle || '', false)
          try {
            vditor.renderPreview()
          } catch {}
        }
        setEditorPadding(vditor)
      },
      input: async (value) => {
        if (!activeFilePathRef.current && !isCreatingFileRef.current) {
          // 自动创建 untitled.md 文件，并写入当前内容
          isCreatingFileRef.current = true
          await createUntitledFile(value)
          isCreatingFileRef.current = false
          return // 创建文件后会触发 setActiveFilePath，不需要再次保存
        }
        if (activeFilePathRef.current) {
          saveCurrentArticle(value)
          emitter.emit('editor-input')
          handleLocalImage(vditor)
        }
      },
      mode: localMode,
      upload: {
        async handler(files: File[]) {
          const store = await Store.load('store.json');
          const useImageRepo = await store.get('useImageRepo')
          if (useImageRepo) {
            const filesUrls = await uploadImages(files)
            if (vditor && typeof vditor.insertValue === 'function') {
              for (let i = 0; i < filesUrls.length; i++) {
                vditor.insertValue(`![${files[i].name}](${filesUrls[i]})`)
              }
            }
            return filesUrls.join('\n')
          } else {
            // 保存到 activeFilePath/image 目录下
            const workspace = await getWorkspacePath()
            const articlePath = activeFilePath.split('/').slice(0, -1).join('/')
            const appDataDirPath = await appDataDir()
            for (let i = 0; i < files.length; i++) {
              const uint8Array = new Uint8Array(await files[i].arrayBuffer())
              const fileName = `${uuid()}.${files[i].name.split('.')[files[i].name.split('.').length - 1]}`
              let imagesDir = ''
              if (!workspace.isCustom) {
                imagesDir = `${appDataDirPath}/article/${articlePath}/${assetsPath}`
              } else {
                imagesDir = `${workspace.path}/${articlePath}/${assetsPath}`
              }
              if (!await exists(imagesDir)) {
                await mkdir(imagesDir)
              }
              const path = `${imagesDir}/${fileName}`
              await writeFile(path, uint8Array)
              if (typeof vditor.insertValue === 'function') {
                vditor.insertValue(`![${files[i].name}](/${assetsPath}/${fileName})`)
              }
            }
            return '图片已保存到本地'
          }
        }
      },
      counter: {
        enable: true,
        after: (length: number) => {
          emitter.emit('toolbar-text-number', length)
        }
      }
    })
  }

  function clearHighlightTimeout() {
    if (highlightTimeoutRef.current) {
      window.clearTimeout(highlightTimeoutRef.current)
      highlightTimeoutRef.current = null
    }
  }

  function getEditorDomContext(vditor: Vditor) {
    const mode = vditor.getCurrentMode()
    const pre = ((vditor as any)?.vditor?.[mode]?.element as HTMLElement | undefined) || null
    const wrapper = (pre?.parentElement as HTMLElement | null) || null
    if (!pre || !wrapper) return null
    return { pre, wrapper }
  }

  function ensureHighlightLayer(vditor: Vditor) {
    const ctx = getEditorDomContext(vditor)
    if (!ctx) return null

    // 模式切换后 pre 变化需要清理旧监听
    const prev = highlightUiRef.current
    if (prev.pre && prev.pre !== ctx.pre && prev.cleanup) {
      prev.cleanup()
      highlightUiRef.current = { pre: null, wrapper: null, layer: null, inner: null, cleanup: null }
    }

    if (highlightUiRef.current.pre === ctx.pre && highlightUiRef.current.layer && highlightUiRef.current.inner) {
      return highlightUiRef.current
    }

    ctx.wrapper.style.position = ctx.wrapper.style.position || 'relative'

    let layer = ctx.wrapper.querySelector(':scope > .md-highlight-layer') as HTMLDivElement | null
    if (!layer) {
      layer = document.createElement('div')
      layer.className = 'md-highlight-layer'
      layer.setAttribute('aria-hidden', 'true')
      const inner = document.createElement('div')
      inner.className = 'md-highlight-layer__inner'
      layer.appendChild(inner)

      // 放到最前（但在 gutter 之后也无所谓）
      ctx.wrapper.insertBefore(layer, ctx.wrapper.firstChild)
    }
    const inner = layer.querySelector('.md-highlight-layer__inner') as HTMLDivElement | null

    const sync = () => {
      const current = highlightUiRef.current
      if (!current?.inner || !current?.pre) return
      current.inner.style.transform = `translate(${-current.pre.scrollLeft}px, ${-current.pre.scrollTop}px)`
    }
    ctx.pre.addEventListener('scroll', sync, { passive: true })

    const ro = new ResizeObserver(() => {
      sync()
      try {
        refreshHighlights(vditor)
      } catch {}
    })
    ro.observe(ctx.wrapper)

    const cleanup = () => {
      ctx.pre.removeEventListener('scroll', sync as any)
      ro.disconnect()
      try {
        layer?.remove()
      } catch {}
    }

    highlightUiRef.current = { pre: ctx.pre, wrapper: ctx.wrapper, layer, inner, cleanup }
    sync()
    return highlightUiRef.current
  }

  function clearHighlights(id?: string) {
    const inner = highlightUiRef.current.inner
    if (!inner) return
    clearHighlightTimeout()
    if (!id) {
      inner.innerHTML = ''
      return
    }
    inner.querySelectorAll(`[data-highlight-id="${CSS.escape(id)}"]`).forEach(el => el.remove())
  }

  function computeContentRects(range: Range, wrapper: HTMLElement, pre: HTMLElement) {
    const wrapperRect = wrapper.getBoundingClientRect()
    const rects = Array.from(range.getClientRects())
      .filter(r => r.width > 0 && r.height > 0)
      .map(r => ({
        left: r.left - wrapperRect.left + pre.scrollLeft,
        top: r.top - wrapperRect.top + pre.scrollTop,
        width: r.width,
        height: r.height,
      }))
    return rects
  }

  function setHighlightRects(args: { id: string; color: string; rects: Array<{ left: number; top: number; width: number; height: number }> }) {
    const inner = highlightUiRef.current.inner
    if (!inner) return
    clearHighlights(args.id)
    for (const r of args.rects) {
      const el = document.createElement('div')
      el.className = 'md-highlight-rect'
      el.setAttribute('data-highlight-id', args.id)
      el.style.left = `${r.left}px`
      el.style.top = `${r.top}px`
      el.style.width = `${r.width}px`
      el.style.height = `${r.height}px`
      el.style.background = args.color
      inner.appendChild(el)
    }
  }

  function highlightRange(vditor: Vditor, id: string, color: string, range: Range) {
    const ui = ensureHighlightLayer(vditor)
    if (!ui?.pre || !ui?.wrapper) return
    if (range.collapsed) return
    if (!ui.pre.contains(range.commonAncestorContainer)) return
    const rects = computeContentRects(range, ui.wrapper, ui.pre)
    setHighlightRects({ id, color, rects })
  }

  function findTextRangeInElement(root: HTMLElement, needle: string): Range | null {
    const query = String(needle || '')
    if (!query.trim()) return null

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    const starts: number[] = []
    let full = ''

    while (walker.nextNode()) {
      const t = walker.currentNode as Text
      const value = t.nodeValue || ''
      if (!value) continue
      if (full.length > 800000) break
      starts.push(full.length)
      nodes.push(t)
      full += value
    }

    const idx = full.indexOf(query)
    if (idx < 0) return null
    const endIdx = idx + query.length

    const locate = (pos: number) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const start = starts[i]
        const end = start + (nodes[i].nodeValue || '').length
        if (pos >= start && pos <= end) {
          return { node: nodes[i], offset: pos - start }
        }
      }
      return null
    }

    const s = locate(idx)
    const e = locate(endIdx)
    if (!s || !e) return null

    const r = document.createRange()
    r.setStart(s.node, s.offset)
    r.setEnd(e.node, e.offset)
    return r
  }

  function highlightCurrentSelection(vditor: Vditor, id: string, color: string, opts?: { fallbackRange?: Range | null }) {
    const ui = ensureHighlightLayer(vditor)
    if (!ui?.pre || !ui?.wrapper) return
    const sel = window.getSelection()
    let range: Range | null = null
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0)
      if (!r.collapsed) range = r
    }
    if (!range && opts?.fallbackRange) range = opts.fallbackRange
    if (!range || range.collapsed) return
    if (!ui.pre.contains(range.commonAncestorContainer)) return
    const rects = computeContentRects(range, ui.wrapper, ui.pre)
    setHighlightRects({ id, color, rects })
  }

  function refreshHighlights(vditor: Vditor) {
    ensureHighlightLayer(vditor)

    const quoteRange = lastSelectionRangeRef.current
    if (quoteRange) {
      try {
        highlightRange(vditor, 'quote-selection', 'rgba(255, 230, 150, 0.45)', quoteRange)
      } catch {}
    }

    const ctx = getEditorDomContext(vditor)
    if (ctx) {
      if (aiPendingNeedleRef.current) {
        const r = findTextRangeInElement(ctx.pre, aiPendingNeedleRef.current)
        if (r) {
          const rects = computeContentRects(r, ctx.wrapper, ctx.pre)
          setHighlightRects({ id: 'ai-pending', color: 'rgba(160, 255, 160, 0.28)', rects })
        } else {
          clearHighlights('ai-pending')
        }
      }

      if (aiAppliedNeedleRef.current) {
        const r = findTextRangeInElement(ctx.pre, aiAppliedNeedleRef.current)
        if (r) {
          const rects = computeContentRects(r, ctx.wrapper, ctx.pre)
          setHighlightRects({ id: 'ai-applied', color: 'rgba(120, 255, 120, 0.20)', rects })
        } else {
          clearHighlights('ai-applied')
        }
      }
    }
  }

  function resetSelectedText() {
    setSelectedText('')
    setFloatBarPosition(null)
  }

  // 自动创建 untitled.md 文件
  async function createUntitledFile(content: string) {
    try {
      const workspace = await getWorkspacePath()
      
      // 生成唯一的文件名
      let fileName = 'untitled.md'
      let counter = 1
      let filePath = fileName
      
      // 检查文件是否存在，如果存在则添加数字后缀
      while (true) {
        const pathOptions = await import('@/lib/workspace').then(m => m.getFilePathOptions(filePath))
        let fileExists = false
        
        if (workspace.isCustom) {
          fileExists = await exists(pathOptions.path)
        } else {
          fileExists = await exists(pathOptions.path, { baseDir: pathOptions.baseDir })
        }
        
        if (!fileExists) break
        
        fileName = `untitled-${counter}.md`
        filePath = fileName
        counter++
      }
      
      // 创建文件并写入内容
      const pathOptions = await import('@/lib/workspace').then(m => m.getFilePathOptions(filePath))
      if (workspace.isCustom) {
        await writeTextFile(pathOptions.path, content)
      } else {
        await writeTextFile(pathOptions.path, content, { baseDir: pathOptions.baseDir })
      }
      
      // 先更新 store 中的内容，避免后续读取文件时覆盖
      setCurrentArticle(content)
      
      // 设置为当前活动文件
      await setActiveFilePath(filePath)
      await loadFileTree()
      
    } catch (error) {
      console.error('Create untitled file error:', error)
    }
  }

  // 设置编辑器 padding
  async function setEditorPadding(vditor: Vditor) {
    const store = await Store.load('store.json');
    const pageView = await store.get<'immersiveView' | 'panoramaView'>('pageView') || 'immersiveView'
    const resetDom = vditor.vditor.element.querySelectorAll('.vditor-reset')
    if (resetDom && pageView === "panoramaView") {
      resetDom.forEach(dom => {
        (dom as HTMLElement).style.setProperty('padding', '10px', 'important')
      })
    }
  }

  // 处理本地相对路径图片
  async function handleLocalImage(vditor: Vditor) {
    const workspace = await getWorkspacePath()
    const previews = [vditor.vditor.ir?.element, vditor.vditor.sv?.element, vditor.vditor.wysiwyg?.element]
    previews.forEach(element => {
      element?.querySelectorAll('img').forEach(async (img) => {
        let src = img.getAttribute('src')
        if (!src) return
        if (!src.startsWith('http') && !src.startsWith('asset://')) {
          const articlePath = activeFilePath.split('/').slice(0, -1).join('/')
          if (src.startsWith('./')) {
            src = src.slice(2)
          }
          if (!src.startsWith('/')) {
            src = `/${src}`
          }
          if (!workspace.isCustom) {
            const relativePath = `/${workspace.path}/${articlePath}${src}`
            const tauriSrc = await convertImage(relativePath)
            img.setAttribute('src', tauriSrc)
          } else {
            const relativePath = `${workspace.path}/${articlePath}${src}`
            const tauriSrc = convertFileSrc(relativePath)
            img.setAttribute('src', tauriSrc)
          }
        }
      })
    })
  }

  async function uploadImages(files: File[]) {
    const list = await Promise.all(
      files.map((file) => {
        return new Promise<string>(async(resolve, reject) => {
          if (!file.type.includes('image')) return
          const toastNotification = toast({
            title: t('upload.uploading'),
            description: file.name,
            duration: 600000,
          })
          await uploadImage(file).then(async url => {
            resolve(url)
          }).catch(err => {
            reject(err)
          }).finally(() => {
            toastNotification.dismiss()
          })
        });
      })
    );
    return list
  }

  // 设置编辑器内容并滚动到匹配位置
  const setContent = (content: string) => {
    const instance = editorRef.current || editor
    if (!instance) return
    try {
      instance.setValue(content, false)
      instance.renderPreview()
    } catch (error) {
      console.error('Error setting editor content:', error)
    }
    // 如果有匹配位置，滚动到对应位置
    if (matchPosition !== null) {
      setTimeout(() => {
        try {
          // 获取编辑器预览区域
          let editorElement: HTMLElement | null = null
          
          // 安全地访问 vditor 属性
          const vditor = instance as any
          if (vditor.vditor) {
            if (localMode === 'ir' && vditor.vditor.ir) {
              editorElement = vditor.vditor.ir.element
            } else if (localMode === 'wysiwyg' && vditor.vditor.wysiwyg) {
              editorElement = vditor.vditor.wysiwyg.element
            } else if (localMode === 'sv' && vditor.vditor.sv) {
              editorElement = vditor.vditor.sv.element
            }
          }
          
          if (editorElement) {
            // 计算目标位置前的文本
            const textBefore = content.substring(0, matchPosition)
            // 计算行数（通过换行符数量）
            const lineCount = (textBefore.match(/\n/g) || []).length
            
            // 创建一个范围来定位匹配位置
            const range = document.createRange()
            const textNodes = Array.from(editorElement.querySelectorAll('*'))
              .filter(node => node.childNodes.length > 0 && 
                     node.childNodes[0].nodeType === Node.TEXT_NODE)
            
            // 尝试找到匹配位置附近的文本节点
            let currentPos = 0
            let targetNode = null
            let targetOffset = 0
            
            for (const node of textNodes) {
              const textContent = node.textContent || ''
              if (currentPos + textContent.length >= matchPosition) {
                targetNode = node.childNodes[0]  // 获取文本节点
                targetOffset = matchPosition - currentPos
                break
              }
              currentPos += textContent.length
            }
            
            // 如果找到了目标节点，设置选择范围并滚动
            if (targetNode) {
              try {
                range.setStart(targetNode, Math.min(targetOffset, targetNode.textContent?.length || 0))
                range.setEnd(targetNode, Math.min(targetOffset + 1, targetNode.textContent?.length || 0))
                
                const selection = window.getSelection()
                if (selection) {
                  selection.removeAllRanges()
                  selection.addRange(range)
                  
                  // 滚动到选中位置
                  const targetElement = range.startContainer.parentElement
                  if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }
                }
              } catch (e) {
                console.error('Error when setting range:', e)
              }
            } else {
              // 如果无法精确定位，尝试通过行号滚动
              const lineElements = editorElement.querySelectorAll('div[data-block="0"]')
              if (lineCount < lineElements.length) {
                lineElements[lineCount]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
            }
          }
        } catch (e) {
          console.error('Error scrolling to match position:', e)
        }
        
        // 处理完后重置匹配位置
        setMatchPosition(null)
      }, 300) // 给编辑器一点时间来渲染内容
    }
  }

  function setTheme(theme: string) {
    const instance = editorRef.current || editor
    if (instance) {
      const editorTheme = theme === 'dark' ? 'dark' : 'light'
      const contentTheme = theme === 'dark' ? 'dark' : 'light'
      const codeTheme = theme === 'dark' ? 'github-dark' : 'github-light'
      instance.setTheme(editorTheme === 'dark' ? 'dark' : 'classic', contentTheme, codeTheme)
    }
  }

  // 同步更新 activeFilePathRef
  useEffect(() => {
    activeFilePathRef.current = activeFilePath
  }, [activeFilePath])

  // 引用选区：持久高亮（淡黄色）
  useEffect(() => {
    const handler = () => {
      const instance = editorRef.current || editor
      if (!instance) return
      highlightCurrentSelection(instance, 'quote-selection', 'rgba(255, 230, 150, 0.45)', { fallbackRange: lastSelectionRangeRef.current })
    }
    emitter.on('editor-highlight-selection', handler)
    return () => {
      emitter.off('editor-highlight-selection', handler)
    }
  }, [editor])

  // Agent 等待确认时：把“将要改的区域”标成浅绿色，便于用户确认
  useEffect(() => {
    const instance = editorRef.current || editor
    if (!instance) return
    ensureHighlightLayer(instance)

    if (!pendingConfirmation) {
      aiPendingNeedleRef.current = null
      clearHighlights('ai-pending')
      return
    }
    if (pendingConfirmation.toolName !== 'replace_current_article_lines') return
    if (!activeFilePathRef.current) return

    const startLine = Number((pendingConfirmation as any)?.params?.startLine)
    const endLine = Number((pendingConfirmation as any)?.params?.endLine)
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return

    const lines = String(currentArticle || '').split('\n')
    const s = Math.max(1, Math.min(lines.length || 1, Math.floor(startLine)))
    const e = Math.max(s, Math.min(lines.length || 1, Math.floor(endLine)))
    const oldChunk = lines.slice(s - 1, e).join('\n').trim()
    if (!oldChunk) return

    const ctx = getEditorDomContext(instance)
    if (!ctx) return

    const needle = oldChunk.length > 1200 ? oldChunk.slice(0, 1200) : oldChunk
    aiPendingNeedleRef.current = needle
    const r = findTextRangeInElement(ctx.pre, needle)
    if (!r) return
    const rects = computeContentRects(r, ctx.wrapper, ctx.pre)
    setHighlightRects({ id: 'ai-pending', color: 'rgba(160, 255, 160, 0.28)', rects })
  }, [pendingConfirmation, editor, currentArticle])

  // Agent 已应用改动：把新内容标成浅绿色一段时间
  useEffect(() => {
    const handler = (evt: unknown) => {
      const payload = evt as { filePath?: string; content?: string }
      if (!payload?.filePath) return
      if (payload.filePath !== activeFilePathRef.current) return
      const instance = editorRef.current || editor
      if (!instance) return

      clearHighlights('ai-pending')
      clearHighlights('ai-applied')
      clearHighlightTimeout()

      const content = String(payload.content || '').trim()
      if (!content) return

      // 等待编辑器渲染完成再找 DOM
      window.setTimeout(() => {
        const ctx = getEditorDomContext(instance)
        if (!ctx) return
        const needle = content.length > 1200 ? content.slice(0, 1200) : content
        aiAppliedNeedleRef.current = needle
        const r = findTextRangeInElement(ctx.pre, needle)
        if (!r) return
        const rects = computeContentRects(r, ctx.wrapper, ctx.pre)
        setHighlightRects({ id: 'ai-applied', color: 'rgba(120, 255, 120, 0.20)', rects })

        highlightTimeoutRef.current = window.setTimeout(() => {
          aiAppliedNeedleRef.current = null
          clearHighlights('ai-applied')
        }, 8000)
      }, 80)
    }

    emitter.on('editor-ai-applied', handler)
    return () => {
      emitter.off('editor-ai-applied', handler)
    }
  }, [editor])

  // 切换文件时清掉所有高亮
  useEffect(() => {
    clearHighlights()
  }, [activeFilePath])

  useEffect(() => {
    emitter.on('toolbar-reset-selected-text', resetSelectedText)
    return () => {
      emitter.off('toolbar-reset-selected-text')
    }
  }, [editor])

  useEffect(() => {
    if (!editor) {
      if (!isReinitializingRef.current) {
        init()
        if (activeFilePath) {
          setContent(currentArticle)
        }
      }
    } else {
      // 如果文件被删除或取消选中，清空编辑器
      if (!activeFilePath) {
        editor.setValue('', true)
        setCurrentArticle('')
      }
    }
  }, [activeFilePath])

  useEffect(() => {
    isReinitializingRef.current = true
    const instance = editorRef.current || editor
    if (instance) {
      try {
        highlightUiRef.current.cleanup?.()
        highlightUiRef.current = { pre: null, wrapper: null, layer: null, inner: null, cleanup: null }
        instance.destroy()
      } catch {}
      editorRef.current = null
      setEditor(undefined)
    }
    init()
  }, [currentLocale])

  useEffect(() => {
    if (editor) {
      if (loading) {
        editor.disabled()
      } else {
        editor.enable()
      }
    }
  }, [loading])

  useEffect(() => {
    let editorTheme: string | undefined
    if (theme === 'system') {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        editorTheme = 'dark'
      }
    } else {
      editorTheme = theme
    }
    if (editorRef.current || editor) {
      setTheme(editorTheme || 'light')
    }
  }, [theme, editor])

  useEffect(() => {
    const matchMedia = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (editor && theme === 'system') {
        const editorTheme = matchMedia.matches ? 'dark' : 'light'
        setTheme(editorTheme)
      }
    }
    matchMedia.addEventListener('change', handler)
    return () => {
      matchMedia.removeEventListener('change', handler)
    }
  }, [theme, editor])

  useEffect(() => {
    if (activeFilePath) {
      setContent(currentArticle)
      const instance = editorRef.current || editor
      instance?.clearStack()
      if (!instance) return
      handleLocalImage(instance)
    }
  }, [currentArticle, editor, activeFilePath])

  useEffect(() => {
    const handler = () => {
      const instance = editorRef.current || editor
      if (!instance) return
      setEditorPadding(instance)
      try {
        refreshHighlights(instance)
      } catch {}
    }
    window.addEventListener('resize', handler)
    return () => {
      window.removeEventListener('resize', handler)
    }
  }, [editor])

  // 监听编辑器宽度变化，动态更新工具栏
  useEffect(() => {
    if (!editor) return

    const editorElement = document.getElementById('aritcle-md-editor')
    if (!editorElement) return

    let resizeTimer: NodeJS.Timeout | null = null
    let lastToolbarLevel = -1

    // 根据宽度计算当前应该显示的工具栏级别
    const getToolbarLevel = (width: number) => {
      if (width >= 868) return 4 // 显示所有组
      if (width >= 489) return 3 // 显示到 group3
      if (width >= 326) return 2 // 显示到 groupLast
      return 1 // 只显示基础组
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        
        // 清除之前的定时器
        if (resizeTimer) {
          clearTimeout(resizeTimer)
        }

        // 防抖：等待拖拽结束后再更新
        resizeTimer = setTimeout(() => {
          const currentLevel = getToolbarLevel(width)
          
          // 只在跨越阈值时才更新工具栏
          if (currentLevel !== lastToolbarLevel && lastToolbarLevel !== -1) {
            setEditorWidth(width)
            
            const newToolbarConfig = createToolbarConfig(t, width)
            const toolbarElement = editor.vditor.toolbar?.element
            if (toolbarElement) {
              const store = Store.load('store.json')
              store.then(async (s) => {
                const typewriterMode = await s.get<boolean>('typewriterMode') || false
                const outlinePosition = await s.get<'left' | 'right'>('outlinePosition') || 'left'
                const enableOutline = await s.get<boolean>('enableOutline') || false
                const enableLineNumber = await s.get<boolean>('enableLineNumber') || false
                
                const latestArticle = useArticleStore.getState().currentArticle
                const currentContent = latestArticle || editor.getValue()
                const currentMode = editor.vditor.currentMode

                isReinitializingRef.current = true
                try {
                  highlightUiRef.current.cleanup?.()
                  highlightUiRef.current = { pre: null, wrapper: null, layer: null, inner: null, cleanup: null }
                } catch {}
                editor.destroy()
                editorRef.current = null
                setEditor(undefined)
                
                const vditor = new Vditor('aritcle-md-editor', {
                  lang: getLang(),
                  height: '100%',
                  icon: 'material',
                  cdn: '',
                  tab: '\t',
                  theme: theme === 'dark' ? 'dark' : 'classic',
                  toolbar: newToolbarConfig,
                  typewriterMode,
                  outline: {
                    enable: enableOutline,
                    position: outlinePosition,
                  },
                  preview: {
                    hljs: {
                      lineNumber: enableLineNumber,
                    },
                  },
                  mode: currentMode,
                  after: () => {
                    vditor.setValue(currentContent, false)
                    try {
                      vditor.renderPreview()
                    } catch {}
                    setEditor(vditor)
                    editorRef.current = vditor
                    isReinitializingRef.current = false
                    setEditorPadding(vditor)
                  },
                  input: (value) => {
                    saveCurrentArticle(value)
                    emitter.emit('editor-input')
                    handleLocalImage(vditor)
                  },
                })
              })
            }
          }
          
          lastToolbarLevel = currentLevel
        }, 300) // 300ms 防抖延迟
      }
    })

    resizeObserver.observe(editorElement)
    
    // 初始化时记录当前级别
    const initialWidth = editorElement.clientWidth
    lastToolbarLevel = getToolbarLevel(initialWidth)

    return () => {
      if (resizeTimer) {
        clearTimeout(resizeTimer)
      }
      resizeObserver.disconnect()
    }
  }, [editor, editorWidth, t, theme, currentLocale])

  // 应用正文文字大小缩放
  useEffect(() => {
    if (editor) {
      const vditorElement = editor.vditor.element
      if (vditorElement) {
        // 应用到 vditor-reset 元素（实际的编辑内容区域）
        const resetElements = vditorElement.querySelectorAll('.vditor-reset') as NodeListOf<HTMLElement>
        resetElements.forEach(element => {
          element.style.fontSize = `${contentTextScale}%`
        })
        
        // 同时应用到预览区域
        const preview = vditorElement.querySelector('.vditor-preview') as HTMLElement
        if (preview) preview.style.fontSize = `${contentTextScale}%`
      }
    }
  }, [contentTextScale, editor])

  // 处理拖放事件
  useEffect(() => {
    if (!editor) return

    const editorContainer = document.getElementById('article-editor')
    if (!editorContainer) return

    const handleDragOver = (e: DragEvent) => {
      // 检查是否是从记录拖拽过来的
      if (e.dataTransfer?.types.includes('text/plain')) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setIsDraggingOver(true)
        
        // 聚焦编辑器并根据鼠标位置设置光标
        if (editor) {
          editor.focus()
          
          // 尝试根据鼠标位置设置光标
          // Vditor 使用 CodeMirror 或其他编辑器，需要找到对应的编辑区域
          const vditorElement = editor.vditor.element
          const editArea = vditorElement?.querySelector('.vditor-ir__marker, .vditor-wysiwyg, .vditor-sv') as HTMLElement
          
          if (editArea) {
            // 使用 document.caretPositionFromPoint 或 document.caretRangeFromPoint
            let range: Range | null = null
            
            if (document.caretRangeFromPoint) {
              range = document.caretRangeFromPoint(e.clientX, e.clientY)
            } else if ((document as any).caretPositionFromPoint) {
              const position = (document as any).caretPositionFromPoint(e.clientX, e.clientY)
              if (position) {
                range = document.createRange()
                range.setStart(position.offsetNode, position.offset)
              }
            }
            
            if (range) {
              const selection = window.getSelection()
              if (selection) {
                selection.removeAllRanges()
                selection.addRange(range)
              }
            }
          }
        }
      }
    }

    const handleDragLeave = (e: DragEvent) => {
      // 只有当离开整个编辑器容器时才清除状态
      const rect = editorContainer.getBoundingClientRect()
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        setIsDraggingOver(false)
      }
    }

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDraggingOver(false)

      if (!e.dataTransfer) return

      // 获取拖放的文本内容
      const markdownContent = e.dataTransfer.getData('text/plain')
      
      if (markdownContent && editor) {
        // 光标位置已经在 dragover 时设置好了，直接插入内容
        // 不添加换行，允许插入到文本中间
        editor.insertValue(markdownContent)
        editor.focus()
      }
    }

    editorContainer.addEventListener('dragover', handleDragOver)
    editorContainer.addEventListener('dragleave', handleDragLeave)
    editorContainer.addEventListener('drop', handleDrop)

    return () => {
      editorContainer.removeEventListener('dragover', handleDragOver)
      editorContainer.removeEventListener('dragleave', handleDragLeave)
      editorContainer.removeEventListener('drop', handleDrop)
    }
  }, [editor])


  return <div 
    id="article-editor" 
    className={`flex-1 relative w-full h-full flex flex-col overflow-hidden dark:bg-zinc-950 transition-all ${isDraggingOver ? 'bg-accent/20' : ''}`}
  >
    <CustomToolbar editor={editor} />
    <div 
      id="aritcle-md-editor" 
      className="flex-1 min-h-0 overflow-hidden"
      style={{minWidth: 0}}
    ></div>
    <CustomFooter editor={editor} />
    <FloatBar left={floatBarPosition?.left} top={floatBarPosition?.top} value={selectedText} editor={editor} />
  </div>
}
