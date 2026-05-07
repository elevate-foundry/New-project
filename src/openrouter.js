import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.js';

export class OpenRouterService {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    freeModels = [
      'meta-llama/llama-3-8b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'gryphe/mythomist-7b:free'
    ],
    fetcher = globalThis.fetch
  } = {}) {
    this.apiKey = apiKey;
    this.freeModels = freeModels;
    this.fetcher = fetcher;
  }

  async request(path, options = {}) {
    const url = `https://openrouter.ai/api/v1${path}`;
    const headers = {
      'authorization': `Bearer ${this.apiKey}`,
      'http-referer': 'http://localhost:3000',
      'x-title': 'Sal',
      ...(options.headers || {})
    };
    
    const response = await this.fetcher(url, { ...options, headers });
    const body = await response.json();
    
    if (!response.ok) {
      throw new AppError(response.status, 'openrouter_error', body.error?.message || 'OpenRouter request failed');
    }
    
    return body;
  }

  async chatWithModel({ model, prompt, context, requestId }) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    
    try {
      const response = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: this.systemPrompt(context)
            },
            {
              role: 'user',
              content: `${prompt}\n\nContext:\n${JSON.stringify(context, null, 2)}`
            }
          ],
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 256
        })
      });

      const message = response.choices?.[0]?.message?.content ?? '';
      
      return {
        requestId,
        model,
        ok: true,
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        response,
        message
      };
    } catch (error) {
      return {
        requestId,
        model,
        ok: false,
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        response: null,
        message: '',
        error: error.message
      };
    }
  }

  systemPrompt(context) {
    return [
      'You are Sal, a helpful local AI assistant.',
      'Be concise, operational, and explicit about risks.',
      'If the user has a preferredName in context, address them by it naturally.',
      'Never claim you do not have a name.',
      'Never invent ledger state; use only the provided JSON context.'
    ].join(' ');
  }

  async status() {
    try {
      const response = await this.request('/models');
      const available = response.data
        .filter((model) => this.freeModels.includes(model.id))
        .map((model) => ({
          name: model.id,
          description: model.description
        }));
      
      return {
        ok: true,
        available: available.length,
        models: available
      };
    } catch (error) {
      return {
        ok: false,
        available: 0,
        error: error.message
      };
    }
  }
}
