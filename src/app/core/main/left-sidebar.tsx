'use client'

import { Files } from "lucide-react"
import { FileSidebar } from "../article/file"
import { FileActions } from "../article/file/file-actions"
import { useTranslations } from "next-intl"

export function LeftSidebar() {
  const t = useTranslations()

  return (
    <div className="w-full h-full flex flex-col">
      <div className="w-full h-12 border-b flex items-center justify-between px-2">
        <div className="flex items-center gap-2 text-sm">
          <Files className="h-4 w-4" />
          <span>{t('navigation.files')}</span>
        </div>
        <FileActions />
      </div>
      <div className="flex-1 overflow-hidden">
        <FileSidebar />
      </div>
    </div>
  )
}
