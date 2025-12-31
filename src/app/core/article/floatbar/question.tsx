import { TooltipButton } from "@/components/tooltip-button";
import emitter from "@/lib/emitter";
import useArticleStore from "@/stores/article";
import { MessageCircleQuestion } from "lucide-react";
import { useTranslations } from "next-intl";
import Vditor from "vditor";

export default function Question({ editor, value }: { editor?: Vditor; value?: string }) {
  const t = useTranslations('article.editor.toolbar.question')

  async function handleBlock() {
    void editor
    if (!value?.trim()) return

    const { activeFilePath } = useArticleStore.getState()
    if (!activeFilePath) return

    emitter.emit('chat-prefill-draft', {
      mode: 'append',
      focus: true,
      snippet: { filePath: activeFilePath, snippet: value },
      text: t('promptTemplate', { content: value, question: '（在这里输入你的问题）' }),
    })
    emitter.emit('toolbar-reset-selected-text')
  }

  return <TooltipButton icon={<MessageCircleQuestion />} tooltipText={t('tooltip')} onClick={handleBlock} />
}
