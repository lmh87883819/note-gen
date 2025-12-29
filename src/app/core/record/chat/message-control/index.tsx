import { Chat } from "@/db/chats"
import useChatStore from "@/stores/chat"
import { XIcon } from "lucide-react"
import { useState } from "react"
import { MessageInfo } from "./message-info"
import { TranslateControl } from "./translate-control"
import { CopyControl } from "./copy-control"
import { TooltipButton } from "@/components/tooltip-button"
import { useTranslations } from 'next-intl';

export default function MessageControl({chat, children}: {chat: Chat, children: React.ReactNode}) {
  const { loading, deleteChat } = useChatStore()
  const [translatedContent, setTranslatedContent] = useState<string>('')
  const t = useTranslations('common')
  
  async function deleteHandler() {
    deleteChat(chat.id)
  }

  if (!loading) {
    return (
      <>
        <div className='flex items-center justify-between mt-2'>

          <MessageInfo chat={chat} />

          <div className='flex items-center'>
            {children || null}

            <CopyControl 
              chat={chat} 
              translatedContent={translatedContent}
            />
            
            <TranslateControl 
              chat={chat} 
              onTranslatedContent={setTranslatedContent}
            />
            
            <TooltipButton icon={<XIcon className='size-4' />} tooltipText={t('delete')} variant={"ghost"} size={"icon"} onClick={deleteHandler}/>
          </div>
        </div>
        
        {/* 显示翻译结果 */}
        {translatedContent && (
          <div className="mt-2 pt-2 border-t border-border">
            <div className="whitespace-pre-wrap">{translatedContent}</div>
          </div>
        )}
      </>
    );
  }
}
