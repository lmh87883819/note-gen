import { create } from 'zustand'
import { Chat, clearChatsByTagId, deleteChat, getChats, initChatsDb, insertChat, updateChat, updateChatsInsertedById } from '@/db/chats'
import { Store } from '@tauri-apps/plugin-store';
import { locales } from '@/lib/locales';
import { ChatMode, AgentState, ToolCall } from '@/lib/agent/types';

// MCP 工具调用记录（临时，不保存到数据库）
export interface McpToolCall {
  id: string
  chatId: number // 关联的 chat ID
  toolName: string
  serverId: string
  serverName: string
  params: Record<string, any>
  result: string
  status: 'calling' | 'success' | 'error'
  timestamp: number
}

interface ChatState {
  loading: boolean
  setLoading: (loading: boolean) => void

  isLinkMark: boolean // 是否关联记录
  setIsLinkMark: (isLinkMark: boolean) => void

  isPlaceholderEnabled: boolean // 是否启用AI提示占位符
  setPlaceholderEnabled: (isEnabled: boolean) => void

  chats: Chat[]
  init: (tagId: number) => Promise<void> // 初始化 chats
  insert: (chat: Omit<Chat, 'id' | 'createdAt'>) => Promise<Chat | null> // 插入一条 chat
  updateChat: (chat: Chat) => void // 更新一条 chat
  saveChat: (chat: Chat, isSave?: boolean) => Promise<void> // 保存一条 chat，用于动态 AI 回复结束后保存数据库
  deleteChat: (id: number) => Promise<void> // 删除一条 chat

  locale: string
  getLocale: () => Promise<void>
  setLocale: (locale: string) => void

  clearChats: (tagId: number) => Promise<void> // 清空 chats
  updateInsert: (id: number) => Promise<void> // 更新 inserted
  
  // MCP 工具调用记录（临时缓存）
  mcpToolCalls: McpToolCall[]
  addMcpToolCall: (toolCall: McpToolCall) => void
  updateMcpToolCall: (id: string, updates: Partial<McpToolCall>) => void
  getMcpToolCallsByChatId: (chatId: number) => McpToolCall[]
  clearMcpToolCalls: () => void

  // Agent 模式
  chatMode: ChatMode
  setChatMode: (mode: ChatMode) => void
  
  agentState: AgentState
  setAgentState: (state: Partial<AgentState>) => void
  resetAgentState: () => void
  addAgentToolCall: (toolCall: ToolCall) => void
  updateAgentToolCall: (id: string, updates: Partial<ToolCall>) => void
}

const useChatStore = create<ChatState>((set, get) => ({
  loading: false,

  setLoading: (loading: boolean) => {
    set({ loading })
  },

  isLinkMark: true,
  setIsLinkMark: (isLinkMark: boolean) => {
    set({ isLinkMark })
  },

  isPlaceholderEnabled: true,
  setPlaceholderEnabled: (isEnabled: boolean) => {
    set({ isPlaceholderEnabled: isEnabled })
  },

  chatMode: (typeof window !== 'undefined' ? localStorage.getItem('chatMode') as ChatMode : null) || 'chat',
  setChatMode: (mode: ChatMode) => {
    set({ chatMode: mode })
    if (typeof window !== 'undefined') {
      localStorage.setItem('chatMode', mode)
    }
  },

  agentState: {
    isRunning: false,
    currentThought: '',
    thoughtHistory: [],
    currentAction: undefined,
    currentObservation: undefined,
    toolCalls: [],
    maxIterations: 15,
    currentIteration: 0,
    pendingConfirmation: undefined,
    confirmationHistory: [],
  },

  setAgentState: (state: Partial<AgentState>) => {
    set({ agentState: { ...get().agentState, ...state } })
  },

  resetAgentState: () => {
    set({
      agentState: {
        isRunning: false,
        currentThought: '',
        thoughtHistory: [],
        currentAction: '',
        currentObservation: '',
        toolCalls: [],
        maxIterations: 15,
        currentIteration: 0,
        pendingConfirmation: undefined,
        confirmationHistory: [],
      }
    })
  },

  addAgentToolCall: (toolCall: ToolCall) => {
    const agentState = get().agentState
    set({
      agentState: {
        ...agentState,
        toolCalls: [...agentState.toolCalls, toolCall]
      }
    })
  },

  updateAgentToolCall: (id: string, updates: Partial<ToolCall>) => {
    const agentState = get().agentState
    set({
      agentState: {
        ...agentState,
        toolCalls: agentState.toolCalls.map(call =>
          call.id === id ? { ...call, ...updates } : call
        )
      }
    })
  },

  chats: [],
  init: async (tagId: number) => {
    await initChatsDb()
    const data = await getChats(tagId)
    set({ chats: data })
  },
  insert: async (chat) => {
    const res = await insertChat(chat)
    let data: Chat
    if (res.lastInsertId) {
      data =  {
        id: res.lastInsertId,
        createdAt: Date.now(),
        ...chat
      }
      const chats = get().chats
      const newChats = [...chats, data]
      set({ chats: newChats })
      return data
    }
    return null
  },
  updateChat: (chat) => {
    const chats = get().chats
    const newChats = chats.map(item => {
      if (item.id === chat.id) {
        return chat
      }
      return item
    })
    set({ chats: newChats })
  },
  saveChat: async (chat, isSave = false) => {
    get().updateChat(chat)
    if (isSave) {
      await updateChat(chat)
    }
  },
  deleteChat: async (id) => {
    const chats = get().chats
    const newChats = chats.filter(item => item.id !== id)
    set({ chats: newChats })
    await deleteChat(id)
  },


  locale: locales[0],
  getLocale: async () => {
    const store = await Store.load('store.json');
    const res = (await store.get<string>('note_locale')) || locales[0]
    set({ locale: res })
  },
  setLocale: async (locale) => {
    set({ locale })
    const store = await Store.load('store.json');
    await store.set('note_locale', locale)
  },

  clearChats: async (tagId) => {
    set({ chats: [] })
    await clearChatsByTagId(tagId)
  },

  updateInsert: async (id) => {
    await updateChatsInsertedById(id)
    const chats = get().chats
    const newChats = chats.map(item => {
      if (item.id === id) {
        item.inserted = true
      }
      return item
    })
    set({ chats: newChats })
  },
  // MCP 工具调用记录
  mcpToolCalls: [],
  
  addMcpToolCall: (toolCall: McpToolCall) => {
    const mcpToolCalls = get().mcpToolCalls
    set({ mcpToolCalls: [...mcpToolCalls, toolCall] })
  },
  
  updateMcpToolCall: (id: string, updates: Partial<McpToolCall>) => {
    const mcpToolCalls = get().mcpToolCalls.map(call =>
      call.id === id ? { ...call, ...updates } : call
    )
    set({ mcpToolCalls })
  },
  
  getMcpToolCallsByChatId: (chatId: number) => {
    return get().mcpToolCalls.filter(call => call.chatId === chatId)
  },
  
  clearMcpToolCalls: () => {
    set({ mcpToolCalls: [] })
  },
}))

export default useChatStore
