import { Bot, NotebookPen, Link } from 'lucide-react'
import { useTranslations } from 'next-intl'

export default function ChatEmpty() {
  const t = useTranslations('record.chat')
  
  const list = [
    {
      content: <p>与 AI 机器人进行<b>聊天</b></p>,
      icon: <Bot className='size-4' />,
      translation: t('empty.features.0.chat')
    },
    {
      content: <p>已与你的记录<b>关联</b></p>,
      icon: <Link className='size-4' />,
      translation: t('empty.features.1.linked')
    },
    {
      content: <p>将你的记录<b>整理</b>为笔记</p>,
      icon: <NotebookPen className='size-4' />,
      translation: t('empty.features.3.organize')
    },
  ]
  return <div className="flex flex-col justify-center items-center flex-1 w-full">
    <Bot className='size-36 opacity-10 mb-4' />
    <div className='flex flex-col gap-4 my-2'>
      {
        list.map((item, index) => {
          return <div key={index} className='border rounded-lg flex items-center gap-2 px-6 py-2 text-sm text-zinc-500 opacity-70'>
            {item.icon}
            <p>{item.translation}</p>
          </div>
        })
      }
    </div>
  </div>
}
