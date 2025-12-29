import { Store } from '@tauri-apps/plugin-store'
import { create } from 'zustand'
import { getVersion } from '@tauri-apps/api/app'
import { AiConfig } from '@/app/core/setting/config'
import { noteGenDefaultModels, noteGenModelKeys } from '@/app/model-config'
import { fetch } from '@tauri-apps/plugin-http'

export interface ChatToolbarItem {
  id: string
  enabled: boolean
  order: number
}

const createSettingStore = (set: any, get: any) => ({
  initSettingData: async () => {
    const store = await Store.load('store.json');
    await get().setVersion()
    
    // 初始化默认的NoteGen模型配置
    const existingAiModelList = (await store.get('aiModelList') as AiConfig[]) || []
    const hasNoteGenModels = existingAiModelList.some(config => 
      config.key === 'note-gen-free' || 
      noteGenModelKeys.includes(config.key) ||
      config.models?.some(model => noteGenModelKeys.includes(model.id))
    )
    
    let finalAiModelList = existingAiModelList
    if (!hasNoteGenModels) {
      finalAiModelList = [...existingAiModelList, ...noteGenDefaultModels]
      await store.set('aiModelList', finalAiModelList)
      set({ aiModelList: finalAiModelList })
    }

    // 检查是否设置了主要模型，如果没有且存在note-gen-chat，则设置为主要模型
    const currentPrimaryModel = await store.get('primaryModel') as string
    const hasNoteGenChat = finalAiModelList.some(config => 
      config.models?.some(model => model.id === 'note-gen-chat') || config.key === 'note-gen-chat'
    )
    
    if (!currentPrimaryModel && hasNoteGenChat) {
      const noteGenFreeConfig = finalAiModelList.find(config => config.key === 'note-gen-free')
      if (noteGenFreeConfig?.models?.some(model => model.id === 'note-gen-chat')) {
        await store.set('primaryModel', 'note-gen-chat')
        set({ primaryModel: 'note-gen-chat' })
      } else {
        await store.set('primaryModel', 'note-gen-chat')
        set({ primaryModel: 'note-gen-chat' })
      }
    }

    // 检查是否设置了嵌入模型，如果没有且存在note-gen-embedding，则设置为默认嵌入模型
    const currentEmbeddingModel = await store.get('embeddingModel') as string
    const hasNoteGenEmbedding = finalAiModelList.some(config => 
      config.models?.some(model => model.id === 'note-gen-embedding') || config.key === 'note-gen-embedding'
    )
    
    if (!currentEmbeddingModel && hasNoteGenEmbedding) {
      const noteGenFreeConfig = finalAiModelList.find(config => config.key === 'note-gen-free')
      if (noteGenFreeConfig?.models?.some(model => model.id === 'note-gen-embedding')) {
        await store.set('embeddingModel', 'note-gen-embedding')
        set({ embeddingModel: 'note-gen-embedding' })
      } else {
        await store.set('embeddingModel', 'note-gen-embedding')
        set({ embeddingModel: 'note-gen-embedding' })
      }
    }

    // 检查并初始化其他模型类型
    const modelTypes = [
      { storeKey: 'placeholderModel', modelType: 'chat' },
      { storeKey: 'translateModel', modelType: 'chat' },
      { storeKey: 'markDescModel', modelType: 'chat' }
    ]

    for (const { storeKey, modelType } of modelTypes) {
      const currentModel = await store.get(storeKey) as string
      if (!currentModel) {
        // 查找第一个可用的聊天模型作为默认值
        const noteGenFreeConfig = finalAiModelList.find(config => config.key === 'note-gen-free')
        if (noteGenFreeConfig?.models?.some(model => model.id === 'note-gen-chat' && model.modelType === modelType)) {
          await store.set(storeKey, 'note-gen-chat')
          set({ [storeKey.replace('Model', '')]: 'note-gen-chat' })
        } else {
          // 查找其他可用的聊天模型
          for (const config of finalAiModelList) {
            if (config.models && config.models.length > 0) {
              const chatModel = config.models.find(model => model.modelType === modelType)
              if (chatModel) {
                await store.set(storeKey, `${config.key}-${chatModel.id}`)
                set({ [storeKey.replace('Model', '')]: `${config.key}-${chatModel.id}` })
                break
              }
            } else if (config.modelType === modelType || !config.modelType) {
              await store.set(storeKey, config.key)
              set({ [storeKey.replace('Model', '')]: config.key })
              break
            }
          }
        }
      }
    }

    // 获取 NoteGen 限时免费模型
    // 如果服务不可用,静默失败,不影响用户使用自己的模型
    try {
      const apiKey = noteGenDefaultModels[0].apiKey
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
      const res = await fetch('https://api.notegen.top/v1/models', {
        method: 'GET',
        headers
      })

      // 检查响应状态
      if (!res.ok) {
        throw new Error(`API responded with status: ${res.status}`)
      }

      const resModels = await res.json()

      if (resModels.data && resModels.data.length > 0) {
        // 移除旧的 NoteGen Limited 配置
        finalAiModelList = finalAiModelList.filter(model => 
          model.title !== 'NoteGen Limited' && model.key !== 'note-gen-limited'
        )
        
        // 过滤出不在默认模型中的限时免费模型
        const limitedModels = resModels.data.filter((model: any) => {
          // 检查是否在 noteGenDefaultModels 的 models 数组中
          return !noteGenDefaultModels[0].models?.some(defaultModel => defaultModel.model === model.id)
        })
        
        // 如果有限时免费模型,创建统一的 NoteGen Limited 配置
        if (limitedModels.length > 0) {
          const noteGenLimitedConfig = {
            apiKey,
            baseURL: "https://api.notegen.top/v1",
            key: "note-gen-limited",
            title: "NoteGen Limited",
            models: limitedModels.map((model: any) => ({
              id: `note-gen-limited-${model.id}`,
              model: model.id,
              modelType: "chat",
              temperature: 0.7,
              topP: 1,
              enableStream: true
            }))
          }
          
          finalAiModelList.push(noteGenLimitedConfig)
          await store.set('aiModelList', finalAiModelList)
          set({ aiModelList: finalAiModelList })
        }
      }
    } catch (error) {
      // 静默处理错误,不影响应用初始化和用户使用自己的模型
      console.debug('NoteGen API service unavailable, skipping limited models:', error)
    }

    Object.entries(get()).forEach(async ([key, value]) => {
      const res = await store.get(key)

      if (typeof value === 'function') return
      if (res !== undefined && key !== 'version') {
        if (key === 'aiModelList' && hasNoteGenModels) {
          // 如果已经有NoteGen模型，使用存储的配置
          set({ [key]: res as AiConfig[] })
        } else if (key !== 'aiModelList') {
          set({ [key]: res })
        }
      } else {
        await store.set(key, value)
      }
    })
  },

  version: '',
  setVersion: async () => {
    const version = await getVersion()
    set({ version })
  },

  language: '简体中文',
  setLanguage: (language: string) => set({ language }),

  currentAi: '',
  setCurrentAi: (currentAi: string) => set({ currentAi }),

  aiModelList: [] as AiConfig[],
  setAiModelList: (aiModelList: AiConfig[]) => set({ aiModelList }),

  primaryModel: '',
  setPrimaryModel: (primaryModel: string) => set({ primaryModel }),

  placeholderModel: '',
  setPlaceholderModel: async (placeholderModel: string) => {
    const store = await Store.load('store.json');
    await store.set('placeholderModel', placeholderModel)
    set({ placeholderModel })
  },

  translateModel: '',
  setTranslateModel: async (translateModel: string) => {
    const store = await Store.load('store.json');
    await store.set('translateModel', translateModel)
    set({ translateModel })
  },

  markDescModel: '',
  setMarkDescModel: async (markDescModel: string) => {
    const store = await Store.load('store.json');
    await store.set('markDescModel', markDescModel)
    set({ markDescModel })
  },

  embeddingModel: '',
  setEmbeddingModel: async (embeddingModel: string) => {
    const store = await Store.load('store.json');
    await store.set('embeddingModel', embeddingModel)
    set({ embeddingModel })
  },

  rerankingModel: '',
  setRerankingModel: async (rerankingModel: string) => {
    const store = await Store.load('store.json');
    await store.set('rerankingModel', rerankingModel)
    set({ rerankingModel })
  },

  darkMode: 'system',
  setDarkMode: (darkMode: string) => set({ darkMode }),

  previewTheme: 'github',
  setPreviewTheme: (previewTheme: string) => set({ previewTheme }),

  codeTheme: 'github',
  setCodeTheme: (codeTheme: string) => set({ codeTheme }),

  jsdelivr: true,
  setJsdelivr: async (jsdelivr: boolean) => {
    set({ jsdelivr })
    const store = await Store.load('store.json');
    await store.set('jsdelivr', jsdelivr)
  },

  useImageRepo: false,
  setUseImageRepo: async (useImageRepo: boolean) => {
    set({ useImageRepo })
    const store = await Store.load('store.json');
    await store.set('useImageRepo', useImageRepo)
  },

  lastSettingPage: 'ai',
  setLastSettingPage: async (page: string) => {
    set({ lastSettingPage: page })
    const store = await Store.load('store.json');
    await store.set('lastSettingPage', page)
  },

  workspacePath: '',
  setWorkspacePath: async (path: string) => {
    set({ workspacePath: path })
    const store = await Store.load('store.json');
    await store.set('workspacePath', path)
    
    // 如果路径不为空且不在历史记录中，则添加到历史记录
    if (path && !get().workspaceHistory.includes(path)) {
      await get().addWorkspaceHistory(path)
    }
  },

  // 工作区历史路径管理
  workspaceHistory: [] as string[],
  addWorkspaceHistory: async (path: string) => {
    const currentHistory = get().workspaceHistory
    const newHistory = [path, ...currentHistory.filter((p: string) => p !== path)].slice(0, 10) // 最多保存10个历史路径
    set({ workspaceHistory: newHistory })
    const store = await Store.load('store.json')
    await store.set('workspaceHistory', newHistory)
    await store.save()
  },
  removeWorkspaceHistory: async (path: string) => {
    const newHistory = get().workspaceHistory.filter((p: string) => p !== path)
    set({ workspaceHistory: newHistory })
    const store = await Store.load('store.json')
    await store.set('workspaceHistory', newHistory)
    await store.save()
  },
  clearWorkspaceHistory: async () => {
    set({ workspaceHistory: [] })
    const store = await Store.load('store.json')
    await store.set('workspaceHistory', [])
    await store.save()
  },

  assetsPath: 'assets',
  setAssetsPath: async (path: string) => {
    set({ assetsPath: path })
    const store = await Store.load('store.json');
    await store.set('assetsPath', path)
    await store.save()
  },

  // 图床设置
  githubImageAccessToken: '',
  setGithubImageAccessToken: async (githubImageAccessToken: string) => {
    set({ githubImageAccessToken })
    const store = await Store.load('store.json');
    await store.set('githubImageAccessToken', githubImageAccessToken)
    await store.save()
  },

  // 界面缩放设置 (75%, 100%, 125%, 150%)
  uiScale: 100,
  setUiScale: async (scale: number) => {
    set({ uiScale: scale })
    const store = await Store.load('store.json');
    await store.set('uiScale', scale)
    await store.save()
    
    // 使用fontSize实现基于rem的缩放
    document.documentElement.style.fontSize = `${scale}%`
  },

  // 正文文字大小缩放设置 (75%, 100%, 125%, 150%)
  contentTextScale: 100,
  setContentTextScale: async (scale: number) => {
    set({ contentTextScale: scale })
    const store = await Store.load('store.json');
    await store.set('contentTextScale', scale)
    await store.save()
  },

  // 自定义 CSS 设置
  customCss: '',
  setCustomCss: async (css: string) => {
    set({ customCss: css })
    const store = await Store.load('store.json');
    await store.set('customCss', css)
    await store.save()
    
    // 应用自定义 CSS
    let styleElement = document.getElementById('custom-css-style')
    if (!styleElement) {
      styleElement = document.createElement('style')
      styleElement.id = 'custom-css-style'
      document.head.appendChild(styleElement)
    }
    styleElement.textContent = css
  },

  // 自定义仓库名称设置（图床）

  githubCustomImageRepo: '',
  setGithubCustomImageRepo: async (repo: string) => {
    set({ githubCustomImageRepo: repo })
    const store = await Store.load('store.json');
    await store.set('githubCustomImageRepo', repo)
    await store.save()
  },

  // 聊天工具栏配置 - PC 端
  chatToolbarConfigPc: [
    // 底部工具栏
    { id: 'modelSelect', enabled: true, order: 0 },
    { id: 'promptSelect', enabled: true, order: 1 },
    { id: 'chatLanguage', enabled: true, order: 2 },
    // 顶部工具栏 - 左侧
    { id: 'fileLink', enabled: true, order: 4 },
    { id: 'mcpButton', enabled: true, order: 5 },
    { id: 'ragSwitch', enabled: true, order: 6 },
    { id: 'chatPlaceholder', enabled: true, order: 7 },
    // 顶部工具栏 - 右侧
    { id: 'clearContext', enabled: true, order: 8 },
    { id: 'clearChat', enabled: true, order: 9 },
  ],
  setChatToolbarConfigPc: async (config: ChatToolbarItem[]) => {
    set({ chatToolbarConfigPc: config })
    const store = await Store.load('store.json');
    await store.set('chatToolbarConfigPc', config)
    await store.save()
  },

  // 聊天工具栏配置 - 移动端
  chatToolbarConfigMobile: [
    { id: 'modelSelect', enabled: true, order: 0 },
    { id: 'promptSelect', enabled: true, order: 1 },
    { id: 'chatLanguage', enabled: true, order: 2 },
    { id: 'fileLink', enabled: true, order: 4 },
    { id: 'mcpButton', enabled: true, order: 5 },
    { id: 'ragSwitch', enabled: true, order: 6 },
    { id: 'chatPlaceholder', enabled: true, order: 7 },
    { id: 'clearContext', enabled: true, order: 8 },
    { id: 'clearChat', enabled: true, order: 9 },
  ],
  setChatToolbarConfigMobile: async (config: ChatToolbarItem[]) => {
    set({ chatToolbarConfigMobile: config })
    const store = await Store.load('store.json');
    await store.set('chatToolbarConfigMobile', config)
    await store.save()
  },

})

export type SettingState = ReturnType<typeof createSettingStore>

const useSettingStore = create<SettingState>(createSettingStore)

export default useSettingStore
