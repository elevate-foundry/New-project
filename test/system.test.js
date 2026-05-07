import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditService } from '../src/audit.js';
import { AuthService } from '../src/auth.js';
import { BBIDService } from '../src/bbid.js';
import { MoneyService } from '../src/money.js';
import { OllamaService } from '../src/ollama.js';
import { ProfileService } from '../src/profiles.js';
import { RaceStore } from '../src/race-store.js';
import { WebhookService } from '../src/webhooks.js';
import { createSystem } from '../src/system.js';

test('auth registers email users and enforces scoped signed sessions', () => {
  const auth = new AuthService({ secret: 'test-secret' });
  const user = auth.register({ identifier: 'Ada@Example.com', password: 'correct horse battery staple', scopes: ['money:write'] });
  const { token } = auth.login({ identifier: 'ada@example.com', password: 'correct horse battery staple' });

  assert.equal(user.email, 'ada@example.com');
  assert.equal(user.primaryIdentifier, 'ada@example.com');
  assert.match(user.bbid, /^⠠⠎⠁⠇_/);
  assert.equal(user.bbidHapticPattern.length, 16);
  assert.equal(auth.authenticate(token, ['money:write']).user.id, user.id);
  assert.throws(() => auth.authenticate(`${token}x`, ['money:write']), /signature is invalid/);
  assert.throws(() => auth.authenticate(token, ['webhooks:write']), /Missing required scope/);
});

test('auth registers and logs in phone users', () => {
  const auth = new AuthService({ secret: 'test-secret' });
  const user = auth.register({ identifier: '(555) 123-4567', password: 'correct horse battery staple' });
  const { token } = auth.login({ phone: '+5551234567', password: 'correct horse battery staple' });

  assert.equal(user.email, null);
  assert.equal(user.phone, '+5551234567');
  assert.equal(auth.authenticate(token).user.primaryIdentifier, '+5551234567');
});

test('money uses idempotent double-entry ledger transactions', () => {
  const money = new MoneyService();
  const ownerId = 'user_1';
  const operating = money.createAccount({ ownerId, currency: 'USD' });
  const reserve = money.createAccount({ ownerId, currency: 'USD' });

  const credit = money.credit({ accountId: operating.id, amount: '5000', idempotencyKey: 'credit-1' });
  const duplicateCredit = money.credit({ accountId: operating.id, amount: '5000', idempotencyKey: 'credit-1' });
  const transfer = money.transfer({
    fromAccountId: operating.id,
    toAccountId: reserve.id,
    amount: '1250',
    idempotencyKey: 'transfer-1'
  });

  assert.equal(credit.id, duplicateCredit.id);
  assert.equal(transfer.entries.length, 2);
  assert.deepEqual(money.listAccounts(ownerId).map((account) => account.balance), ['3750', '1250']);
  assert.throws(() => money.transfer({
    fromAccountId: operating.id,
    toAccountId: reserve.id,
    amount: '999999',
    idempotencyKey: 'too-much'
  }), /insufficient funds/i);
});

test('webhooks sign, verify, dedupe inbound events, and dispatch outbound events', async () => {
  const requests = [];
  const webhooks = new WebhookService({
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 204 };
    }
  });

  const endpoint = webhooks.createEndpoint({
    ownerId: 'user_1',
    url: 'https://example.com/hooks',
    events: ['money.transaction.created']
  });
  const rawBody = JSON.stringify({ hello: 'world' });
  const signature = webhooks.sign(endpoint.secret, rawBody);

  const received = webhooks.receive({
    eventId: 'evt_1',
    eventType: 'example.created',
    rawBody,
    signature,
    secret: endpoint.secret
  });
  const duplicate = webhooks.receive({
    eventId: 'evt_1',
    eventType: 'example.created',
    rawBody,
    signature,
    secret: endpoint.secret
  });
  const deliveries = await webhooks.dispatch('money.transaction.created', { amount: '1000' });

  assert.equal(received.accepted, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(deliveries[0].status, 'delivered');
  assert.equal(requests[0].url, 'https://example.com/hooks');
  assert.match(requests[0].init.headers['x-primitive-signature'], /^t=\d+,v1=/);
});

