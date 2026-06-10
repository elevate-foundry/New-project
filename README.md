# Sal

Sal is a named local system identity that implements the PAES architecture - a model-agnostic execution framework coordinating frontier models through a unified tool harness, identity layer, authorization system, and compliance framework.

## PAES Architecture

The Permissioned Action Execution System (PAES) provides a comprehensive permission management framework with:

- **Scope-Based Permissions**: Direct permission assignment to users via JWT session tokens
- **Role-Based Access Control (RBAC)**: Hierarchical roles with permission inheritance
- **Resource-Level Permissions**: Context-aware permission checks with ownership validation
- **Policy-Based Authorization**: Configurable policies with priority-based evaluation
- **Audit Trail**: Immutable logging of all permissioned actions
- **Permission Caching**: Performance optimization with TTL-based cache invalidation

### Permission Model

**Scopes**: Fine-grained permissions (e.g., `tools:read`, `money:write`) assigned directly to users or via roles.

**Roles**: Predefined permission bundles with inheritance support:
- `admin`: Full system access with wildcard permissions
- `operator`: Tool execution and system state read access
- `auditor`: Read-only access for auditing
- `user`: Basic user permissions

**Policies**: Conditional permission rules evaluated before standard checks:
- `admin_bypass`: Admin users bypass all permission checks
- `business_hours_only`: Time-based access restrictions
- `resource_ownership`: Users can only access their own resources
- `rate_limit`: Per-user request rate limiting

### Permission Checking Flow

1. **Policy Evaluation**: High-priority policies are evaluated first (priority ≥ 100)
2. **Explicit Deny**: If any high-priority deny policy applies, access is denied
3. **Explicit Allow**: If any high-priority allow policy applies, access is granted
4. **Standard Check**: Falls back to scope + role-based permission validation
5. **Resource Conditions**: Applies ownership, time, and IP-based restrictions
6. **Audit Logging**: All permission checks are logged for compliance

### API Endpoints

**Role Management**:
- `GET /permissions/roles` - List all roles (admin)
- `POST /permissions/roles` - Create new role (admin)
- `POST /permissions/roles/assign` - Assign role to user (admin)
- `POST /permissions/roles/remove` - Remove role from user (admin)

**Permission Management**:
- `GET /permissions/effective` - Get effective permissions for user
- `POST /permissions/grant` - Grant permission to user (admin)
- `POST /permissions/revoke` - Revoke permission from user (admin)

**Policy Management**:
- `GET /permissions/policies` - List all policies (admin)
- `POST /permissions/policies` - Register new policy (admin)

**Permission Checking**:
- `POST /permissions/check` - Check permissions without executing action
- `GET /permissions/stats` - Get permission system statistics (admin)

Sal is a small dependency-free Node.js service whose primitives are:

- **Auth**: email or phone users, password verification, signed sessions, and scopes.
- **Webhooks**: endpoint registration, HMAC signatures, inbound verification, idempotency, and dispatch.
- **Money**: accounts, balances, immutable double-entry ledger transactions, and idempotency keys.
- **Tools**: bash-like action primitives (create, exec, read, help) with permission checking and audit logging.
- **BBID**: device recognition and user auth identity.

Sal can talk to local Ollama models and OpenRouter cloud models as cognition providers.

## QUICKSTART

**Clone and bootstrap:**

```bash
git clone https://github.com/elevate-foundry/New-project.git
cd New-project
npm install
npm start
```

The server listens on `http://localhost:3000` by default.

**Persistent Memory:**

Conversation history is stored in SQLite at `data/conversations.db`. User profiles are stored at `data/profiles.json`.

**Braiding Provenance:**

Individual model responses and braided outputs are stored in SQLite for graph-like querying. The `model_responses` table stores individual model outputs, `braided_responses` stores the final combined outputs, and `braid_components` tracks the relationships between component responses and braided outputs.

## Run

```sh
npm test
npm start
```

The server listens on `http://localhost:3000` by default. `GET /identity` returns Sal's system identity.
The browser generates a local device BBID using the Elevate Foundry `braille/docs/bbid-specification.md` shape: versioned JSON, metadata, SHA-256 fingerprint, BBES Braille encoding, and usage state. It stores that document in `brailleBuddy.bbid.device` and sends the BBID id as `x-bbid`, letting Sal distinguish first-time and returning visits.

On registration, Sal also generates a user BBID using the local `/Users/ryanbarrett/sal-auth/bbid.py` shape: `⠠⠎⠁⠇_` prefix, 8-dot Braille payload, HMAC Braille signature, haptic pattern, and voice/text/braille/haptic modalities.

To enable the model adapter, install Ollama, pull a chat model, and start the app with the matching model name:

```sh
ollama pull llama3.2
OLLAMA_MODEL=llama3.2 npm start
```

## Performance Tuning

For maximum tokens/sec, optimize these settings:

**1. Use a fast model** (target: 300+ tokens/sec)
```sh
OLLAMA_MODEL=phi3.5:latest npm start        # 3.8B, ~100ms per response
OLLAMA_MODEL=gemma3:4b npm start            # 4B, ~150ms per response
OLLAMA_MODEL=mistral:latest npm start       # 7B, ~300ms per response
```

