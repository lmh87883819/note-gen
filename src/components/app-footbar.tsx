'use client'

import { MessageSquare, SquarePen, Settings } from "lucide-react"
import { usePathname, useRouter } from 'next/navigation'
import { cn } from "@/lib/utils"
import { Store } from "@tauri-apps/plugin-store"
import { useTranslations } from 'next-intl'
import { useSidebarStore } from "@/stores/sidebar"


export function AppFootbar() {
  const pathname = usePathname()
  const router = useRouter()
  const { toggleFileSidebar } = useSidebarStore()
  const t = useTranslations()
    
  // 底部导航菜单项
  const items = [
    {
      title: t('navigation.chat'),
      url: "/mobile/chat",
      icon: MessageSquare,
    },
    {
      title: t('navigation.write'),
      url: "/mobile/writing",
      icon: SquarePen,
    },
    {
      title: t('navigation.setting'),
      url: "/mobile/setting",
      icon: Settings,
    },
  ]

  // 处理导航点击事件
  async function menuHandler(item: typeof items[0]) {
    if (pathname === '/core/article' && item.url === '/core/article') {
      toggleFileSidebar()
    } else {
      router.push(item.url)
    }
    const store = await Store.load('store.json')
    store.set('currentPage', item.url)
  }

  return (
    <div className="w-full border-t bg-background h-14">
      <div className="flex h-full items-center justify-around">
        {items.map((item, index) => (
          <button
            key={index}
            onClick={() => menuHandler(item)}
            className={cn(
              "flex flex-col items-center justify-center w-1/4 py-1 transition-colors relative",
              pathname === item.url
                ? "text-primary"
                : "text-muted-foreground hover:text-primary"
            )}
          >
            <item.icon className="h-5 w-5" />
            <span className="text-xs mt-0.5">{item.title}</span>
            {pathname === item.url && (
              <div className="absolute -bottom-1 w-1 h-1 rounded-full bg-primary" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
