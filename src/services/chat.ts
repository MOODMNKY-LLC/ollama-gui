import { computed, ref } from 'vue'
import { Chat, db, Message } from './database'
import { useAI } from './useAI.ts'
import {
  GenerateCompletionCompletedResponse,
  GenerateCompletionPartResponse,
} from './api.ts' // Database Layer

// Database Layer
const dbLayer = {
  async getAllChats() {
    return db.chats.toArray()
  },

  async getChat(chatId: number) {
    return db.chats.get(chatId)
  },

  async getMessages(chatId: number) {
    return db.messages.where('chatId').equals(chatId).toArray()
  },

  async addChat(chat: Chat) {
    return db.chats.add(chat)
  },

  async updateChat(chatId: number, updates: Partial<Chat>) {
    return db.chats.update(chatId, updates)
  },

  async addMessage(message: Message) {
    return db.messages.add(message)
  },

  async updateMessage(messageId: number, updates: Partial<Message>) {
    return db.messages.update(messageId, updates)
  },

  async deleteChat(chatId: number) {
    return db.chats.delete(chatId)
  },

  async deleteMessagesOfChat(chatId: number) {
    return db.messages.where('chatId').equals(chatId).delete()
  },

  async clearChats() {
    return db.chats.clear()
  },

  async clearMessages() {
    return db.messages.clear()
  },
}

// State
const chats = ref<Chat[]>([])
const activeChat = ref<Chat | null>(null)
const messages = ref<Message[]>([])
const ongoingAiMessages = ref<Map<number, Message>>(new Map())

