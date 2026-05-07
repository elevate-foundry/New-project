import { assert } from './errors.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ConversationService {
  constructor({ now = () => new Date(), path = join(process.cwd(), 'data', 'conversations.json') } = {}) {
    this.now = now;
    this.path = path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.conversations = this.load();
  }

  load() {
    if (!existsSync(this.path)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      console.error('Failed to load conversations:', error);
      return {};
    }
  }

  save() {
    try {
      writeFileSync(this.path, JSON.stringify(this.conversations, null, 2));
    } catch (error) {
      console.error('Failed to save conversations:', error);
    }
  }

  getConversationKey(bbid) {
    return bbid || 'anonymous';
  }

  getMessages(bbid, limit = 50) {
    const key = this.getConversationKey(bbid);
    const conversation = this.conversations[key] || { messages: [] };
    return conversation.messages.slice(-limit);
  }

  addMessage(bbid, message) {
    const key = this.getConversationKey(bbid);
    
    if (!this.conversations[key]) {
      this.conversations[key] = {
        bbid,
        startedAt: this.now().toISOString(),
        lastUpdatedAt: this.now().toISOString(),
        messageCount: 0,
        messages: []
      };
    }

    const conversation = this.conversations[key];
    const messageRecord = {
      ...message,
      id: `${key}_${Date.now()}_${conversation.messageCount}`,
      timestamp: message.timestamp || this.now().toISOString()
    };

    conversation.messages.push(messageRecord);
    conversation.lastUpdatedAt = messageRecord.timestamp;
    conversation.messageCount = conversation.messages.length;

    this.save();
    return messageRecord;
  }

  getConversationSummary(bbid) {
    const key = this.getConversationKey(bbid);
    const conversation = this.conversations[key];
    
    if (!conversation) {
      return {
        bbid,
        startedAt: null,
        lastUpdatedAt: null,
        messageCount: 0
      };
    }

    return {
      bbid,
      startedAt: conversation.startedAt,
      lastUpdatedAt: conversation.lastUpdatedAt,
      messageCount: conversation.messageCount
    };
  }

  clearConversation(bbid) {
    const key = this.getConversationKey(bbid);
    delete this.conversations[key];
    this.save();
  }

  getAllConversations() {
    return Object.values(this.conversations).map(conv => ({
      bbid: conv.bbid,
      startedAt: conv.startedAt,
      lastUpdatedAt: conv.lastUpdatedAt,
      messageCount: conv.messageCount
    }));
  }

  getContextForPrompt(bbid, maxMessages = 10) {
    const messages = this.getMessages(bbid, maxMessages);
    if (messages.length === 0) {
      return '';
    }

    const summary = this.getConversationSummary(bbid);
    let context = `Conversation history with ${summary.bbid || 'anonymous'}:\n`;
    context += `Started: ${summary.startedAt}\n`;
    context += `Total messages: ${summary.messageCount}\n\n`;
    
    messages.forEach(msg => {
      context += `${msg.role}: ${msg.content}\n`;
    });

    return context;
  }
}
