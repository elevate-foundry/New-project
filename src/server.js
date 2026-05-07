import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { SYSTEM_IDENTITY } from './identity.js';
import { createSystem } from './system.js';

const publicRoot = join(process.cwd(), 'public');

const system = createSystem({
  auth: { secret: process.env.AUTH_SECRET },
  ollama: {
    host: process.env.OLLAMA_HOST,
    model: process.env.OLLAMA_MODEL
  },
  webhooks: undefined,
  money: undefined
});

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return { raw, json: raw ? JSON.parse(raw) : {} };
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value, null, 2));
}

async function sendStatic(response, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(publicRoot, requestedPath));
  if (!filePath.startsWith(publicRoot)) {
    return false;
  }

  try {
    const content = await readFile(filePath);
    const contentTypes = new Map([
      ['.html', 'text/html; charset=utf-8'],
      ['.css', 'text/css; charset=utf-8'],
      ['.js', 'text/javascript; charset=utf-8']
    ]);
    response.writeHead(200, { 'content-type': contentTypes.get(extname(filePath)) ?? 'application/octet-stream' });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

function bearer(request, scopes) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  return system.auth.authenticate(token, scopes);
}

function optionalBearer(request, scopes) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return null;
  }
  return system.auth.authenticate(token, scopes);
}

function safeOptionalBearer(request, scopes) {
  try {
    return optionalBearer(request, scopes);
  } catch {
    return null;
  }
}

function bbid(request) {
  const value = request.headers['x-bbid'] ?? request.headers['x-sal-bbid'];
  return Array.isArray(value) ? value[0] : value;
}

