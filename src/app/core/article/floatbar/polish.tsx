import { TooltipButton } from "@/components/tooltip-button";
import emitter from "@/lib/emitter";
import useArticleStore from "@/stores/article";
import useSettingStore from "@/stores/setting";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import Vditor from "vditor";

export default function Polish({ editor, value }: { editor?: Vditor; value?: string }) {
  const { loading } = useArticleStore()
  const { primaryModel } = useSettingStore()
  const t = useTranslations('article.editor.toolbar.polish')

  async function handler() {
    void editor
    if (!value?.trim()) return

    const { activeFilePath } = useArticleStore.getState()
    if (!activeFilePath) return

    emitter.emit('chat-prefill-draft', {
      mode: 'append',
      focus: true,
      snippet: { filePath: activeFilePath, snippet: value },
      text: t('promptTemplate', { content: value }),
    })
    emitter.emit('toolbar-reset-selected-text')
  }

  return (
    <TooltipButton
      disabled={loading || !primaryModel}
      icon={<Sparkles />}
      tooltipText={t('tooltip')}
      onClick={handler}
    />
  )
}
