'use client'

import { useTranslations } from 'next-intl'
import { ChatToolbarSettings } from './chat-toolbar'

export function ToolSettings() {
  const t = useTranslations('settings.general.tools')

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold mb-4">{t('title')}</h3>
      <ChatToolbarSettings />
    </div>
  )
}