function actor(request, session = null) {
  return {
    bbid: bbid(request) ?? null,
    userId: session?.user?.id ?? null
  };
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'GET' && await sendStatic(response, url.pathname)) {
    return;
  }

  const { raw, json } = await readBody(request);

  if (request.method === 'GET' && url.pathname === '/health') {
    return send(response, 200, {
      ok: true,
      identity: SYSTEM_IDENTITY,
      bbid: system.bbid.identify(bbid(request))
    });
  }

  if (request.method === 'GET' && url.pathname === '/identity') {
    return send(response, 200, SYSTEM_IDENTITY);
  }

  if (request.method === 'GET' && (url.pathname === '/bbid/me' || url.pathname === '/visits/me')) {
    return send(response, 200, system.bbid.identify(bbid(request)));
  }

  if (request.method === 'GET' && url.pathname === '/profile/me') {
    return send(response, 200, system.profiles.get(bbid(request)));
  }

  if (request.method === 'POST' && url.pathname === '/profile/name') {
    const profile = system.profiles.rememberName({ bbid: bbid(request), preferredName: json.preferredName });
    await system.audit.append({
      type: 'profile.name_remembered',
      actor: actor(request),
      summary: `Started relationship with ${profile.preferredName}.`,
      metadata: { preferredName: profile.preferredName }
    });
    return send(response, 200, profile);
  }

  if (request.method === 'GET' && url.pathname === '/ai/status') {
    return send(response, 200, await system.ollama.status());
  }

  if (request.method === 'GET' && url.pathname === '/ai/bench') {
    return send(response, 200, await system.ollama.modelInventory());
  }

  if (request.method === 'POST' && url.pathname === '/ai/warm') {
    const warm = await system.ollama.warmBench();
    await system.audit.append({
      type: 'ai.bench_warmed',
      actor: actor(request),
      summary: `Warmed ${warm.results.filter((result) => result.ok).length}/${warm.results.length} local models.`,
      metadata: {
        keepAlive: warm.keepAlive,
        models: warm.results.map((result) => ({
          name: result.name,
          ok: result.ok,
          latencyMs: result.latencyMs,
          error: result.error
        }))
      }
    });
    return send(response, 200, warm);
  }

  if (request.method === 'GET' && url.pathname === '/audit/events') {
    const session = safeOptionalBearer(request, ['auth:read']);
    return send(response, 200, {
      chainValid: system.audit.verifyChain(),
      events: system.audit.list({
        bbid: bbid(request),
        userId: session?.user?.id,
        limit: Number(url.searchParams.get('limit') ?? 50)
      })
    });
  }

  if (request.method === 'POST' && url.pathname === '/auth/register') {
    const user = system.auth.register(json);
    const login = system.auth.login(json);
    await system.audit.append({
      type: 'auth.registered',
      actor: { ...actor(request), userId: user.id },
      summary: `Registered ${user.primaryIdentifier}.`,
      metadata: {
        identifierKind: user.identifierKind,
        userBbid: user.bbid
      }
    });
    return send(response, 201, { user, token: login.token });
  }

  if (request.method === 'POST' && url.pathname === '/auth/login') {
    const login = system.auth.login(json);
    await system.audit.append({
      type: 'auth.logged_in',
      actor: { ...actor(request), userId: login.user.id },
      summary: `Logged in ${login.user.primaryIdentifier}.`,
      metadata: { identifierKind: login.user.identifierKind }
    });
    return send(response, 200, login);
  }

  if (request.method === 'POST' && url.pathname === '/money/accounts') {
    const session = bearer(request, ['money:write']);
    const account = system.money.createAccount({ ownerId: session.user.id, currency: json.currency });
    await system.audit.append({
      type: 'money.account_created',
      actor: actor(request, session),
      summary: `Created ${account.currency} account.`,
      metadata: { accountId: account.id, currency: account.currency }
    });
    return send(response, 201, account);
  }

  if (request.method === 'GET' && url.pathname === '/money/accounts') {
    const session = bearer(request, ['money:write']);
    return send(response, 200, { accounts: system.money.listAccounts(session.user.id) });
  }

  if (request.method === 'POST' && url.pathname === '/money/credit') {
    const session = bearer(request, ['money:write']);
    const transaction = system.money.credit(json);
    await system.audit.append({
      type: 'money.transaction_created',
      actor: actor(request, session),
      summary: `Recorded credit transaction ${transaction.id}.`,
      metadata: {
        transactionId: transaction.id,
        idempotencyKey: json.idempotencyKey,
        entries: transaction.entries.map((entry) => ({
          accountId: entry.accountId,
          direction: entry.direction,
          amount: entry.amount,
          currency: entry.currency
        }))
      }
    });
    return send(response, 201, transaction);
  }

  if (request.method === 'POST' && url.pathname === '/money/transfers') {
    const session = bearer(request, ['money:write']);
    const transaction = system.money.transfer(json);
    await system.audit.append({
      type: 'money.transaction_created',
      actor: actor(request, session),
      summary: `Recorded transfer transaction ${transaction.id}.`,
      metadata: {
        transactionId: transaction.id,
        idempotencyKey: json.idempotencyKey,
        entries: transaction.entries
      }
    });
    return send(response, 201, transaction);
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/endpoints') {
    const session = bearer(request, ['webhooks:write']);
    const endpoint = system.webhooks.createEndpoint({ ...json, ownerId: session.user.id });
    await system.audit.append({
      type: 'webhook.endpoint_registered',
      actor: actor(request, session),
      summary: `Registered webhook endpoint ${endpoint.id}.`,
      metadata: {
        endpointId: endpoint.id,
        url: endpoint.url,
        events: endpoint.events
      }
    });
    return send(response, 201, endpoint);
  }

  if (request.method === 'POST' && url.pathname === '/webhooks/inbound') {
    const received = system.webhooks.receive({
      eventId: request.headers['x-primitive-event-id'],
      eventType: request.headers['x-primitive-event-type'],
      rawBody: raw,
      signature: request.headers['x-primitive-signature'],
      secret: process.env.INBOUND_WEBHOOK_SECRET
    });
    await system.audit.append({
      type: 'webhook.inbound_received',
      actor: actor(request),
      summary: `Received inbound webhook ${received.event.id}.`,
      metadata: {
        eventId: received.event.id,
        eventType: received.event.type,
        duplicate: received.duplicate
      }
    });
    return send(response, 202, received);
  }

  if (request.method === 'POST' && url.pathname === '/ai/stream') {
    const session = optionalBearer(request, ['auth:read']);
    const bbidValue = bbid(request);
    
    // Store user message in conversations (before writing headers to prevent header errors)
    try {
      system.conversations.addMessage(bbidValue, {
        role: 'user',
        content: json.prompt,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Failed to store user message:', error);
    }
    
    // Add conversation history to context (before writing headers)
    let conversationContext = '';
    try {
      conversationContext = system.conversations.getContextForPrompt(bbidValue, 10);
    } catch (error) {
      console.error('Failed to get conversation context:', error);
    }
    
    const context = {
      user: session?.user ?? null,
      bbid: system.bbid.identify(bbid(request)),
      profile: system.profiles.get(bbid(request)),
      accounts: session ? system.money.listAccounts(session.user.id) : [],
      system: SYSTEM_IDENTITY,
      primitives: ['auth', 'webhooks', 'money'],
      conversationHistory: conversationContext
    };
    const hasRelationship = Boolean(context.profile?.preferredName);
    context.relationship = {
      isReturning: hasRelationship || context.bbid?.isFirstVisit === false,
      preferredName: context.profile?.preferredName ?? null,
      visitCount: context.bbid?.visitCount ?? 0,
      instruction: hasRelationship || context.bbid?.isFirstVisit === false
        ? 'This is a returning BBID. Continue the relationship; do not restart from a first-meeting script.'
        : 'This is the first observed visit for this BBID. Ask what to call the user and start the relationship.'
    };

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*'
    });

    const startTime = Date.now();
    const hybrid = json.hybrid === true;
    
    const cachedResponse = system.cache.get(json.prompt);
    if (cachedResponse) {
      const elapsed = Date.now() - startTime;
      const currentSpeed = elapsed > 0 ? (cachedResponse.tokenCount / elapsed) * 1000 : 0;
      
      // Record the cached response speed in history
      system.recordTokenSpeed(currentSpeed);
      
      // Store assistant message for cached responses (wrapped to prevent header errors)
      try {
        system.conversations.addMessage(bbidValue, {
          role: 'assistant',
          content: cachedResponse.message,
          model: cachedResponse.model,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Failed to store cached assistant message:', error);
      }
      
      response.write(`data: ${JSON.stringify({
        done: true,
        fullMessage: cachedResponse.message,
        tokenCount: cachedResponse.tokenCount,
        model: cachedResponse.model,
        tokensPerSecond: system.getAverageTokenSpeed(),
        latencyMs: elapsed,
        cached: true
      })}\n\n`);
      response.end();
      
      if (hybrid) {
        (async () => {
          try {
            const requestId = `hybrid_${randomUUID()}`;
            const ollamaModels = ['llama3.2:latest', 'mistral:latest', 'phi3.5:latest'];
            const openrouterModels = system.openrouter.freeModels.slice(0, 3);
            
            const responses = await Promise.all([
              ...ollamaModels.map((model) => system.ollama.chatWithModel({ model, prompt: json.prompt, context, requestId })),
              ...openrouterModels.map((model) => system.openrouter.chatWithModel({ model, prompt: json.prompt, context, requestId }))
            ]);
            
            const successful = responses.filter((response) => response.ok && response.message);
            const winner = successful.sort((left, right) => right.message.length - left.message.length)[0] ?? responses[0];
            const braid = await system.ollama.braidResponses({ prompt: json.prompt, context, responses, winner });
            
            system.cache.set(json.prompt, {
              message: braid.message,
              tokenCount: braid.message.split(/\s+/).length,
              model: braid.model
            });
          } catch (error) {
            console.error('Async braiding failed:', error.message);
          }
        })();
      }
      return;
    }

    (async () => {
      try {
        const requestId = `stream_${randomUUID()}`;
        let braidStream = null;
        
        // Start the race in background, don't wait
        void (async () => {
          try {
            const ollamaModels = ['llama3.2:latest', 'phi3.5:latest', 'mistral:latest'];
            const responses = await Promise.all(
              ollamaModels.map((model) => system.ollama.chatWithModel({ model, prompt: json.prompt, context, requestId }))
            );
            
            const successful = responses.filter((response) => response.ok && response.message);
            if (successful.length > 0) {
              const winner = successful.sort((left, right) => right.message.length - left.message.length)[0];
              braidStream = system.ollama.streamBraidResponses({ prompt: json.prompt, context, responses: successful, winner });
              
              console.log(`[${requestId}] Braid streaming started with ${successful.length} models`);
            }
          } catch (error) {
            console.error(`[${requestId}] Race error:`, error.message);
          }
        })();
        
        // Stream main response immediately
        for await (const chunk of system.ollama.streamChat({
          prompt: json.prompt,
          context
        })) {
          if (chunk.done) {
            const elapsed = Date.now() - startTime;
            const currentSpeed = (chunk.tokenCount / elapsed) * 1000;
            
            // Record the speed in history
            system.recordTokenSpeed(currentSpeed);
            
            system.cache.set(json.prompt, {
              message: chunk.fullMessage,
              tokenCount: chunk.tokenCount,
              model: chunk.model
            });
            
            // Store assistant message in conversations (wrapped to prevent header errors)
            try {
              system.conversations.addMessage(bbidValue, {
                role: 'assistant',
                content: chunk.fullMessage,
                model: chunk.model,
                timestamp: new Date().toISOString()
              });
            } catch (error) {
              console.error('Failed to store assistant message:', error);
            }
            
            response.write(`data: ${JSON.stringify({
              done: true,
              fullMessage: chunk.fullMessage,
              tokenCount: chunk.tokenCount,
              model: chunk.model,
              tokensPerSecond: system.getAverageTokenSpeed(),
              latencyMs: elapsed,
              braided: false,
              braidStarting: !!braidStream
            })}\n\n`);
            
            if (braidStream) {
              try {
                for await (const braidChunk of braidStream) {
                  response.write(`data: ${JSON.stringify({
                    braidToken: braidChunk.token,
                    braidFullMessage: braidChunk.fullMessage,
                    braidDone: braidChunk.done,
                    braidModel: braidChunk.model
                  })}\n\n`);
                  if (response.flush) response.flush();
                  
                  if (braidChunk.done) {
                    system.cache.set(json.prompt, {
                      message: braidChunk.fullMessage,
                      tokenCount: braidChunk.fullMessage.split(/\s+/).length,
                      model: braidChunk.model
                    });
                    break;
                  }
                }
              } catch (braidError) {
                console.error(`[${requestId}] Braid error:`, braidError.message);
              }
            }
            
            response.end();
          } else {
            response.write(`data: ${JSON.stringify({
              token: chunk.token,
              fullMessage: chunk.fullMessage,
              tokenCount: chunk.tokenCount,
              done: false,
              model: chunk.model
            })}\n\n`);
            if (response.flush) response.flush();
          }
        }
      } catch (error) {
        console.error('Stream error:', error);
        response.write(`data: ${JSON.stringify({
          error: error.message,
          done: true
        })}\n\n`);
        response.end();
      }
    })();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/ai/ask') {
    const session = optionalBearer(request, ['auth:read']);
    const context = {
      user: session?.user ?? null,
      bbid: system.bbid.identify(bbid(request)),
      profile: system.profiles.get(bbid(request)),
      accounts: session ? system.money.listAccounts(session.user.id) : [],
      system: SYSTEM_IDENTITY,
      primitives: ['auth', 'webhooks', 'money']
    };
    const hasRelationship = Boolean(context.profile?.preferredName);
    context.relationship = {
      isReturning: hasRelationship || context.bbid?.isFirstVisit === false,
      preferredName: context.profile?.preferredName ?? null,
      visitCount: context.bbid?.visitCount ?? 0,
      instruction: hasRelationship || context.bbid?.isFirstVisit === false
        ? 'This is a returning BBID. Continue the relationship; do not restart from a first-meeting script.'
        : 'This is the first observed visit for this BBID. Ask what to call the user and start the relationship.'
    };
    const fast = json.fast === true;
    const hybrid = json.hybrid === true;
    let race;
    
    if (fast) {
      race = await system.ollama.fastChat({
        prompt: json.prompt,
        context
      });
    } else if (hybrid) {
      const requestId = `hybrid_${randomUUID()}`;
      const startedAt = new Date().toISOString();
      
      const ollamaModels = ['llama3.2:latest', 'mistral:latest', 'phi3.5:latest'];
      const openrouterModels = system.openrouter.freeModels.slice(0, 3);
      const allModels = [...ollamaModels, ...openrouterModels];
      
      const responses = await Promise.all([
        ...ollamaModels.map((model) => system.ollama.chatWithModel({ model, prompt: json.prompt, context, requestId })),
        ...openrouterModels.map((model) => system.openrouter.chatWithModel({ model, prompt: json.prompt, context, requestId }))
      ]);
      
      const completedAt = new Date().toISOString();
      const successful = responses.filter((response) => response.ok && response.message);
      const winner = successful.sort((left, right) => right.message.length - left.message.length)[0] ?? responses[0];
      const braid = await system.ollama.braidResponses({ prompt: json.prompt, context, responses, winner });

      race = {
        requestId,
        startedAt,
        completedAt,
        models: allModels,
        responses,
        winner: winner?.model ?? null,
        braid
      };
    } else {
      race = await system.ollama.raceChat({
        prompt: json.prompt,
        context,
        limit: Number(json.limit ?? system.ollama.minBraidModels)
      });
    }
    
    await system.races.append({
      ...race,
      bbid: bbid(request) ?? null,
      userId: session?.user?.id ?? null,
      prompt: json.prompt,
      context
    });
    await system.audit.append({
      type: 'ai.asked',
      actor: actor(request, session),
      summary: fast 
        ? `Fast response from ${race.braid.model}.`
        : `Asked ${race.responses.length} models; braided with ${race.braid.model}.`,
      metadata: {
        requestId: race.requestId,
        models: race.models,
        winner: race.winner,
        braidModel: race.braid.model,
        promptLength: String(json.prompt ?? '').length,
        answerLength: race.braid.message.length,
        fast,
        responseTimestamps: race.responses.map((response) => ({
          model: response.model,
          startedAt: response.startedAt,
          completedAt: response.completedAt,
          latencyMs: response.latencyMs,
          ok: response.ok
        }))
      }
    });
    return send(response, 200, {
      model: race.braid.model,
      message: race.braid.message,
      done: true,
      race
    });
  }

  if (request.method === 'GET' && url.pathname === '/ai/races') {
    return send(response, 200, {
      races: system.races.list({
        bbid: bbid(request),
        limit: Number(url.searchParams.get('limit') ?? 20)
      })
    });
  }

  return send(response, 404, { error: { code: 'not_found', message: 'Route not found.' } });
}

const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (error instanceof AppError) {
      return send(response, error.status, { error: { code: error.code, message: error.message } });
    }
    return send(response, 500, { error: { code: 'internal_error', message: error.message } });
  });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`Primitive system listening on http://localhost:${port}`);
});

const warmIntervalMs = Number(process.env.SAL_WARM_INTERVAL_MS ?? 4 * 60 * 1000);
void system.ollama.warmBench().catch((error) => {
  console.warn(`Initial model warm failed: ${error.message}`);
});
setInterval(() => {
  void system.ollama.warmBench().catch((error) => {
    console.warn(`Model warm failed: ${error.message}`);
  });
}, warmIntervalMs).unref();