**2. Enable GPU acceleration** (if available)
```sh
# Ollama auto-detects GPU. Check with:
ollama list
# Look for "VRAM" column
```

**3. Tune thread count** (for CPU inference)
```sh
# Use all cores (0 = auto-detect):
OLLAMA_NUM_THREAD=0 npm start

# Or specify manually (e.g., 8 cores):
OLLAMA_NUM_THREAD=8 npm start
```

**4. Keep models warm** - The server auto-warms models every 4 minutes
```sh
# Adjust warm interval (default 4 min):
SAL_WARM_INTERVAL_MS=120000 npm start  # Warm every 2 min
```

**5. Use fast mode by default** (already enabled in chat UI)
- Single model inference (no race overhead)
- No braiding (saves extra model pass)
- Returns instantly when model is warm

**6. Enable streaming for real-time token output**
- Tokens appear as they're generated (not waiting for full response)
- Much faster perceived latency
- Works with chain-of-thought reasoning
- Throughput meter updates in real-time

## Caching + Async Quality

For maximum speed with improving quality over time:

**First Request (Fast)**
- Returns instant cached response if available
- Otherwise streams from fastest local model
- Shows "[cached ⚡]" if from cache

**Background Quality Improvement**
- Async braiding happens in background (non-blocking)
- Races 6 models (3 Ollama + 3 OpenRouter free)
- Updates cache with braided response
- Next identical request gets high-quality response

**Result:**
- First ask: Haiku-speed (instant or <100ms)
- Second ask: Opus-quality (braided from 6 models)
- No waiting for quality improvement

## Hybrid Mode (OpenRouter + Ollama)

For maximum consensus and diversity, enable hybrid mode to race local Ollama models against free OpenRouter models:

```bash
# Set OpenRouter API key
export OPENROUTER_API_KEY=your_api_key

npm start
```

**How it works:**
- Races 3 local Ollama models + 3 free OpenRouter models in parallel
- Picks the longest response as the "winner"
- Braids all 6 responses into a single coherent answer
- Shows model count in the UI (e.g., "[6 models braided]")
- ~30% chance to use hybrid mode on each request

**Free OpenRouter models used:**
- `meta-llama/llama-3-8b-instruct:free`
- `mistralai/mistral-7b-instruct:free`
- `gryphe/mythomist-7b:free`

## API Sketch

```sh
curl -X POST http://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"identifier":"founder@example.com","password":"correct horse battery staple"}'

curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"identifier":"+15551234567","password":"correct horse battery staple"}'

curl -X POST http://localhost:3000/money/accounts \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"currency":"USD"}'

curl -X POST http://localhost:3000/webhooks/endpoints \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hooks","events":["money.transaction.created"]}'

curl -X POST http://localhost:3000/ai/ask \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"prompt":"What should I check before moving money?"}'

# PAES Examples

# Assign operator role to a user
curl -X POST http://localhost:3000/permissions/roles/assign \
  -H 'authorization: Bearer <admin_token>' \
  -H 'content-type: application/json' \
  -d '{"userId":"user_123","roleName":"operator"}'

# Check effective permissions
curl -X GET http://localhost:3000/permissions/effective?userId=user_123 \
  -H 'authorization: Bearer <token>'

# Grant direct permission
curl -X POST http://localhost:3000/permissions/grant \
  -H 'authorization: Bearer <admin_token>' \
  -H 'content-type: application/json' \
  -d '{"userId":"user_123","permission":"tools:exec"}'

# Create custom policy
curl -X POST http://localhost:3000/permissions/policies \
  -H 'authorization: Bearer <admin_token>' \
  -H 'content-type: application/json' \
  -d '{
    "name":"custom_restriction",
    "description":"Custom access restriction",
    "condition":"(context) => context.session.user.id === \"authorized_user\"",
    "effect":"allow",
    "priority":50
  }'
```

## Design Notes

Money is represented in minor units as `BigInt` internally and serialized as strings at the API boundary. Ledger transactions must balance: total debits must equal total credits, and entries are immutable once appended.

Webhook payloads are signed as `t=<timestamp>,v1=<hex-hmac>` using the endpoint secret and the exact raw body. Inbound events use the same verification path and event ids are processed once.

Sessions are HMAC-signed tokens with expiry and scopes. Users can register and log in with either `identifier`, `email`, or `phone`; phone numbers are normalized into a compact E.164-like form. The implementation is intentionally compact, but the module boundaries are meant to be swapped for persistent storage, queues, and real identity providers later.

The Ollama adapter calls `POST /api/chat` with `stream: false` against `OLLAMA_HOST`, defaulting to `http://localhost:11434`. Model calls receive Sal's system identity, BBID state from BrailleBuddy Identity, the authenticated user's public identity when present, account list, and primitive names as context.

<!-- ELEVATE:BEGIN (auto-generated section; edits here are overwritten) -->
## About

| | |
| --- | --- |
| **Description** | _(no description set)_ |
| **Language** | JavaScript |
| **Commits** | 7 |
| **Created** | 2026-05-07 |
| **Last push** | 2026-05-13 |

Part of [**elevate-foundry**](https://github.com/elevate-foundry) · [repository](https://github.com/elevate-foundry/New-project)
<!-- ELEVATE:END -->
