import { TooltipButton } from "@/components/tooltip-button";
import emitter from "@/lib/emitter";
import useArticleStore from "@/stores/article";
import { SquareCodeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import Vditor from "vditor";

export default function Expansion({ editor, value }: { editor?: Vditor; value?: string }) {
  const t = useTranslations('article.editor.toolbar.expansion')

  async function handleBlock() {
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

  return <TooltipButton icon={<SquareCodeIcon />} tooltipText={t('tooltip')} onClick={handleBlock} />
}

