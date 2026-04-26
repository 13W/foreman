import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { getFreePort } from './spawn-proxy.js';
import { registerServer } from './cleanup.js';

export interface AnthropicRequest {
  model: string;
  system?: string;
  messages: any[];
  tools?: any[];
  stream?: boolean;
}

export interface MockAnthropicResponse {
  kind: 'text' | 'tool_use';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  toolId?: string;
}

export interface MockResponseEntry {
  matcher: (req: AnthropicRequest) => boolean;
  response: MockAnthropicResponse;
}

export class MockAnthropicServer {
  private _server: Server | null = null;
  private _requestLog: AnthropicRequest[] = [];
  private _scripts: MockResponseEntry[];
  private _activeConnections = new Set<ServerResponse>();

  constructor(scripts: MockResponseEntry[]) {
    this._scripts = scripts;
  }

  async start(): Promise<{ url: string; port: number }> {
    const port = await getFreePort();
    this._server = createServer((req, res) => this._handleRequest(req, res));
    registerServer(this);
    
    this._server.on('connection', (socket) => {
      socket.on('close', () => {
        // Handle cleanup of active connections if needed
      });
    });

    return new Promise((resolve, reject) => {
      this._server!.listen(port, '127.0.0.1', () => {
        resolve({ url: `http://127.0.0.1:${port}`, port });
      });
      this._server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this._server) return;
    
    for (const res of this._activeConnections) {
      res.end();
    }
    this._activeConnections.clear();

    return new Promise((resolve, reject) => {
      this._server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  getRequestLog(): AnthropicRequest[] {
    return [...this._requestLog];
  }

  private async _handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'POST' && req.url === '/v1/messages') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const anthropicReq = JSON.parse(body) as AnthropicRequest;
          this._requestLog.push(anthropicReq);

          const entry = this._scripts.find((s) => s.matcher(anthropicReq));
          if (!entry) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'No matching scripted response found' }));
            return;
          }

          if (anthropicReq.stream) {
            await this._sendStreamResponse(res, entry.response);
          } else {
            // Non-stream response not required for MVP but good for completeness
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(this._buildNonStreamResponse(entry.response)));
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error('Failed to parse Anthropic request body:', body, 'Error:', errMsg);
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
        }
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
  }

  private _buildNonStreamResponse(response: MockAnthropicResponse) {
    const messageId = `msg_${Math.random().toString(36).slice(2)}`;
    if (response.kind === 'text') {
      return {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: response.text }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 10 }
      };
    } else {
      return {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: response.toolId || `toolu_${Math.random().toString(36).slice(2)}`,
          name: response.toolName,
          input: response.toolInput
        }],
        model: 'mock-model',
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 10 }
      };
    }
  }

  private async _sendStreamResponse(res: ServerResponse, response: MockAnthropicResponse) {
    this._activeConnections.add(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const messageId = `msg_${Math.random().toString(36).slice(2)}`;

    // 1. message_start
    this._writeSSE(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'mock-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 }
      }
    });

    if (response.kind === 'text') {
      // 2. content_block_start (text)
      this._writeSSE(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      });

      // 3. content_block_delta (text)
      this._writeSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: response.text || '' }
      });

      // 4. content_block_stop
      this._writeSSE(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: 0
      });

      // 5. message_delta
      this._writeSSE(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 }
      });
    } else {
      // 2. content_block_start (tool_use)
      const toolId = response.toolId || `toolu_${Math.random().toString(36).slice(2)}`;
      this._writeSSE(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: toolId,
          name: response.toolName,
          input: {}
        }
      });

      // 3. content_block_delta (input_json_delta)
      const inputJson = JSON.stringify(response.toolInput || {});
      this._writeSSE(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson }
      });

      // 4. content_block_stop
      this._writeSSE(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: 0
      });

      // 5. message_delta
      this._writeSSE(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 10 }
      });
    }

    // 6. message_stop
    this._writeSSE(res, 'message_stop', {
      type: 'message_stop'
    });

    res.end();
    this._activeConnections.delete(res);
  }

  private _writeSSE(res: ServerResponse, event: string, data: any) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
