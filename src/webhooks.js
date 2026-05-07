import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assert } from './errors.js';
import { id } from './ids.js';

function hmac(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class WebhookService {
  constructor({ now = () => new Date(), fetcher = globalThis.fetch } = {}) {
    this.now = now;
    this.fetcher = fetcher;
    this.endpoints = new Map();
    this.inboundEvents = new Map();
    this.outboundDeliveries = new Map();
  }

  createEndpoint({ ownerId, url, events }) {
    assert(ownerId, 400, 'missing_owner', 'Owner id is required.');
    assert(URL.canParse(url), 400, 'invalid_url', 'Webhook endpoint URL is invalid.');
    assert(Array.isArray(events) && events.length > 0, 400, 'missing_events', 'At least one event type is required.');
    const endpoint = {
      id: id('we'),
      ownerId,
      url,
      events: [...new Set(events)],
      secret: `whsec_${randomBytes(24).toString('hex')}`,
      createdAt: this.now().toISOString()
    };
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  sign(secret, rawBody, timestamp = Math.floor(this.now().getTime() / 1000)) {
    return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${rawBody}`)}`;
  }

  verify({ secret, rawBody, signature, toleranceSeconds = 300 }) {
    const parts = Object.fromEntries(String(signature ?? '').split(',').map((part) => part.split('=')));
    assert(parts.t && parts.v1, 400, 'invalid_signature', 'Webhook signature is malformed.');
    const age = Math.abs(Math.floor(this.now().getTime() / 1000) - Number(parts.t));
    assert(age <= toleranceSeconds, 400, 'stale_signature', 'Webhook signature timestamp is outside tolerance.');
    assert(safeEqual(hmac(secret, `${parts.t}.${rawBody}`), parts.v1), 401, 'invalid_signature', 'Webhook signature does not match.');
    return true;
  }

  receive({ eventId, eventType, rawBody, signature, secret }) {
    assert(eventId, 400, 'missing_event_id', 'Webhook event id is required.');
    if (this.inboundEvents.has(eventId)) {
      return { accepted: false, duplicate: true, event: this.inboundEvents.get(eventId) };
    }
    this.verify({ secret, rawBody, signature });
    const event = {
      id: eventId,
      type: eventType,
      payload: JSON.parse(rawBody),
      receivedAt: this.now().toISOString()
    };
    this.inboundEvents.set(eventId, event);
    return { accepted: true, duplicate: false, event };
  }

  async dispatch(eventType, payload) {
    const deliveries = [];
    for (const endpoint of this.endpoints.values()) {
      if (!endpoint.events.includes(eventType)) {
        continue;
      }
      const rawBody = JSON.stringify({ id: id('evt'), type: eventType, data: payload });
      const delivery = {
        id: id('del'),
        endpointId: endpoint.id,
        eventType,
        signature: this.sign(endpoint.secret, rawBody),
        status: 'pending',
        createdAt: this.now().toISOString()
      };

      try {
        const response = await this.fetcher(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-primitive-signature': delivery.signature
          },
          body: rawBody
        });
        delivery.status = response.ok ? 'delivered' : 'failed';
        delivery.statusCode = response.status;
      } catch (error) {
        delivery.status = 'failed';
        delivery.error = error.message;
      }

      this.outboundDeliveries.set(delivery.id, delivery);
      deliveries.push(delivery);
    }
    return deliveries;
  }

  listDeliveries() {
    return [...this.outboundDeliveries.values()];
  }
}
