"use client"
import { Send, Square } from "lucide-react"
import useSettingStore from "@/stores/setting"
import useChatStore from "@/stores/chat"
import { fetchAiStream } from "@/lib/ai"
import { TooltipButton } from "@/components/tooltip-button"
import { useImperativeHandle, forwardRef, useRef } from "react"
import { useTranslations } from "next-intl"
import { Store } from "@tauri-apps/plugin-store"

interface TranslateSendProps {
  inputValue: string;
  onSent?: () => void;
}

export const TranslateSend = forwardRef<{ sendTranslate: () => void }, TranslateSendProps>(({ inputValue, onSent }, ref) => {
  const { primaryModel } = useSettingStore()
  const { insert, loading, setLoading, saveChat } = useChatStore()
  const abortControllerRef = useRef<AbortController | null>(null)
  const t = useTranslations()

  useImperativeHandle(ref, () => ({
    sendTranslate: handleTranslate
  }))

  // 翻译功能
  async function handleTranslate() {
    if (inputValue === '') return
    onSent?.()
    
    setLoading(true)
    await insert({
      role: 'user',
      content: inputValue,
      type: 'chat',
      inserted: false,
      image: undefined,
    })

    const message = await insert({
      role: 'system',
      content: '',
      type: 'chat',
      inserted: false,
      image: undefined,
    })
    if (!message) return

    // 获取目标语言
    const store = await Store.load('store.json')
    const targetLanguage = await store.get<string>('chatLanguage') || '中文'

    // 翻译请求内容
    const request_content = `Please translate the following text to ${targetLanguage}. Only return the translated text, no explanations or additional content:\n\n${inputValue.trim()}`

    // 先保存空消息，然后通过流式请求更新
    await saveChat({
      ...message,
      content: '',
    }, true)
    
    // 创建新的 AbortController 用于终止请求
    abortControllerRef.current = new AbortController()
    const signal = abortControllerRef.current.signal
    
    // 使用流式方式获取AI结果
    let cache_content = '';
    try {
      await fetchAiStream(request_content, async (content) => {
        cache_content = content
        // 每次收到流式内容时更新消息
        await saveChat({
          ...message,
          content
        }, false)
      }, signal)
    } catch (error: any) {
      // 如果不是中止错误，则记录错误信息
      if (error.name !== 'AbortError') {
        console.error('Stream error:', error)
      }
    } finally {
      abortControllerRef.current = null
      setLoading(false)
      await saveChat({
        ...message,
        content: cache_content
      }, true)
    }
  }

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
  }

  return (
    <TooltipButton 
      variant={loading ? "destructive" : "default"}
      size="sm"
      icon={loading ? <Square className="size-4" /> : <Send className="size-4" />} 
      disabled={!loading && (!primaryModel || !inputValue.trim())} 
      tooltipText={loading ? t('record.chat.input.stop') : t('record.chat.input.modeSelect.translate')} 
      onClick={loading ? handleStop : handleTranslate} 
    />
  )
})

TranslateSend.displayName = 'TranslateSend';
