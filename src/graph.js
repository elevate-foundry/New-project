import neo4j from 'neo4j-driver';

export class GraphService {
  constructor({ uri = 'neo4j://localhost:7687', user = 'neo4j', password = 'password123' } = {}) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    this.init();
  }

  async init() {
    const session = this.driver.session();
    try {
      await session.run(`
        CREATE CONSTRAINT IF NOT EXISTS FOR (r:Response) REQUIRE r.id IS UNIQUE
      `);
      await session.run(`
        CREATE CONSTRAINT IF NOT EXISTS FOR (b:Braid) REQUIRE b.id IS UNIQUE
      `);
      await session.run(`
        CREATE INDEX IF NOT EXISTS FOR (r:Response) ON (r.model)
      `);
      await session.run(`
        CREATE INDEX IF NOT EXISTS FOR (b:Braid) ON (b.timestamp)
      `);
    } finally {
      await session.close();
    }
  }

  async storeModelResponse(response) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MERGE (r:Response {id: $id})
        SET r.model = $model,
            r.content = $content,
            r.tokenCount = $tokenCount,
            r.timestamp = $timestamp,
            r.latencyMs = $latencyMs,
            r.tokensPerSecond = $tokensPerSecond
        RETURN r
      `, {
        id: response.id,
        model: response.model,
        content: response.content,
        tokenCount: response.tokenCount,
        timestamp: response.timestamp,
        latencyMs: response.latencyMs,
        tokensPerSecond: response.tokensPerSecond
      });
      return result.records[0].get('r');
    } finally {
      await session.close();
    }
  }

  async storeBraid(braid, componentResponseIds) {
    const session = this.driver.session();
    try {
      // Create or update the braid node
      const braidResult = await session.run(`
        MERGE (b:Braid {id: $id})
        SET b.content = $content,
            b.tokenCount = $tokenCount,
            b.model = $model,
            b.timestamp = $timestamp,
            b.componentCount = $componentCount
        RETURN b
      `, {
        id: braid.id,
        content: braid.content,
        tokenCount: braid.tokenCount,
        model: braid.model,
        timestamp: braid.timestamp,
        componentCount: componentResponseIds.length
      });

      // Create relationships from component responses to the braid
      for (const componentId of componentResponseIds) {
        await session.run(`
          MATCH (r:Response {id: $componentId})
          MATCH (b:Braid {id: $braidId})
          MERGE (r)-[:CONTRIBUTED_TO]->(b)
        `, {
          componentId,
          braidId: braid.id
        });
      }

      return braidResult.records[0].get('b');
    } finally {
      await session.close();
    }
  }

  async getBraidProvenance(braidId) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (b:Braid {id: $id})<-[:CONTRIBUTED_TO]-(r:Response)
        RETURN r
        ORDER BY r.timestamp ASC
      `, { id: braidId });
      
      return result.records.map(record => record.get('r'));
    } finally {
      await session.close();
    }
  }

  async getAllBraids(limit = 50) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (b:Braid)
        RETURN b
        ORDER BY b.timestamp DESC
        LIMIT $limit
      `, { limit });
      
      return result.records.map(record => record.get('b'));
    } finally {
      await session.close();
    }
  }

  async getModelStats(model) {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (r:Response {model: $model})
        RETURN count(r) as responseCount,
               avg(r.tokensPerSecond) as avgTokensPerSecond,
               avg(r.latencyMs) as avgLatencyMs
      `, { model });
      
      if (result.records.length === 0) {
        return null;
      }
      
      const record = result.records[0];
      return {
        responseCount: record.get('responseCount'),
        avgTokensPerSecond: record.get('avgTokensPerSecond'),
        avgLatencyMs: record.get('avgLatencyMs')
      };
    } finally {
      await session.close();
    }
  }

  async close() {
    await this.driver.close();
  }
}