export function useChats() {
  const { generate } = useAI()

  // Computed
  const sortedChats = computed(() =>
    [...chats.value].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  )
  const hasActiveChat = computed(() => activeChat.value !== null)
  const hasMessages = computed(() => messages.value.length > 0)

  // Methods for state mutations
  const setActiveChat = (chat: Chat) => {
    activeChat.value = chat
  }

  const setMessages = (msgs: Message[]) => {
    messages.value = msgs
  }

  const initialize = async () => {
    try {
      chats.value = await dbLayer.getAllChats()
      if (chats.value.length > 0) {
        await switchChat(sortedChats.value[0].id!)
      } else {
        await startNewChat('New chat', 'n/a')
      }
    } catch (error) {
      console.error('Failed to initialize chats:', error)
    }
  }

  const switchChat = async (chatId: number) => {
    try {
      const chat = await dbLayer.getChat(chatId)
      if (chat) {
        setActiveChat(chat)
        const chatMessages = await dbLayer.getMessages(chatId)
        setMessages(chatMessages)
      }
    } catch (error) {
      console.error(`Failed to switch to chat with ID ${chatId}:`, error)
    }
  }

  const switchModel = async (model: string) => {
    if (!activeChat.value || hasMessages.value) return

    try {
      await dbLayer.updateChat(activeChat.value.id!, { model })
      activeChat.value.model = model // Update the local state
    } catch (error) {
      console.error(
        `Failed to switch model to ${model} for chat with ID ${activeChat.value.id!}:`,
        error,
      )
    }
  }

  const startNewChat = async (name: string, model: string) => {
    const newChat: Chat = {
      name,
      model,
      createdAt: new Date(),
    }

    try {
      newChat.id = await dbLayer.addChat(newChat)
      chats.value.push(newChat)
      setActiveChat(newChat)
      setMessages([])
    } catch (error) {
      console.error('Failed to start a new chat:', error)
    }
  }

  const addSystemMessage = async (content: string, meta?: any) => {
    if (!activeChat.value) return

    const message: Message = {
      chatId: activeChat.value.id!,
      role: 'system',
      content,
      meta,
      createdAt: new Date(),
    }

    try {
      await dbLayer.addMessage(message)
      messages.value.push(message)
    } catch (error) {
      console.error('Failed to add system message:', error)
    }
  }

  const addUserMessage = async (content: string) => {
    if (!activeChat.value) {
      console.warn('There was no active chat.')
      return
    }

    try {
      const currentChatId = activeChat.value.id!
      setMessages(await dbLayer.getMessages(currentChatId))

      const message: Message = {
        chatId: activeChat.value.id!,
        role: 'user',
        content,
        createdAt: new Date(),
      }

      message.id = await dbLayer.addMessage(message)
      messages.value.push(message)

      const lastMessageWithContext = messages.value
        .slice()
        .reverse()
        .find((msg) => msg.context)

      console.log('context', lastMessageWithContext?.context)
      console.log(lastMessageWithContext)

      await generate(
        activeChat.value.model,
        content,
        lastMessageWithContext?.context,
        (data) => handleAiPartialResponse(data, currentChatId),
        (data) => handleAiCompletion(data, currentChatId),
      )
    } catch (error) {
      console.error('Failed to add user message:', error)
    }
  }

  const handleAiPartialResponse = (
    data: GenerateCompletionPartResponse,
    chatId: number,
  ) => {
    ongoingAiMessages.value.has(chatId)
      ? appendToAiMessage(data.response, chatId)
      : startAiMessage(data.response, chatId)
  }

  const handleAiCompletion = async (
    data: GenerateCompletionCompletedResponse,
    chatId: number,
  ) => {
    const aiMessage = ongoingAiMessages.value.get(chatId)
    if (aiMessage) {
      try {
        await dbLayer.updateMessage(aiMessage.id!, { context: data.context })
        ongoingAiMessages.value.delete(chatId)
        console.log('finalized message', data)
      } catch (error) {
        console.error('Failed to finalize AI message:', error)
      }
    } else {
      console.error('no ongoing message to finalize:')

      debugger
    }
  }

  const wipeDatabase = async () => {
    try {
      await dbLayer.clearChats()
      await dbLayer.clearMessages()

      const model = activeChat.value?.model

      // Reset local state
      chats.value = []
      activeChat.value = null
      messages.value = []
      ongoingAiMessages.value.clear()

      await startNewChat('new chat', model ?? 'none')
    } catch (error) {
      console.error('Failed to wipe the database:', error)
    }
  }

  const deleteChat = async (chatId: number) => {
    try {
      await dbLayer.deleteChat(chatId)
      await dbLayer.deleteMessagesOfChat(chatId)

      chats.value = chats.value.filter((chat) => chat.id !== chatId)

      if (activeChat.value?.id === chatId) {
        if (sortedChats.value.length) {
          await switchChat(sortedChats.value[0].id!)
        } else {
          const fallbackModel = activeChat.value.model ?? 'none'
          await startNewChat('new chat', fallbackModel)
        }
      }
    } catch (error) {
      console.error(`Failed to delete chat with ID ${chatId}:`, error)
    }
  }

  const startAiMessage = async (initialContent: string, chatId: number) => {
    const message: Message = {
      chatId: chatId,
      role: 'assistant',
      content: initialContent,
      createdAt: new Date(),
    }

    try {
      message.id = await dbLayer.addMessage(message)
      ongoingAiMessages.value.set(chatId, message)
      messages.value.push(message)
    } catch (error) {
      console.error('Failed to start AI message:', error)
    }
  }

  const appendToAiMessage = async (content: string, chatId: number) => {
    const aiMessage = ongoingAiMessages.value.get(chatId)
    if (aiMessage) {
      aiMessage.content += content
      try {
        await dbLayer.updateMessage(aiMessage.id!, { content: aiMessage.content })
        setMessages(await dbLayer.getMessages(chatId))
      } catch (error) {
        console.error('Failed to append to AI message:', error)
      }
    } else {
      console.log('No ongoing AI message?')
    }
  }

  return {
    chats,
    sortedChats,
    activeChat,
    messages,
    hasMessages,
    hasActiveChat,
    switchModel,
    startNewChat,
    switchChat,
    deleteChat,
    addUserMessage,
    addSystemMessage,
    initialize,
    wipeDatabase,
  }
}
