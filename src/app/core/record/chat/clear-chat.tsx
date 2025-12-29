"use client"
import * as React from "react"
import { Eraser } from "lucide-react"
import { TooltipButton } from "@/components/tooltip-button"
import useChatStore from "@/stores/chat"
import { useTranslations } from 'next-intl'

export function ClearChat() {
  const { clearChats } = useChatStore()
  const t = useTranslations()

  function clearHandler() {
    clearChats()
  }

  return (
    <div>
      <TooltipButton icon={<Eraser />} tooltipText={t('record.chat.input.clearChat')} side="bottom" onClick={clearHandler}/>
    </div>
  )
}
