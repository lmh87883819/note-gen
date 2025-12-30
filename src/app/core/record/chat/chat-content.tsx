import useChatStore from "@/stores/chat";
import {
  ArrowDownToLine,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Chat } from "@/db/chats";
import ChatPreview from "./chat-preview";
import "./chat.scss";
import { NoteOutput } from "./message-control/note-output";
import MessageControl from "./message-control";
import ChatEmpty from "./chat-empty";
import { useTranslations } from "next-intl";
import ChatThinking from "./chat-thinking";
import { Separator } from "@/components/ui/separator";
import { cn, scrollToBottom } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RagSources } from "./rag-sources";
import { McpToolCallCard } from "./mcp-tool-call";
import { AgentExecutionStatus } from "./agent-execution-status";
import { AgentHistory } from "./agent-history";

type LinkedFileRef = { path: string; name?: string; relativePath?: string };
type LinkedSnippetRef = { filePath: string; snippet: string };

function parseJsonArray<T>(value?: string): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export default function ChatContent() {
  const { chats, init, agentState } = useChatStore();
  const [isOnBottom, setIsOnBottom] = useState(true);

  function handleScroll() {
    const md = document.querySelector("#chats-wrapper");
    if (!md) return;
    setIsOnBottom(md.scrollHeight - md.scrollTop - md.clientHeight < 1);
  }

  useEffect(() => {
    const md = document.querySelector("#chats-wrapper");
    if (!md) return;
    md.addEventListener("scroll", handleScroll);
    return () => {
      md.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  // 监听消息变化，在底部时自动滚动
  useEffect(() => {
    if (isOnBottom) {
      scrollToBottom();
    }
  }, [chats, isOnBottom]);

  // Agent 执行时自动滚动到底部
  useEffect(() => {
    if (agentState.isRunning) {
      scrollToBottom();
    }
  }, [
    agentState.currentThought,
    agentState.thoughtHistory,
    agentState.pendingConfirmation,
  ]);

  return (
    <div
      id="chats-wrapper"
      className="flex-1 relative overflow-y-auto overflow-x-hidden w-full flex flex-col items-stretch p-3 gap-3"
    >
      {chats.length ? (
        chats.map((chat) => {
          return <Message key={chat.id} chat={chat} />;
        })
      ) : (
        <ChatEmpty />
      )}

      {/* Agent 执行状态 - 在底部实时显示，包裹在 MessageWrapper 中保持布局一致 */}
      <AgentExecutionStatusWrapper />
      {!isOnBottom && (
        <Button
          variant="outline"
          className="sticky bottom-0 size-8 right-0"
          onClick={scrollToBottom}
        >
          <ArrowDownToLine className="size-4" />
        </Button>
      )}
    </div>
  );
}

function MessageWrapper({
  chat,
  children,
}: {
  chat: Chat;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex w-full",
        chat.role === "user" ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "chat-bubble",
          chat.role === "user" ? "chat-bubble-user" : "chat-bubble-agent"
        )}
      >
        <div className="text-[12px] leading-6 break-words">{children}</div>
      </div>
    </div>
  );
}

function AgentExecutionStatusWrapper() {
  const { agentState } = useChatStore();

  // 只在 Agent 运行时显示
  if (!agentState.isRunning) {
    return null;
  }

  return (
    <div className="flex w-full justify-start">
      <div className={cn("chat-bubble", "chat-bubble-agent")}>
        <div className="text-sm leading-6 break-words">
          <AgentExecutionStatus />
        </div>
      </div>
    </div>
  );
}

function Message({ chat }: { chat: Chat }) {
  const t = useTranslations();
  const { deleteChat, getMcpToolCallsByChatId, agentState } = useChatStore();
  const content = chat.content?.includes("thinking")
    ? chat.content.split("<thinking>")[2]
    : chat.content;

  const handleRemoveClearContext = () => {
    deleteChat(chat.id);
  };

  // 解析 RAG 引用的文件名
  const ragSources = chat.ragSources
    ? (() => {
        try {
          return JSON.parse(chat.ragSources) as string[];
        } catch {
          return [];
        }
      })()
    : [];

  // 获取该消息关联的 MCP 工具调用
  const mcpToolCalls = getMcpToolCallsByChatId(chat.id);
  const linkedFiles = parseJsonArray<LinkedFileRef>(chat.linkedFiles);
  const linkedSnippets = parseJsonArray<LinkedSnippetRef>(chat.linkedSnippets);

  // 如果是空内容的 AI 消息且 Agent 正在运行，不显示（避免双头像）
  if (chat.role === "system" && !chat.content && agentState.isRunning) {
    return null;
  }

  switch (chat.type) {
    case "clear":
      return (
        <div className="w-full flex justify-center items-center gap-4 px-10">
          <Separator className="flex-1" />
          <div className="flex justify-center items-center gap-2 w-32 group h-8">
            <p className="text-sm text-center text-muted-foreground">
              {t("record.chat.input.clearContext.tooltip")}
            </p>
            <X
              className="size-4 hidden group-hover:flex cursor-pointer"
              onClick={handleRemoveClearContext}
            />
          </div>
          <Separator className="flex-1" />
        </div>
      );

    case "note":
      return (
        <MessageWrapper chat={chat}>
          {
            <div className="w-full overflow-x-hidden">
              <div className="flex justify-between">
                <p>{t("record.chat.content.organize")}</p>
              </div>
              <ChatThinking chat={chat} />
              {
                <div
                  className={`${
                    content
                      ? "note-wrapper border w-full overflow-y-auto overflow-x-hidden my-2 p-4 rounded-lg"
                      : ""
                  }`}
                >
                  <ChatPreview text={content || ""} />
                </div>
              }
              <MessageControl chat={chat}>
                <NoteOutput chat={chat} />
              </MessageControl>
            </div>
          }
        </MessageWrapper>
      );

    default:
      return (
        <MessageWrapper chat={chat}>
          <div className="w-full">
            {chat.role === "user" &&
              (linkedFiles.length > 0 || linkedSnippets.length > 0) && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {linkedFiles.map((f) => {
                    const label = f.relativePath || f.name || f.path;
                    return (
                      <span
                        key={`file:${f.path}`}
                        className="chat-file-mention"
                        title={f.path}
                      >
                        @{label}
                      </span>
                    );
                  })}
                  {linkedSnippets.map((s, idx) => {
                    const name = (s.filePath.split("/").pop() || s.filePath).trim();
                    const snippet = (s.snippet || "").trim();
                    const clip =
                      snippet.length > 240
                        ? `${snippet.slice(0, 240)}…`
                        : snippet || s.filePath;
                    return (
                      <span
                        key={`snippet:${idx}:${s.filePath}`}
                        className="chat-file-mention chat-snippet-mention"
                        title={clip}
                      >
                        @选区:{name}
                      </span>
                    );
                  })}
                </div>
              )}

            {/* Agent 执行历史 - 显示保存的历史记录 */}
            {chat.role === "system" && chat.agentHistory && (
              <AgentHistory historyJson={chat.agentHistory} />
            )}

            {/* MCP 工具调用展示 */}
            {mcpToolCalls.length > 0 && (
              <div className="space-y-4 mb-4">
                {mcpToolCalls.map((toolCall) => (
                  <McpToolCallCard key={toolCall.id} toolCall={toolCall} />
                ))}
              </div>
            )}
            <ChatThinking chat={chat} />
            <ChatPreview text={content || ""} />
            {chat.role === "system" && <RagSources sources={ragSources} />}
            <MessageControl chat={chat}></MessageControl>
          </div>
        </MessageWrapper>
      );
  }
}
