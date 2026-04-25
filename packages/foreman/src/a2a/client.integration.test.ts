import * as http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DefaultA2AClient } from './client.js';

// ---------------------------------------------------------------------------
// Minimal A2A test server serving only the agent card
// ---------------------------------------------------------------------------

const TEST_AGENT_CARD = {
  name: 'smoke-test-agent',
  url: '', // filled in after server starts
  version: '0.1.0',
  description: 'minimal fixture for smoke testing',
  protocolVersion: '0.3.0',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [{ id: 'test-skill', name: 'Test Skill' }],
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.url === '/.well-known/agent-card.json') {
        const card = { ...TEST_AGENT_CARD, url: baseUrl };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('node:net').AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

// ---------------------------------------------------------------------------
// Smoke test: fetchAgentCard makes a real HTTP request
// ---------------------------------------------------------------------------

describe('DefaultA2AClient integration — fetchAgentCard', () => {
  it('successfully fetches and parses the agent card from a real HTTP server', async () => {
    const client = new DefaultA2AClient();
    const card = await client.fetchAgentCard(baseUrl);

    expect(card.name).toBe('smoke-test-agent');
    expect(card.version).toBe('0.1.0');
    expect(card.description).toBe('minimal fixture for smoke testing');
    expect(card.url).toBe(baseUrl);
    expect(card.skills).toHaveLength(1);
    expect(card.skills![0]).toMatchObject({ id: 'test-skill', name: 'Test Skill' });
  });

  it('throws AgentCardValidationError when server is unreachable', async () => {
    const { AgentCardValidationError } = await import('@foreman-stack/shared');
    const client = new DefaultA2AClient();
    await expect(
      client.fetchAgentCard('http://127.0.0.1:1'),
    ).rejects.toBeInstanceOf(AgentCardValidationError);
  });
});
