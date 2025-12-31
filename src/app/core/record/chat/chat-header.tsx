"use client"

import { McpButton } from "./mcp-button"
import { RagSwitch } from "./rag-switch"
import { ClearContext } from "./clear-context"
import { ClearChat } from "./clear-chat"
import useSettingStore from "@/stores/setting"

// 工具栏分组定义
const TOOLBAR_GROUPS = {
  topLeft: ['mcpButton', 'ragSwitch'],
  topRight: ['clearContext', 'clearChat'],
}

export function ChatHeader() {
  const { chatToolbarConfigPc } = useSettingStore()

  // 渲染工具栏项
  const renderToolbarItem = (id: string) => {
    switch (id) {
      case 'mcpButton':
        return <McpButton key={id} />
      case 'ragSwitch':
        return <RagSwitch key={id} />
      case 'clearContext':
        return <ClearContext key={id} />
      case 'clearChat':
        return <ClearChat key={id} />
      default:
        return null
    }
  }

  // 获取指定分组的工具栏项
  const getToolbarItems = (group: 'topLeft' | 'topRight') => {
    return chatToolbarConfigPc
      .filter(item => TOOLBAR_GROUPS[group].includes(item.id) && item.enabled)
      .sort((a, b) => a.order - b.order)
      .map(item => renderToolbarItem(item.id))
  }

  return (
    <header className="h-12 w-full flex items-center justify-between border-b px-2 gap-2">
      <div className="flex items-center gap-1">{getToolbarItems('topLeft')}</div>
      <div className="flex items-center gap-1">{getToolbarItems('topRight')}</div>
    </header>
  )
}
