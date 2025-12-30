import { Tool, ToolResult } from '../types'
import useArticleStore from '@/stores/article'
import { getAllWorkspaceFiles } from '@/lib/files'
import { getFilePathOptions, getWorkspacePath } from '@/lib/workspace'
import emitter from '@/lib/emitter'
import { readTextFile, writeTextFile, readFile } from '@tauri-apps/plugin-fs'

export const getCurrentArticleTool: Tool = {
  name: 'get_current_article',
  description: '获取当前正在编辑的文章（路径 + 完整内容）',
  category: 'note',
  requiresConfirmation: false,
  parameters: [],
  execute: async (): Promise<ToolResult> => {
    const { activeFilePath, currentArticle } = useArticleStore.getState()
    if (!activeFilePath) {
      return { success: false, error: '当前没有打开的文章文件' }
    }
    return {
      success: true,
      data: { filePath: activeFilePath, content: currentArticle || '' },
      message: `已获取当前文章: ${activeFilePath}`,
    }
  },
}

export const findInCurrentArticleTool: Tool = {
  name: 'find_in_current_article',
  description: '在当前文章中查找文本/正则，并返回匹配的行号与内容片段',
  category: 'search',
  requiresConfirmation: false,
  parameters: [
    { name: 'query', type: 'string', description: '要查找的文本或正则', required: true },
    { name: 'regex', type: 'boolean', description: '是否把 query 当作正则表达式', required: false, default: false },
    { name: 'caseSensitive', type: 'boolean', description: '是否区分大小写', required: false, default: false },
    { name: 'limit', type: 'number', description: '最多返回多少条匹配', required: false, default: 50 },
  ],
  execute: async (params): Promise<ToolResult> => {
    const { activeFilePath, currentArticle } = useArticleStore.getState()
    if (!activeFilePath) return { success: false, error: '当前没有打开的文章文件' }

    const query = String(params.query || '')
    if (!query) return { success: false, error: 'query 不能为空' }

    const regex = Boolean(params.regex)
    const caseSensitive = Boolean(params.caseSensitive)
    const limit = Math.max(1, Math.min(200, Number(params.limit || 50)))

    let re: RegExp
    try {
      re = regex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi')
    } catch (e) {
      return { success: false, error: `正则无效: ${String(e)}` }
    }

    const lines = String(currentArticle || '').split('\n')
    const matches: Array<{ line: number; text: string }> = []
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ line: i + 1, text: lines[i] })
        if (matches.length >= limit) break
      }
      re.lastIndex = 0
    }

    return {
      success: true,
      data: { filePath: activeFilePath, matches },
      message: `匹配到 ${matches.length} 行`,
    }
  },
}

export const replaceCurrentArticleLinesTool: Tool = {
  name: 'replace_current_article_lines',
  description: '按行替换当前文章的一段内容（1-based 行号，包含 endLine）',
  category: 'note',
  requiresConfirmation: true,
  parameters: [
    { name: 'startLine', type: 'number', description: '起始行号（从 1 开始）', required: true },
    { name: 'endLine', type: 'number', description: '结束行号（从 1 开始，包含）', required: true },
    { name: 'content', type: 'string', description: '要替换进去的新内容（可包含换行）', required: true },
  ],
  execute: async (params): Promise<ToolResult> => {
    const store = useArticleStore.getState()
    const { activeFilePath, currentArticle } = store
    if (!activeFilePath) return { success: false, error: '当前没有打开的文章文件' }

    const startLine = Number(params.startLine)
    const endLine = Number(params.endLine)
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
      return { success: false, error: 'startLine/endLine 必须是数字' }
    }

    const lines = String(currentArticle || '').split('\n')
    const maxLine = Math.max(1, lines.length)
    const s = Math.max(1, Math.min(maxLine, Math.floor(startLine)))
    const e = Math.max(s, Math.min(maxLine, Math.floor(endLine)))

    const replacement = String(params.content ?? '')
    const replacementLines = replacement.split('\n')

    const nextLines = [
      ...lines.slice(0, s - 1),
      ...replacementLines,
      ...lines.slice(e),
    ]

    const nextContent = nextLines.join('\n')
    store.setCurrentArticle(nextContent)
    await store.saveCurrentArticle(nextContent)
    const workspace = await getWorkspacePath()
    const resolved = await getFilePathOptions(activeFilePath)
    let verifyLength: number | null = null
    try {
      const text = workspace.isCustom
        ? await readTextFile(resolved.path)
        : await readTextFile(resolved.path, { baseDir: resolved.baseDir })
      verifyLength = text.length
    } catch {}
    try {
      emitter.emit('editor-ai-applied', {
        filePath: activeFilePath,
        startLine: s,
        endLine: e,
        content: replacement,
      })
    } catch {}

    return {
      success: true,
      data: {
        filePath: activeFilePath,
        startLine: s,
        endLine: e,
        workspace,
        resolvedPath: resolved.path,
        verifyLength,
      },
      message: `已替换 ${activeFilePath} 的第 ${s}-${e} 行`,
    }
  },
}

