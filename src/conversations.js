import { assert } from './errors.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export class ConversationService {
  constructor({ now = () => new Date(), path = join(process.cwd(), 'data', 'conversations.db') } = {}) {
    this.now = now;
    this.path = path;
    mkdirSync(join(this.path, '..'), { recursive: true });
    this.db = new Database(this.path);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        bbid TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        last_updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        bbid TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (bbid) REFERENCES conversations(bbid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_bbid ON messages(bbid);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    `);
  }

  getConversationKey(bbid) {
    return bbid || 'anonymous';
  }

  getMessages(bbid, limit = 50) {
    const key = this.getConversationKey(bbid);
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE bbid = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `);
    return stmt.all(key, -limit);
  }

  addMessage(bbid, message) {
    const key = this.getConversationKey(bbid);
    const now = this.now().toISOString();
    
    // Check if conversation exists
    const convStmt = this.db.prepare('SELECT * FROM conversations WHERE bbid = ?');
    let conversation = convStmt.get(key);
    
    if (!conversation) {
      const insertConvStmt = this.db.prepare(`
        INSERT INTO conversations (bbid, started_at, last_updated_at, message_count)
        VALUES (?, ?, ?, 0)
      `);
      insertConvStmt.run(key, now, now);
      conversation = { bbid: key, started_at: now, last_updated_at: now, message_count: 0 };
    }
    
    // Insert message
    const messageId = `${key}_${Date.now()}_${conversation.message_count}`;
    const insertMsgStmt = this.db.prepare(`
      INSERT INTO messages (id, bbid, role, content, model, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertMsgStmt.run(
      messageId,
      key,
      message.role,
      message.content,
      message.model || null,
      message.timestamp || now
    );
    
    // Update conversation
    const updateConvStmt = this.db.prepare(`
      UPDATE conversations
      SET last_updated_at = ?, message_count = message_count + 1
      WHERE bbid = ?
    `);
    updateConvStmt.run(now, key);
    
    return {
      id: messageId,
      bbid: key,
      role: message.role,
      content: message.content,
      model: message.model,
      timestamp: message.timestamp || now
    };
  }

  getConversationSummary(bbid) {
    const key = this.getConversationKey(bbid);
    const stmt = this.db.prepare('SELECT * FROM conversations WHERE bbid = ?');
    const conversation = stmt.get(key);
    
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
      startedAt: conversation.started_at,
      lastUpdatedAt: conversation.last_updated_at,
      messageCount: conversation.message_count
    };
  }

  clearConversation(bbid) {
    const key = this.getConversationKey(bbid);
    const stmt = this.db.prepare('DELETE FROM conversations WHERE bbid = ?');
    stmt.run(key);
  }

  getAllConversations() {
    const stmt = this.db.prepare('SELECT bbid, started_at, last_updated_at, message_count FROM conversations');
    return stmt.all().map(conv => ({
      bbid: conv.bbid,
      startedAt: conv.started_at,
      lastUpdatedAt: conv.last_updated_at,
      messageCount: conv.message_count
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

  close() {
    this.db.close();
  }
}
