import { readFileSync } from 'node:fs';
import { AgentSideConnection, ndJsonStream, StopReason, Agent } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const scriptPath = process.argv[2];
if (!scriptPath) {
  console.error('Usage: node fake-acp-agent.js <script-path>');
  process.exit(1);
}

const script = JSON.parse(readFileSync(scriptPath, 'utf8'));

const transport = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

const sessionPrompts = new Map<string, number>();

let agentConn: AgentSideConnection | null = null;

const agent: Agent = {
  async initialize() {
    return {
      protocolVersion: 1,
      agentInfo: {
        name: 'fake-acp-agent',
        version: '1.0.0',
      },
      agentCapabilities: {},
    };
  },

  async newSession() {
    return { sessionId: Math.random().toString(36).slice(2) };
  },

  async prompt(params) {
    const sessionId = params.sessionId;
    const promptIndex = sessionPrompts.get(sessionId) || 0;
    sessionPrompts.set(sessionId, promptIndex + 1);

    const actionSequence = script[promptIndex.toString()] || script['default'];
    if (!actionSequence) {
      throw new Error(`No action sequence found for prompt index ${promptIndex} or default`);
    }

    const actions = Array.isArray(actionSequence) ? actionSequence : actionSequence.actions;

    let stopReason: StopReason = 'end_turn';

    for (const action of actions) {
      switch (action.type) {
        case 'agent_message_chunk':
          await agentConn?.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: action.text },
            },
          });
          break;
        case 'permission_request':
          await agentConn?.requestPermission({
            sessionId,
            toolCall: {
                toolCallId: Math.random().toString(36).slice(2),
                kind: 'execute',
                title: 'Permission request',
                rawInput: action.permission,
                status: 'running'
            },
            options: [] // Simplified for now
          });
          break;
        case 'sleep':
          await new Promise((resolve) => setTimeout(resolve, action.ms));
          break;
        case 'stop':
          stopReason = action.reason as StopReason;
          return { stopReason };
      }
    }

    return { stopReason };
  },

  async cancel() {
    // No-op
  },

  async authenticate() {
    return;
  }
};

const conn = new AgentSideConnection((c) => {
  agentConn = c;
  return agent;
}, transport);

conn.closed.catch((err) => {
  console.error('Agent error:', err);
  process.exit(1);
});
