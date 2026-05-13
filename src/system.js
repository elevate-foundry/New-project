import { AuditService } from './audit.js';
import { AuthService } from './auth.js';
import { BBIDService } from './bbid.js';
import { CacheService } from './cache.js';
import { ConversationService } from './conversations.js';
// import { GraphService } from './graph.js';
import { MoneyService } from './money.js';
import { ModelRouter } from './model-router.js';
import { OllamaService } from './ollama.js';
import { OpenRouterService } from './openrouter.js';
import { PermissionService } from './permissions.js';
import { ProfileService } from './profiles.js';
import { RaceStore } from './race-store.js';
import { ToolHarness } from './tools.js';
import { WebhookService } from './webhooks.js';

export function createSystem(options = {}) {
  const webhooks = new WebhookService(options.webhooks);
  const cache = new CacheService(options.cache);
  const ollama = new OllamaService(options.ollama);
  const openrouter = new OpenRouterService(options.openrouter);
  const bbid = new BBIDService(options.bbid);
  const audit = new AuditService(options.audit);
  const profiles = new ProfileService(options.profiles);
  const races = new RaceStore(options.races);
  const conversations = new ConversationService(options.conversations);
  // const graph = new GraphService(options.graph);
  const money = new MoneyService({
    ...options.money,
    emit: (eventType, payload) => {
      void webhooks.dispatch(eventType, payload);
    }
  });
  const auth = new AuthService({ ...options.auth, bbid });
  const permissions = new PermissionService({ auth, audit });
  const tools = new ToolHarness({ audit, auth, permissions });
  const modelRouter = new ModelRouter();
  
  // Historical tokens per second tracking
  const tokenSpeedHistory = [];
  const maxHistorySize = 100;
  
  function recordTokenSpeed(speed) {
    if (speed > 0) {
      tokenSpeedHistory.push(speed);
      if (tokenSpeedHistory.length > maxHistorySize) {
        tokenSpeedHistory.shift();
      }
    }
  }
  
  function getAverageTokenSpeed() {
    if (tokenSpeedHistory.length === 0) return 0;
    const sum = tokenSpeedHistory.reduce((a, b) => a + b, 0);
    return sum / tokenSpeedHistory.length;
  }
  
  return {
    audit,
    auth,
    bbid,
    cache,
    conversations,
    // graph,
    money,
    modelRouter,
    ollama,
    openrouter,
    permissions,
    profiles,
    races,
    tools,
    webhooks,
    recordTokenSpeed,
    getAverageTokenSpeed
  };
}