test('composed system emits money events into webhook dispatch', async () => {
  const dispatched = [];
  const system = createSystem({
    webhooks: {
      fetcher: async (url, init) => {
        dispatched.push({ url, init });
        return { ok: true, status: 200 };
      }
    }
  });
  const user = system.auth.register({ email: 'sam@example.com', password: 'correct horse battery staple' });
  system.webhooks.createEndpoint({
    ownerId: user.id,
    url: 'https://example.com/ledger',
    events: ['money.transaction.created']
  });
  const account = system.money.createAccount({ ownerId: user.id, currency: 'USD' });

  system.money.credit({ accountId: account.id, amount: '42', idempotencyKey: 'seed' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(dispatched.length, 1);
});

test('ollama adapter sends non-streaming chat with primitive context', async () => {
  const requests = [];
  const ollama = new OllamaService({
    host: 'http://ollama.test',
    model: 'llama3.2',
    fetcher: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          model: 'llama3.2',
          message: { role: 'assistant', content: 'Check identity, balance, and idempotency.' },
          done: true
        })
      };
    }
  });

  const answer = await ollama.chat({
    prompt: 'What should I check?',
    context: { primitives: ['auth', 'webhooks', 'money'] }
  });
  const body = JSON.parse(requests[0].init.body);

  assert.equal(requests[0].url, 'http://ollama.test/api/chat');
  assert.equal(body.stream, false);
  assert.equal(body.model, 'llama3.2');
  assert.match(body.messages[0].content, /Your name is Sal/);
  assert.match(body.messages[1].content, /auth/);
  assert.equal(answer.message, 'Check identity, balance, and idempotency.');
});

test('ollama adapter requires a six-model bench and three preferred braid models', async () => {
  const ollama = new OllamaService({
    host: 'http://ollama.test',
    model: 'llama3.2',
    models: 'sal:latest,llama3.2:latest,qwen2.5-coder:latest,missing:latest',
    fetcher: async (url) => {
      if (url.endsWith('/api/version')) {
        return { ok: true, json: async () => ({ version: 'test' }) };
      }
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'sal:latest', size: 1, details: { family: 'llama', parameter_size: '3B' } },
              { name: 'llama3.2:latest', size: 1, details: { family: 'llama', parameter_size: '3B' } },
              { name: 'qwen2.5-coder:latest', size: 1, details: { family: 'qwen2', parameter_size: '7B' } },
              { name: 'gemma3:4b', size: 1, details: { family: 'gemma3', parameter_size: '4B' } },
              { name: 'deepseek-r1:latest', size: 1, details: { family: 'qwen3', parameter_size: '8B' } },
              { name: 'distilled-phi3.5:latest', size: 1, details: { family: 'phi3', parameter_size: '3B' } },
              { name: 'nomic-embed-text:latest', size: 1, details: { family: 'nomic-bert' } }
            ]
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  const status = await ollama.status();

  assert.equal(status.requiredAvailableModels, 6);
  assert.equal(status.minBraidModels, 3);
  assert.equal(status.availableModelCount, 6);
  assert.equal(status.raceModelCount, 3);
  assert.equal(status.braidReady, true);
  assert.deepEqual(status.missingPreferredModels, ['missing:latest']);
});

test('ollama adapter warms preferred model bench and reports per-model lights', async () => {
  const requests = [];
  const ollama = new OllamaService({
    host: 'http://ollama.test',
    models: 'sal:latest,llama3.2:latest,qwen2.5-coder:latest',
    fetcher: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'sal:latest', size: 1, details: { family: 'llama' } },
              { name: 'llama3.2:latest', size: 1, details: { family: 'llama' } },
              { name: 'qwen2.5-coder:latest', size: 1, details: { family: 'qwen2' } }
            ]
          })
        };
      }
      if (url.endsWith('/api/generate')) {
        const body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ response: `I am ${body.model}.`, done: true }) };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  const warm = await ollama.warmBench({ limit: 3, keepAlive: '1m' });
  const inventory = await ollama.modelInventory();

  assert.equal(warm.results.length, 3);
  assert.equal(warm.results.every((result) => result.ok), true);
  assert.equal(inventory.modelHealth.filter((model) => model.warm).length, 3);
  assert.equal(inventory.modelHealth[0].identityResponse, 'I am sal:latest.');
  assert.equal(requests.filter((request) => request.url.endsWith('/api/generate')).length, 3);
});

