import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class RaceStore {
  constructor({ path = join(process.cwd(), 'data', 'model-races.jsonl') } = {}) {
    this.path = path;
    mkdirSync(dirname(this.path), { recursive: true });
  }

  async append(race) {
    await appendFile(this.path, `${JSON.stringify(race)}\n`);
    return race;
  }

  list({ limit = 20, bbid } = {}) {
    if (!existsSync(this.path)) {
      return [];
    }
    return readFileSync(this.path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((race) => !bbid || race.context?.bbid?.bbid === bbid || race.bbid === bbid)
      .slice(-limit)
      .reverse();
  }
}
