import { assert } from './errors.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export class ProfileService {
  constructor({ now = () => new Date(), path = join(process.cwd(), 'data', 'profiles.json') } = {}) {
    this.now = now;
    this.path = path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.profiles = new Map(Object.entries(this.load()));
  }

  load() {
    if (!existsSync(this.path)) {
      return {};
    }
    return JSON.parse(readFileSync(this.path, 'utf8'));
  }

  save() {
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.profiles), null, 2));
  }

  get(bbid) {
    if (!bbid || !this.profiles.has(bbid)) {
      return { bbid: bbid ?? null, preferredName: null, relationshipStartedAt: null };
    }
    return { ...this.profiles.get(bbid) };
  }

  rememberName({ bbid, preferredName }) {
    assert(bbid, 400, 'missing_bbid', 'BBID is required before Sal can remember your name.');
    const name = String(preferredName ?? '').trim();
    assert(name.length > 0 && name.length <= 80, 400, 'invalid_name', 'Name must be between 1 and 80 characters.');

    const existing = this.profiles.get(bbid);
    const profile = {
      bbid,
      preferredName: name,
      relationshipStartedAt: existing?.relationshipStartedAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString()
    };
    this.profiles.set(bbid, profile);
    this.save();
    return { ...profile };
  }
}
