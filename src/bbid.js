import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BRAILLE_BASE = 0x2800;
export const BBID_PREFIX = '⠠⠎⠁⠇_';

function brailleFromByte(byte) {
  return String.fromCodePoint(BRAILLE_BASE + byte);
}

function rawBraille(display, prefix = BBID_PREFIX) {
  return String(display ?? '').startsWith(prefix)
    ? String(display).slice(prefix.length)
    : String(display ?? '');
}

function hapticPattern(braille) {
  const pattern = [];
  for (const char of braille) {
    const code = char.codePointAt(0) - BRAILLE_BASE;
    const dotCount = code.toString(2).replaceAll('0', '').length;
    pattern.push({
      duration: 50 + dotCount * 20,
      intensity: 0.3 + dotCount * 0.1
    });
    pattern.push({ type: 'pause', duration: 100 });
  }
  return pattern;
}

export class BBIDService {
  constructor({
    now = () => new Date(),
    encryptionKey = process.env.BBID_ENCRYPTION_KEY ?? process.env.SAL_AUTH_BBID_ENCRYPTION_KEY ?? 'bbid-encryption-key-change-me',
    prefix = BBID_PREFIX,
    path = join(process.cwd(), 'data', 'bbid-visits.json')
  } = {}) {
    this.now = now;
    this.encryptionKey = encryptionKey;
    this.prefix = prefix;
    this.path = path;
    mkdirSync(dirname(this.path), { recursive: true });
    this.identities = new Map(Object.entries(this.load()));
  }

  load() {
    if (!existsSync(this.path)) {
      return {};
    }
    return JSON.parse(readFileSync(this.path, 'utf8'));
  }

  save() {
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.identities), null, 2));
  }

  generate({ userId, username }) {
    const seed = `${userId}:${username}:${randomBytes(8).toString('hex')}`;
    const hashBytes = createHash('sha256').update(seed).digest();
    const braille = [...hashBytes.subarray(0, 8)].map(brailleFromByte).join('');
    const createdAt = this.now().toISOString();
    const signature = this.sign({ braille, userId });

    return {
      bbid: `${this.prefix}${braille}`,
      display: `${this.prefix}${braille}`,
      braille,
      userId,
      createdAt,
      signature,
      hapticPattern: hapticPattern(braille),
      modalities: ['voice', 'text', 'braille', 'haptic']
    };
  }

  verify({ bbid, braille, userId, signature }) {
    const candidate = braille ?? rawBraille(bbid, this.prefix);
    if (!candidate || !userId || !signature) {
      return false;
    }
    const expected = this.sign({ braille: candidate, userId });
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  identify(display) {
    if (!display) {
      return {
        bbid: null,
        infrastructure: 'BrailleBuddy Identity',
        isFirstVisit: true,
        visitCount: 0,
        firstSeenAt: null,
        lastSeenAt: null,
        modalities: ['voice', 'text', 'braille', 'haptic']
      };
    }

    const seenAt = this.now().toISOString();
    const existing = this.identities.get(display);
    if (!existing) {
      const identity = {
        bbid: display,
        braille: rawBraille(display, this.prefix),
        infrastructure: 'BrailleBuddy Identity',
        kind: String(display).startsWith(this.prefix) ? 'user' : 'device',
        isFirstVisit: true,
        visitCount: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        modalities: ['voice', 'text', 'braille', 'haptic']
      };
      this.identities.set(display, identity);
      this.save();
      return { ...identity };
    }

    existing.isFirstVisit = false;
    existing.visitCount += 1;
    existing.lastSeenAt = seenAt;
    this.save();
    return { ...existing };
  }

  tokenClaims(identity) {
    return {
      bbid: identity.display,
      bbidRaw: identity.braille,
      bbidSig: identity.signature,
      bbidCreated: identity.createdAt,
      modalities: identity.modalities
    };
  }

  sign({ braille, userId }) {
    const hex = createHmac('sha256', this.encryptionKey)
      .update(`${braille}:${userId}`)
      .digest('hex');
    return Array.from({ length: 8 }, (_, index) => {
      const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      return brailleFromByte(byte);
    }).join('');
  }
}