export const updateArticleTool: Tool = {
  name: 'update_article',
  description: '用完整内容覆盖当前正在编辑的文章（不需要 filePath）',
  category: 'note',
  requiresConfirmation: true,
  parameters: [
    { name: 'content', type: 'string', description: '要写入的新内容（完整文章）', required: true },
    { name: 'allowEmpty', type: 'boolean', description: '是否允许写入空内容（默认 false，防止误清空）', required: false, default: false },
  ],
  execute: async (params): Promise<ToolResult> => {
    const store = useArticleStore.getState()
    const { activeFilePath } = store
    if (!activeFilePath) return { success: false, error: '当前没有打开的文章文件' }

    const content = String(params.content ?? '')
    const allowEmpty = Boolean(params.allowEmpty)
    if (!allowEmpty && content.trim().length === 0) {
      return { success: false, error: 'content 为空：为防止误清空，已拒绝写入。确实要清空请传 allowEmpty=true' }
    }
    store.setCurrentArticle(content)
    await store.saveCurrentArticle(content)

    try {
      emitter.emit('editor-ai-applied', {
        filePath: activeFilePath,
        startLine: 1,
        endLine: Math.max(1, content.split('\n').length),
        content,
      })
    } catch {}

    const workspace = await getWorkspacePath()
    const resolved = await getFilePathOptions(activeFilePath)
    let verifyLength: number | null = null
    try {
      const text = workspace.isCustom
        ? await readTextFile(resolved.path)
        : await readTextFile(resolved.path, { baseDir: resolved.baseDir })
      verifyLength = text.length
    } catch {}

    return {
      success: true,
      data: { filePath: activeFilePath, workspace, resolvedPath: resolved.path, verifyLength },
      message: `已更新文章: ${activeFilePath}`,
    }
  },
}

export const listWorkspaceFilesTool: Tool = {
  name: 'list_workspace_files',
  description: '列出工作区内的文件（包含图片/任意后缀），用于选择 read/write 的 filePath',
  category: 'note',
  requiresConfirmation: false,
  parameters: [
    { name: 'query', type: 'string', description: '可选：按相对路径/文件名包含关系过滤', required: false },
    { name: 'limit', type: 'number', description: '最多返回多少条', required: false, default: 200 },
  ],
  execute: async (params): Promise<ToolResult> => {
    try {
      const query = String(params.query || '').trim().toLowerCase()
      const limit = Math.max(1, Math.min(1000, Number(params.limit || 200)))
      const files = await getAllWorkspaceFiles()
      const filtered = query
        ? files.filter(f => (f.relativePath || f.name || '').toLowerCase().includes(query))
        : files

      const list = filtered.slice(0, limit).map(f => ({
        name: f.name,
        relativePath: f.relativePath,
        path: f.path,
      }))

      return {
        success: true,
        data: list,
        message: `找到 ${filtered.length} 个文件（返回 ${list.length} 个）`,
      }
    } catch (error) {
      return { success: false, error: `列出文件失败: ${String(error)}` }
    }
  },
}

export const readWorkspaceFileTool: Tool = {
  name: 'read_workspace_file',
  description: '读取工作区文件：文本返回内容；二进制返回 base64（截断）+ 元信息',
  category: 'note',
  requiresConfirmation: false,
  parameters: [
    { name: 'filePath', type: 'string', description: '相对路径（默认工作区）或绝对路径（自定义工作区）', required: true },
    { name: 'maxChars', type: 'number', description: '文本最多返回多少字符', required: false, default: 60000 },
    { name: 'maxBytes', type: 'number', description: '二进制最多读取多少字节（base64 会膨胀）', required: false, default: 131072 },
  ],
  execute: async (params): Promise<ToolResult> => {
    const filePath = String(params.filePath || '')
    if (!filePath) return { success: false, error: 'filePath 不能为空' }

    const maxChars = Math.max(1000, Math.min(200000, Number(params.maxChars || 60000)))
    const maxBytes = Math.max(1024, Math.min(2 * 1024 * 1024, Number(params.maxBytes || 131072)))

    try {
      const workspace = await getWorkspacePath()
      if (workspace.isCustom) {
        const content = await readTextFile(filePath)
        const clipped = content.length > maxChars ? `${content.slice(0, maxChars)}\n\n[...truncated ${content.length - maxChars} chars...]` : content
        return { success: true, data: { filePath, type: 'text', content: clipped }, message: `已读取文件: ${filePath}` }
      }

      const { path, baseDir } = await getFilePathOptions(filePath)
      const content = await readTextFile(path, { baseDir })
      const clipped = content.length > maxChars ? `${content.slice(0, maxChars)}\n\n[...truncated ${content.length - maxChars} chars...]` : content
      return { success: true, data: { filePath, type: 'text', content: clipped }, message: `已读取文件: ${filePath}` }
    } catch {
      // fallback: binary
    }

    try {
      const workspace = await getWorkspacePath()
      const bytes = workspace.isCustom
        ? await readFile(filePath)
        : await (async () => {
            const { path, baseDir } = await getFilePathOptions(filePath)
            return await readFile(path, { baseDir })
          })()

      const capped = bytes.slice(0, Math.min(bytes.length, maxBytes))
      const base64 = uint8ToBase64(capped)
      return {
        success: true,
        data: {
          filePath,
          type: 'binary',
          totalBytes: bytes.length,
          returnedBytes: capped.length,
          base64,
        },
        message: `已读取二进制文件（截断）: ${filePath}`,
      }
    } catch (error) {
      return { success: false, error: `读取文件失败: ${String(error)}` }
    }
  },
}

