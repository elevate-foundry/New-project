import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';
import { SYSTEM_IDENTITY } from './identity.js';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export class OllamaService {
  constructor({
    host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    model = process.env.OLLAMA_MODEL ?? 'llama3.2',
    models = process.env.OLLAMA_MODELS,
    requiredAvailableModels = Number(process.env.SAL_REQUIRED_MODELS ?? 6),
    minBraidModels = Number(process.env.SAL_MIN_BRAID_MODELS ?? 3),
    numThread = Number(process.env.OLLAMA_NUM_THREAD ?? 0),
    fetcher = globalThis.fetch
  } = {}) {
    this.host = host.replace(/\/$/, '');
    this.model = model;
    this.requiredAvailableModels = requiredAvailableModels;
    this.minBraidModels = minBraidModels;
    this.numThread = numThread;
    this.raceAllowlist = this.parseModels(models) ?? [
      'sal-braille:latest',
      'sal:latest',
      'braille-fast:latest',
      'multimodal-braille:latest',
      'llama3.2:latest',
      'llama3.2:1b',
      'qwen2.5-coder:latest',
      'gemma3:4b',
      'deepseek-r1:latest',
      'distilled-phi3.5:latest',
      'phi3.5:latest',
      'mistral:latest'
    ];
    this.warmState = new Map();
    this.warmInFlight = null;
    this.fetcher = fetcher;
  }

  parseModels(value) {
    if (!value) {
      return null;
    }
    return String(value)
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean);
  }

  async chat({ prompt, context = {} }) {
    assert(String(prompt ?? '').trim(), 400, 'missing_prompt', 'Prompt is required.');

    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: [
              `Your name is ${SYSTEM_IDENTITY.name}. You are the named local identity of this system.`,
              'You are relationship-centered: if the user profile has a preferredName, address them by it naturally.',
              'If no preferredName is present, ask what you should call the user before getting deep into system work.',
              'You operate through auth, webhooks, and money primitives.',
              'BBID means BrailleBuddy Identity: an 8-dot Braille identity with signature, haptic pattern, and multimodal auth context.',
              'Use bbid.isFirstVisit and bbid.visitCount from context when greeting or orienting the user.',
              'Be concise, operational, and explicit about risks.',
              'Never claim you do not have a name.',
              'Never invent ledger state; use only the provided JSON context.'
            ].join(' ')
          },
          {
            role: 'user',
            content: `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`
          }
        ]
      })
    });

    return {
      model: response.model ?? this.model,
      message: response.message?.content ?? '',
      done: response.done ?? true
    };
  }

  async fastChat({ prompt, context = {} }) {
    assert(String(prompt ?? '').trim(), 400, 'missing_prompt', 'Prompt is required.');
    const requestId = `fast_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const response = await this.chatWithModel({ model: this.model, prompt, context, requestId });
    const completedAt = new Date().toISOString();

    return {
      requestId,
      startedAt,
      completedAt,
      models: [this.model],
      responses: [response],
      winner: response.model,
      braid: {
        model: response.model,
        message: response.message,
        ok: response.ok,
        startedAt: response.startedAt,
        completedAt: response.completedAt,
        latencyMs: response.latencyMs,
        error: response.error ?? null
      }
    };
  }

  async *streamChat({ prompt, context = {} }) {
    assert(String(prompt ?? '').trim(), 400, 'missing_prompt', 'Prompt is required.');
    const requestId = `stream_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const payload = this.chatPayload({ model: this.model, prompt, context });
    
    try {
      // Use non-streaming endpoint for now
      const response = await this.fetcher(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new AppError(response.status, 'ollama_error', 'Ollama chat request failed.');
      }

      const data = await response.json();
      const message = data.message?.content || '';
      const tokenCount = message.split(/\s+/).length;
      const completedAt = new Date().toISOString();
      const latencyMs = Math.round(new Date(startedAt).getTime() - new Date().getTime());
      
      yield {
        token: null,
        fullMessage: message,
        tokenCount,
        done: true,
        model: this.model,
        requestId,
        startedAt,
        completedAt,
        latencyMs,
        tokensPerSecond: (tokenCount / Math.abs(latencyMs)) * 1000
      };
    } catch (error) {
      yield {
        token: null,
        fullMessage: '',
        tokenCount: 0,
        done: true,
        model: this.model,
        requestId,
        error: error.message
      };
    }
  }

  async raceChat({ prompt, context = {}, models = null, limit = this.minBraidModels }) {
    assert(String(prompt ?? '').trim(), 400, 'missing_prompt', 'Prompt is required.');
    const inventory = await this.modelInventory();
    const available = new Set(inventory.availableModels.map((model) => model.name));
    const selected = (models ?? this.raceAllowlist)
      .filter((model) => available.has(model))
      .slice(0, Math.max(limit, this.minBraidModels));

    assert(selected.length >= this.minBraidModels, 503, 'insufficient_models', `At least ${this.minBraidModels} warmed models are required.`);

    const requestId = `race_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const responses = await Promise.all(selected.map((model) => this.chatWithModel({ model, prompt, context, requestId })));
    const completedAt = new Date().toISOString();
    const successful = responses.filter((response) => response.ok && response.message);
    const winner = successful.sort((left, right) => right.message.length - left.message.length)[0] ?? responses[0];
    const braid = await this.braidResponses({ prompt, context, responses, winner });

    return {
      requestId,
      startedAt,
      completedAt,
      models: selected,
      responses,
      winner: winner?.model ?? null,
      braid
    };
  }

  async chatWithModel({ model, prompt, context, requestId }) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const payload = this.chatPayload({ model, prompt, context });
    try {
      const response = await this.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return {
        requestId,
        model,
        ok: true,
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        request: payload,
        response,
        message: response.message?.content ?? ''
      };
    } catch (error) {
      return {
        requestId,
        model,
        ok: false,
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        request: payload,
        response: null,
        message: '',
        error: error.message
      };
    }
  }

  async braidResponses({ prompt, context, responses, winner }) {
    const peerResponses = responses
      .map((response) => `[${response.model}]\n${response.message || response.error || 'No response.'}`)
      .join('\n\n---\n\n');
    const braidPrompt = [
      `Original user prompt: "${prompt}"`,
      '',
      'You are synthesizing multiple AI model responses. CRITICAL: Your output must be ONLY the final answer to the user.',
      '',
      'Model responses:',
      peerResponses,
      '',
      'Instructions:',
      '1. Identify the strongest insights from each response',
      '2. Combine them into a coherent, natural answer',
      '3. Remove redundancy and contradictions',
      '4. Maintain the user\'s tone and address them directly',
      '5. Keep the answer concise but complete',
      '6. DO NOT include phrases like "This response synthesizes...", "Based on the responses...", "The models agree that..."',
      '7. DO NOT explain your synthesis process - just give the answer',
      '',
      'Output ONLY the final answer. No meta-commentary. No preamble. No explanation of how you combined the responses.',
      '',
      'Final answer:'
    ].join('\n');
    const model = winner?.model ?? this.model;
    const braided = await this.chatWithModel({
      model,
      prompt: braidPrompt,
      context: { ...context, braid: true },
      requestId: responses[0]?.requestId ?? `race_${Date.now()}`
    });
    
    // Post-process to strip any remaining meta-commentary
    let cleanedMessage = this.stripMetaCommentary(braided.message);
    
    return {
      model,
      message: cleanedMessage,
      ok: braided.ok,
      startedAt: braided.startedAt,
      completedAt: braided.completedAt,
      latencyMs: braided.latencyMs,
      error: braided.error ?? null
    };
  }

  async *streamBraidResponses({ prompt, context, responses, winner }) {
    const peerResponses = responses
      .map((response) => `[${response.model}]\n${response.message || response.error || 'No response.'}`)
      .join('\n\n---\n\n');
    const braidPrompt = [
      `Original user prompt: "${prompt}"`,
      '',
      'You are synthesizing multiple AI model responses. CRITICAL: Your output must be ONLY the final answer to the user.',
      '',
      'Model responses:',
      peerResponses,
      '',
      'Instructions:',
      '1. Identify the strongest insights from each response',
      '2. Combine them into a coherent, natural answer',
      '3. Remove redundancy and contradictions',
      '4. Maintain the user\'s tone and address them directly',
      '5. Keep the answer concise but complete',
      '6. DO NOT include phrases like "This response synthesizes...", "Based on the responses...", "The models agree that..."',
      '7. DO NOT explain your synthesis process - just give the answer',
      '',
      'Output ONLY the final answer. No meta-commentary. No preamble. No explanation of how you combined the responses.',
      '',
      'Final answer:'
    ].join('\n');
    const model = winner?.model ?? this.model;
    const requestId = responses[0]?.requestId ?? `braid_${Date.now()}`;
    
    const payload = this.chatPayload({ model, prompt: braidPrompt, context: { ...context, braid: true } });
    
    try {
      const response = await this.fetcher(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, stream: true })
      });

      if (!response.ok) {
        throw new AppError(response.status, 'ollama_error', 'Ollama braid request failed.');
      }

      let fullMessage = '';
      let tokenCount = 0;
      const started = performance.now();
      let buffer = '';

      const body = response.body;
      const decoder = new TextDecoder();
      
      if (body) {
        const reader = body.getReader();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const text = decoder.decode(value, { stream: true });
          buffer += text;
          
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.message?.content) {
                const token = data.message.content;
                fullMessage += token;
                tokenCount++;
                
                yield {
                  token,
                  fullMessage,
                  tokenCount,
                  done: data.done ?? false,
                  model,
                  requestId
                };
              }
            } catch {
              // Skip invalid JSON lines
            }
          }
        }
      }

      const completedAt = new Date().toISOString();
      const latencyMs = Math.round(performance.now() - started);
      
      // Post-process to strip meta-commentary from the final message
      const cleanedMessage = this.stripMetaCommentary(fullMessage);
      
      yield {
        token: null,
        fullMessage: cleanedMessage,
        tokenCount,
        done: true,
        model,
        requestId,
        startedAt: new Date().toISOString(),
        completedAt,
        latencyMs,
        tokensPerSecond: (tokenCount / latencyMs) * 1000
      };
    } catch (error) {
      yield {
        token: null,
        fullMessage: '',
        tokenCount: 0,
        done: true,
        model,
        requestId,
        error: error.message
      };
    }
  }

  chatPayload({ model, prompt, context }) {
    return {
      model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: this.systemPrompt()
        },
        {
          role: 'user',
          content: `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`
        }
      ],
      options: {
        num_predict: 512,
        num_ctx: 512, // Further reduced context for speed
        temperature: 0.7,
        top_k: 40,
        top_p: 0.9,
        repeat_penalty: 1.1,
        num_thread: this.numThread === 0 ? 16 : this.numThread, // Increased to 16 threads
        num_batch: 512,
        num_keep: 0
      }
    };
  }

  stripMetaCommentary(message) {
    if (!message) return '';
    
    // Patterns that indicate meta-commentary about synthesis
    const metaPatterns = [
      /^This response synthesizes[\s\S]*?$/m,
      /^Based on the responses[\s\S]*?$/m,
      /^The models agree that[\s\S]*?$/m,
      /^Combining the insights[\s\S]*?$/m,
      /^After reviewing the responses[\s\S]*?$/m,
      /^Synthesizing the above[\s\S]*?$/m,
      /^The braided response[\s\S]*?$/m,
      /^Here is the synthesized[\s\S]*?$/m,
      /^Taking into account[\s\S]*?$/m,
      /^Considering all responses[\s\S]*?$/m,
    ];
    
    let cleaned = message;
    
    // Remove meta-commentary at the start
    for (const pattern of metaPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }
    
    // Remove empty lines at the start
    cleaned = cleaned.replace(/^\s+/, '');
    
    return cleaned;
  }

  systemPrompt() {
    return [
      `You are ${SYSTEM_IDENTITY.name}. Reply quickly and directly.`,
      'Use bbid.isFirstVisit and bbid.visitCount from context when greeting.',
      'If context.bbid.isFirstVisit is true, ask for the user\'s preferred name.',
      'Never invent ledger state; use only the provided JSON context.'
    ].join(' ');
  }

  async status() {
    try {
      const [version, inventory] = await Promise.all([
        this.request('/api/version', { method: 'GET' }),
        this.modelInventory()
      ]);
      return {
        ok: true,
        host: this.host,
        model: this.model,
        version: version.version ?? null,
        ...inventory
      };
    } catch (error) {
      return {
        ok: false,
        host: this.host,
        model: this.model,
        requiredAvailableModels: this.requiredAvailableModels,
        minBraidModels: this.minBraidModels,
        availableModelCount: 0,
        braidReady: false,
        error: error.message
      };
    }
  }

  async modelInventory() {
    const response = await this.request('/api/tags', { method: 'GET' });
    const models = (response.models ?? [])
      .filter((model) => !String(model.name ?? '').includes('embed'))
      .map((model) => ({
        name: model.name,
        size: model.size,
        parameterSize: model.details?.parameter_size ?? null,
        family: model.details?.family ?? null
      }));
    const availableNames = new Set(models.map((model) => model.name));
    const raceModels = this.raceAllowlist.filter((model) => availableNames.has(model));
    const benchModels = this.raceAllowlist.slice(0, Math.max(10, this.requiredAvailableModels));
    const modelHealth = benchModels.map((name) => {
      const warm = this.warmState.get(name);
      return {
        name,
        available: availableNames.has(name),
        warm: Boolean(warm?.ok),
        identityResponse: warm?.identityResponse ?? null,
        lastWarmAt: warm?.lastWarmAt ?? null,
        latencyMs: warm?.latencyMs ?? null,
        error: warm?.error ?? null
      };
    });

    return {
      requiredAvailableModels: this.requiredAvailableModels,
      minBraidModels: this.minBraidModels,
      availableModelCount: models.length,
      availableModels: models,
      raceModels,
      raceModelCount: raceModels.length,
      modelHealth,
      braidReady: models.length >= this.requiredAvailableModels && raceModels.length >= this.minBraidModels,
      missingPreferredModels: this.raceAllowlist.filter((model) => !availableNames.has(model))
    };
  }

  async warmBench({ limit = Math.max(10, this.requiredAvailableModels), keepAlive = '10m' } = {}) {
    if (this.warmInFlight) {
      return this.warmInFlight;
    }

    this.warmInFlight = this.modelInventory()
      .then(async (inventory) => {
        const available = new Set(inventory.availableModels.map((model) => model.name));
        const targets = this.raceAllowlist.filter((model) => available.has(model)).slice(0, limit);
        const results = [];

        for (const model of targets) {
          results.push(await this.warmModel(model, keepAlive));
        }

        return {
          warmedAt: new Date().toISOString(),
          keepAlive,
          requiredAvailableModels: this.requiredAvailableModels,
          minBraidModels: this.minBraidModels,
          results
        };
      })
      .finally(() => {
        this.warmInFlight = null;
      });

    return this.warmInFlight;
  }

  async warmModel(model, keepAlive) {
    const started = performance.now();
    try {
      const response = await this.request('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: 'Who are you? Answer in one short sentence.',
          stream: false,
          keep_alive: keepAlive,
          options: { num_predict: 48 }
        })
      });
      const result = {
        name: model,
        ok: true,
        lastWarmAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        identityResponse: response.response ?? '',
        error: null
      };
      this.warmState.set(model, result);
      return result;
    } catch (error) {
      const result = {
        name: model,
        ok: false,
        lastWarmAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        error: error.message
      };
      this.warmState.set(model, result);
      return result;
    }
  }

  async request(path, init) {
    let response;
    try {
      response = await this.fetcher(`${this.host}${path}`, init);
    } catch (error) {
      throw new AppError(502, 'ollama_unavailable', `Ollama is not reachable at ${this.host}.`);
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }

    if (!response.ok) {
      throw new AppError(response.status, 'ollama_error', body.error ?? 'Ollama request failed.');
    }
    return body;
  }
}
