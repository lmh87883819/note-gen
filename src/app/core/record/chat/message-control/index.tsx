import { Chat } from "@/db/chats"
import useChatStore from "@/stores/chat"
import { XIcon } from "lucide-react"
import { MessageInfo } from "./message-info"
import { CopyControl } from "./copy-control"
import { TooltipButton } from "@/components/tooltip-button"
import { useTranslations } from 'next-intl';

export default function MessageControl({ chat, children }: { chat: Chat; children?: React.ReactNode }) {
  const { loading, deleteChat } = useChatStore()
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
              translatedContent={''}
            />
            
            <TooltipButton icon={<XIcon className='size-4' />} tooltipText={t('delete')} variant={"ghost"} size={"icon"} onClick={deleteHandler}/>
          </div>
        </div>
      </>
    );
  }
}
