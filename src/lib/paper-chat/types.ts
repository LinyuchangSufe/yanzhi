import type { ChatContext } from "./context-types";
import type { ChatProgress } from "../ai/chat-progress";
export type { ChatContext, ChatContextInput } from "./context-types";
export interface ChatScope {
  attachmentId: string;
  attachmentSha256: string;
  pageIndices: number[];
  totalPages: number;
  characterCount: number;
  truncated: boolean;
  historyMessages: number;
  historyTruncated: boolean;
}
export interface PaperChatMessage {
  literatureSources?: string[];
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  body: string;
  status: "pending" | "completed" | "cancelled" | "failed";
  provider: string;
  model: string;
  scope: ChatScope | null;
  error: string;
  createdAt: string;
  updatedAt: string;
  contexts?: ChatContext[];
  progress?: ChatProgress;
}
export interface PaperChatConversation {
  id: string;
  paperId: string;
  attachmentId: string;
  attachmentSha256: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: PaperChatMessage[];
}
/** Public configuration only; endpoint, data paths, and credentials stay on the server. */
export interface PaperChatConfiguration {
  provider: string;
  model: string;
  configured: boolean;
  remote: boolean;
  credentialConfigured: boolean;
  environmentOverride: boolean;
  message: string;
  preferenceKey: string;
}
export type ChatStreamEvent =
  | { type: "start"; conversationId: string; conversation: PaperChatConversation; userMessage: PaperChatMessage; assistantMessage: PaperChatMessage; scope: ChatScope }
  | { type: "delta"; text: string }
  | { type: "progress"; progress: ChatProgress }
  | { type: "done"; conversationId: string; message: PaperChatMessage }
  | { type: "error"; message: string; status: number; conversationId?: string; messageRecord?: PaperChatMessage };
export type PaperChatScope = ChatScope;
export type PaperChatStreamEvent = ChatStreamEvent;
