import { TooltipButton } from "@/components/tooltip-button";
import emitter from "@/lib/emitter";
import useArticleStore from "@/stores/article";
import { Quote } from "lucide-react";
import { useTranslations } from "next-intl";
import Vditor from "vditor";

export default function QuoteToChat({ value }: { editor?: Vditor; value?: string }) {
  const { activeFilePath } = useArticleStore()
  const t = useTranslations('article.editor.toolbar.quote')

  function handleQuote() {
    if (!value?.trim()) return
    if (!activeFilePath) return

    emitter.emit('chat-add-snippet', {
      filePath: activeFilePath,
      snippet: value,
    })
  }

  return (
    <TooltipButton
      icon={<Quote />}
      tooltipText={t('tooltip')}
      onClick={handleQuote}
      disabled={!value?.trim() || !activeFilePath}
    />
  )
}

