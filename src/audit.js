import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { id } from './ids.js';

function hashEvent(event) {
  const stable = {
    id: event.id,
    occurredAt: event.occurredAt,
    type: event.type,
    actor: event.actor,
    summary: event.summary,
    metadata: event.metadata,
    previousHash: event.previousHash
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export class AuditService {
  constructor({ path = join(process.cwd(), 'data', 'audit-events.jsonl'), now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
    mkdirSync(dirname(this.path), { recursive: true });
    this.events = this.load();
    this.lastHash = this.events.at(-1)?.hash ?? null;
  }

  load() {
    if (!existsSync(this.path)) {
      return [];
    }
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  async append({ type, actor = {}, summary, metadata = {} }) {
    const event = {
      id: id('audit'),
      occurredAt: this.now().toISOString(),
      type,
      actor: {
        bbid: actor.bbid ?? null,
        userId: actor.userId ?? null
      },
      summary,
      metadata,
      previousHash: this.lastHash
    };
    event.hash = hashEvent(event);
    this.events.push(event);
    this.lastHash = event.hash;
    await appendFile(this.path, `${JSON.stringify(event)}\n`);
    return event;
  }

  list({ bbid, userId, limit = 50 } = {}) {
    return this.events
      .filter((event) => !bbid || event.actor.bbid === bbid || event.metadata?.bbid === bbid)
      .filter((event) => !userId || event.actor.userId === userId)
      .slice(-limit)
      .reverse();
  }

  verifyChain() {
    let previousHash = null;
    for (const event of this.events) {
      if (event.previousHash !== previousHash || hashEvent(event) !== event.hash) {
        return false;
      }
      previousHash = event.hash;
    }
    return true;
  }

  resetForTests() {
    this.events = [];
    this.lastHash = null;
    writeFileSync(this.path, '');
  }
}
