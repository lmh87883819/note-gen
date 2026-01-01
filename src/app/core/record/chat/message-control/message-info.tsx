import { Button } from "@/components/ui/button"
import { Chat } from "@/db/chats"
import dayjs from "dayjs"
import { Clock } from "lucide-react"
import relativeTime from "dayjs/plugin/relativeTime"

dayjs.extend(relativeTime)

interface MessageInfoProps {
  chat: Chat
}

export function MessageInfo({ chat }: MessageInfoProps) {
  let tokenText: string | null = null
  if (chat.agentHistory) {
    try {
      const parsed = JSON.parse(chat.agentHistory)
      const usage = parsed?.tokenUsage
      const total = Number(usage?.totalTokens ?? usage?.total_tokens ?? 0) || 0
      if (total > 0) {
        const k = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)
        tokenText = `消耗 ${k} tokens`
      }
    } catch {
      tokenText = null
    }
  }

  return (
    <div className='flex items-center gap-1 -translate-x-3'>
      <Button variant={"ghost"} size="sm" disabled>
        <Clock className="size-4 hidden md:inline" />
        {dayjs(chat.createdAt).fromNow()}
        {tokenText ? <span className="ml-2 text-muted-foreground">{tokenText}</span> : null}
      </Button>
    </div>
  )
}