test('ollama adapter races models and returns timestamped JSON responses', async () => {
  const ollama = new OllamaService({
    host: 'http://ollama.test',
    models: 'sal:latest,llama3.2:latest,qwen2.5-coder:latest',
    fetcher: async (url, init = {}) => {
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          json: async () => ({
            models: [
              { name: 'sal:latest', size: 1, details: { family: 'llama' } },
              { name: 'llama3.2:latest', size: 1, details: { family: 'llama' } },
              { name: 'qwen2.5-coder:latest', size: 1, details: { family: 'qwen2' } }
            ]
          })
        };
      }
      if (url.endsWith('/api/chat')) {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            model: body.model,
            message: { role: 'assistant', content: `${body.model} answer` },
            done: true
          })
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  const race = await ollama.raceChat({ prompt: 'hello', context: {}, limit: 3 });

  assert.equal(race.responses.length, 3);
  assert.equal(race.responses.every((response) => response.startedAt && response.completedAt), true);
  assert.equal(race.responses.every((response) => response.request && response.response), true);
  assert.match(race.braid.message, /answer/);
});

test('bbid service generates BrailleBuddy identities and detects first visits', () => {
  const bbid = new BBIDService({ path: join(mkdtempSync(join(tmpdir(), 'sal-bbid-')), 'visits.json') });
  const identity = bbid.generate({ userId: 'user_1', username: 'ada@example.com' });
  const first = bbid.identify(identity.display);
  const second = bbid.identify(identity.display);

  assert.match(identity.display, /^⠠⠎⠁⠇_/);
  assert.equal(identity.braille.length, 8);
  assert.equal(bbid.verify({ bbid: identity.display, userId: 'user_1', signature: identity.signature }), true);
  assert.equal(first.isFirstVisit, true);
  assert.equal(first.visitCount, 1);
  assert.equal(first.infrastructure, 'BrailleBuddy Identity');
  assert.equal(second.isFirstVisit, false);
  assert.equal(second.visitCount, 2);
});

test('audit service persists append-only hash chained events', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sal-audit-')), 'audit-events.jsonl');
  const audit = new AuditService({ path });

  const first = await audit.append({
    type: 'auth.registered',
    actor: { bbid: 'bbid_device', userId: 'user_1' },
    summary: 'Registered user.',
    metadata: { identifierKind: 'email' }
  });
  const second = await audit.append({
    type: 'money.account_created',
    actor: { bbid: 'bbid_device', userId: 'user_1' },
    summary: 'Created account.',
    metadata: { accountId: 'acct_1' }
  });
  const reloaded = new AuditService({ path });

  assert.equal(second.previousHash, first.hash);
  assert.equal(reloaded.verifyChain(), true);
  assert.deepEqual(reloaded.list({ bbid: 'bbid_device' }).map((event) => event.type), [
    'money.account_created',
    'auth.registered'
  ]);
});

test('race store persists full request response JSON records', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sal-races-')), 'model-races.jsonl');
  const store = new RaceStore({ path });
  await store.append({
    requestId: 'race_1',
    bbid: 'bbid_device',
    prompt: 'hello',
    responses: [
      {
        model: 'sal:latest',
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
        request: { model: 'sal:latest' },
        response: { message: { content: 'hi' } }
      }
    ]
  });

  const races = store.list({ bbid: 'bbid_device' });

  assert.equal(races.length, 1);
  assert.equal(races[0].responses[0].request.model, 'sal:latest');
  assert.equal(races[0].responses[0].response.message.content, 'hi');
});

test('profile service starts a BBID relationship with preferred name', () => {
  const profiles = new ProfileService({ path: join(mkdtempSync(join(tmpdir(), 'sal-profiles-')), 'profiles.json') });
  const profile = profiles.rememberName({ bbid: 'bbid_device', preferredName: 'Ryan' });

  assert.equal(profile.preferredName, 'Ryan');
  assert.equal(profiles.get('bbid_device').relationshipStartedAt, profile.relationshipStartedAt);
  assert.throws(() => profiles.rememberName({ bbid: '', preferredName: 'Ryan' }), /BBID is required/);
});
