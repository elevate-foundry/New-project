import fetch from 'node-fetch';

async function testStream() {
  const response = await fetch('http://localhost:3000/ai/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bbid': 'test-bbid'
    },
    body: JSON.stringify({ prompt: 'Hello, what can you help me with?' })
  });

  const reader = response.body[Symbol.asyncIterator]();
  let buffer = '';
  let messageCount = 0;

  for await (const chunk of reader) {
    const text = chunk.toString('utf8');
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          messageCount++;
          console.log(`Message ${messageCount}:`, {
            token: data.token ? data.token.substring(0, 20) : null,
            done: data.done,
            braidToken: data.braidToken ? data.braidToken.substring(0, 20) : null,
            braidDone: data.braidDone
          });
        } catch (e) {
          console.error('Parse error:', e.message);
        }
      }
    }
  }

  console.log(`Total messages received: ${messageCount}`);
}

testStream().catch(console.error);
