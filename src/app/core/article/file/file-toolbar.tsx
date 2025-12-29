"use client"
import {
  LoaderCircle,
  BookA,
} from "lucide-react"
import { TooltipButton } from "@/components/tooltip-button"
import { useTranslations } from "next-intl"
import useVectorStore from "@/stores/vector"

export function FileToolbar() {
  const { processAllDocuments, isProcessing, isVectorDbEnabled, setVectorDbEnabled } = useVectorStore()
  const t = useTranslations('article.file.toolbar')


  return (
    <div className="flex items-center h-12 border-b px-2">
      {/* 向量数据库 */}
      <TooltipButton 
        icon={isProcessing ? <LoaderCircle className="animate-spin size-4" /> : <BookA className={isVectorDbEnabled ? "text-primary" : ""} />} 
        tooltipText={isProcessing ? t('processingVectors') : (isVectorDbEnabled ? t('calculateVectors') : t('enableVectorDb'))} 
        onClick={isVectorDbEnabled ? processAllDocuments : () => setVectorDbEnabled(true)}
        disabled={isProcessing} 
      />
    </div>
  )
}
