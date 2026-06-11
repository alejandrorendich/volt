/**
 * @fileoverview Volt SSE Service.
 *
 * Executes a GET request via undici and streams `text/event-stream` responses
 * to the webview via callbacks. Each parsed SSE event is forwarded as an
 * `event:sse-event` message; when the stream ends `event:sse-end` is sent.
 *
 * SSE wire format (RFC):
 *   Lines starting with `data:` accumulate the data field.
 *   Lines starting with `event:` set the event type.
 *   Lines starting with `id:` set the last-event-id.
 *   An empty line dispatches the buffered event.
 *   Lines starting with `:` are comments and are ignored.
 */

import { request as undiciRequest, Agent, ProxyAgent } from 'undici';
import type { SseEvent } from '../../shared/models';
import type { CorrelationId } from '../../shared/protocol';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Callback signatures
// ---------------------------------------------------------------------------

export type SseEventCallback = (event: SseEvent) => void;
export type SseEndCallback = (reason: string) => void;

// ---------------------------------------------------------------------------
// SseService
// ---------------------------------------------------------------------------

export class SseService {
  private readonly output: vscode.OutputChannel;
  /** AbortController keyed by correlationId for cancellation. */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * Start consuming an SSE stream from `url`.
   *
   * The caller is responsible for ensuring `Accept: text/event-stream` is
   * present in `headers`; this service only handles the streaming decode.
   *
   * Returns a promise that resolves when the stream ends or is aborted.
   */
  async stream(
    url: string,
    headers: Record<string, string>,
    correlationId: CorrelationId,
    onEvent: SseEventCallback,
    onEnd: SseEndCallback,
    rejectUnauthorized = true,
  ): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(correlationId, controller);

    this.output.appendLine(`[SseService] Starting SSE stream — ${url}`);

    try {
      const proxyUrl = vscode.workspace.getConfiguration('http').get<string>('proxy') ?? '';
      const proxyStrictSSL = vscode.workspace.getConfiguration('http').get<boolean>('proxyStrictSSL') ?? true;

      let dispatcher: Agent | ProxyAgent;
      if (proxyUrl) {
        dispatcher = new ProxyAgent({
          uri: proxyUrl,
          connect: { rejectUnauthorized: proxyStrictSSL && rejectUnauthorized },
        });
      } else {
        dispatcher = new Agent({
          connect: { rejectUnauthorized },
        });
      }

      const resp = await undiciRequest(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...headers,
        },
        signal: controller.signal,
        dispatcher,
        throwOnError: false,
      } as Parameters<typeof undiciRequest>[1]);

      const contentType = String(resp.headers['content-type'] ?? '');
      if (!contentType.includes('text/event-stream')) {
        onEnd(`Not an SSE stream (Content-Type: ${contentType})`);
        // Drain the body so the connection is properly released
        await resp.body.dump();
        return;
      }

      // Decode the chunked body as UTF-8 text
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // Accumulated current-event fields
      let eventType = '';
      let eventId = '';
      let dataLines: string[] = [];

      const dispatchEvent = (): void => {
        if (dataLines.length === 0) return;
        const sseEvent: SseEvent = {
          ...(eventId ? { id: eventId } : {}),
          ...(eventType ? { event: eventType } : {}),
          data: dataLines.join('\n'),
          timestamp: new Date().toISOString(),
        };
        onEvent(sseEvent);
        // Reset current-event fields (id persists across events per spec)
        eventType = '';
        dataLines = [];
      };

      for await (const chunk of resp.body) {
        // chunk is a Uint8Array from undici
        buffer += decoder.decode(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as Buffer), { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        // Keep the incomplete last fragment in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.replace(/\r$/, ''); // strip optional CR

          if (trimmed === '') {
            // Empty line — dispatch buffered event
            dispatchEvent();
          } else if (trimmed.startsWith(':')) {
            // Comment — ignore
          } else if (trimmed.startsWith('data:')) {
            dataLines.push(trimmed.slice(5).replace(/^ /, ''));
          } else if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice(6).replace(/^ /, '');
          } else if (trimmed.startsWith('id:')) {
            eventId = trimmed.slice(3).replace(/^ /, '');
          }
          // retry: lines are intentionally ignored (no reconnect in V1)
        }
      }

      // Flush any trailing data left in the buffer
      if (buffer.trim() !== '') {
        const lastLine = buffer.replace(/\r$/, '');
        if (lastLine.startsWith('data:')) {
          dataLines.push(lastLine.slice(5).replace(/^ /, ''));
        }
      }
      dispatchEvent(); // flush last partial event if any

      const reason = controller.signal.aborted ? 'Aborted by client' : 'Stream ended by server';
      this.output.appendLine(`[SseService] Stream ended — ${reason}`);
      onEnd(reason);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted;
      const reason = aborted ? 'Aborted by client' : `Error: ${message}`;
      this.output.appendLine(`[SseService] Stream error — ${message}`);
      onEnd(reason);
    } finally {
      this.inFlight.delete(correlationId);
    }
  }

  /**
   * Abort an in-flight SSE stream by correlationId.
   * The `onEnd` callback fires asynchronously with reason "Aborted by client".
   */
  abort(correlationId: CorrelationId): void {
    const controller = this.inFlight.get(correlationId);
    if (controller) {
      this.output.appendLine(`[SseService] Aborting SSE stream — ${correlationId}`);
      controller.abort();
    }
  }

  /** Abort all in-flight SSE streams. */
  dispose(): void {
    for (const [id, controller] of this.inFlight) {
      this.output.appendLine(`[SseService] Aborting SSE stream on dispose — ${id}`);
      controller.abort();
    }
    this.inFlight.clear();
  }
}