export const writeWorkspaceFileTool: Tool = {
  name: 'write_workspace_file',
  description: '写入（覆盖）工作区文本文件内容',
  category: 'note',
  requiresConfirmation: true,
  parameters: [
    { name: 'filePath', type: 'string', description: '可选：相对路径（默认工作区）或绝对路径（自定义工作区）；不传则写入当前打开的文章', required: false },
    { name: 'content', type: 'string', description: '要写入的文本内容', required: true },
    { name: 'allowEmpty', type: 'boolean', description: '是否允许写入空内容（默认 false，防止误清空）', required: false, default: false },
  ],
  execute: async (params): Promise<ToolResult> => {
    const filePathFromParams = String(params.filePath || '').trim()
    const filePath = filePathFromParams || useArticleStore.getState().activeFilePath || ''
    if (!filePath) return { success: false, error: 'filePath 不能为空（且当前没有打开的文章可作为默认写入目标）' }
    const content = String(params.content ?? '')
    const allowEmpty = Boolean(params.allowEmpty)
    if (!allowEmpty && content.trim().length === 0) {
      return { success: false, error: 'content 为空：为防止误清空，已拒绝写入。确实要清空请传 allowEmpty=true' }
    }

    try {
      const workspace = await getWorkspacePath()
      const resolved = await getFilePathOptions(filePath)
      if (workspace.isCustom) {
        await writeTextFile(resolved.path, content)
      } else {
        await writeTextFile(resolved.path, content, { baseDir: resolved.baseDir })
      }

      // 如果写入的是当前打开的文章，同步更新编辑器状态（否则会出现“写入成功但界面没变”）
      const article = useArticleStore.getState()
      if (article.activeFilePath && article.activeFilePath === filePath) {
        article.setCurrentArticle(content)
      }

      let verifyLength: number | null = null
      let verifyMatches: boolean | null = null
      let verifyPreview: string | null = null
      try {
        const text = workspace.isCustom
          ? await readTextFile(resolved.path)
          : await readTextFile(resolved.path, { baseDir: resolved.baseDir })
        verifyLength = text.length
        const normalize = (s: string) => String(s || '').replace(/\r\n/g, '\n')
        verifyMatches = normalize(text) === normalize(content)
        verifyPreview = text.slice(0, 2000)
      } catch {}

      if (verifyMatches === false) {
        return {
          success: false,
          data: { filePath, workspace, resolvedPath: resolved.path, verifyLength, verifyMatches, verifyPreview },
          error: '写入校验失败：读取回来的内容与写入内容不一致（可能写入到错误路径/被外部改写/发生截断）',
        }
      }

      return {
        success: true,
        data: { filePath, workspace, resolvedPath: resolved.path, verifyLength, verifyMatches, verifyPreview },
        message: `已写入文件: ${filePath}`,
      }
    } catch (error) {
      return { success: false, error: `写入文件失败: ${String(error)}` }
    }
  },
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: '写入（覆盖）工作区文本文件内容（write_workspace_file 的别名）',
  category: 'note',
  requiresConfirmation: true,
  parameters: writeWorkspaceFileTool.parameters,
  execute: writeWorkspaceFileTool.execute,
}

export const workspaceTools: Tool[] = [
  getCurrentArticleTool,
  findInCurrentArticleTool,
  replaceCurrentArticleLinesTool,
  updateArticleTool,
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  writeWorkspaceFileTool,
  writeFileTool,
]

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
