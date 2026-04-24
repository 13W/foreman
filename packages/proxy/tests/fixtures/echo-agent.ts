#!/usr/bin/env node
/**
 * Minimal ACP echo agent for integration tests.
 * Responds to initialize, session/new, session/prompt via stdio JSON-RPC.
 * On session/prompt it sends one tool_call_update notification then returns end_turn.
 */
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = ndJsonStream(input, output);

new AgentSideConnection((conn) => ({
  async initialize(_params) {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
  },

  async newSession(_params) {
    const sessionId = crypto.randomUUID();
    return { sessionId };
  },

  async prompt(params) {
    // Send one tool_call_update notification before responding
    await conn.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'echo-call-1',
        status: 'completed',
        title: 'Echo tool',
      },
    });
    return { stopReason: 'end_turn' };
  },

  async cancel(_params) {},

  async authenticate(_params) {
    return {};
  },
}), stream);
