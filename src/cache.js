import { createHash } from 'node:crypto';

export class CacheService {
  constructor({ maxSize = 1000, ttlMs = 3600000 } = {}) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  hash(prompt) {
    return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  }

  set(prompt, response) {
    const key = this.hash(prompt);
    const entry = {
      response,
      timestamp: Date.now(),
      hits: 0
    };
    
    this.cache.set(key, entry);
    
    if (this.cache.size > this.maxSize) {
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) {
        this.cache.delete(oldest[0]);
      }
    }
  }

  get(prompt) {
    const key = this.hash(prompt);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    
    entry.hits++;
    return entry.response;
  }

  clear() {
    this.cache.clear();
  }

  stats() {
    const entries = Array.from(this.cache.values());
    return {
      size: this.cache.size,
      totalHits: entries.reduce((sum, e) => sum + e.hits, 0),
      avgHits: entries.length > 0 ? entries.reduce((sum, e) => sum + e.hits, 0) / entries.length : 0
    };
  }
}
