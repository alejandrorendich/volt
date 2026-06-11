/**
 * @fileoverview SsePanel — streaming event log for text/event-stream responses.
 *
 * Displays SSE events as they arrive from the host, with a Stop button
 * to abort the stream. Events are displayed newest at the bottom, chat-style.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useSseStore } from '../stores/sse-store';
import { useMessage } from '../hooks/useMessage';
import type { CorrelationId } from '../../shared/protocol';
import './SsePanel.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// SsePanel
// ---------------------------------------------------------------------------

interface SsePanelProps {
  /** correlationId of the in-flight SSE request (used to cancel). */
  correlationId: CorrelationId;
}

export function SsePanel({ correlationId }: SsePanelProps): React.ReactElement {
  const status = useSseStore((s) => s.status);
  const events = useSseStore((s) => s.events);
  const endReason = useSseStore((s) => s.endReason);
  const reset = useSseStore((s) => s.reset);

  const { send } = useMessage();
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  const handleStop = useCallback(() => {
    send({
      type: 'request:cancel-http',
      correlationId: `cancel-sse-${Date.now()}`,
      payload: { id: correlationId },
    });
  }, [correlationId, send]);

  const handleClear = useCallback(() => {
    reset();
  }, [reset]);

  const isStreaming = status === 'streaming';

  return (
    <div className="sse-root">
      {/* Toolbar */}
      <div className="sse-toolbar">
        <span
          className={`sse-status-dot${isStreaming ? ' sse-status-dot--active' : ''}`}
          aria-hidden="true"
        />
        <span className="sse-status-label">
          {status === 'streaming' && 'Streaming…'}
          {status === 'ended' && `Stream ended${endReason ? ` — ${endReason}` : ''}`}
          {status === 'idle' && 'Waiting for stream'}
        </span>
        <span className="sse-event-count">
          {events.length} event{events.length !== 1 ? 's' : ''}
        </span>
        {isStreaming && (
          <button
            type="button"
            className="sse-btn sse-btn--stop"
            onClick={handleStop}
            aria-label="Stop SSE stream"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          className="sse-btn sse-btn--clear"
          onClick={handleClear}
          disabled={events.length === 0}
          aria-label="Clear event log"
        >
          Clear
        </button>
      </div>

      {/* Event log */}
      <div className="sse-log" ref={logRef} role="log" aria-live="polite" aria-label="SSE event log">
        {events.length === 0 ? (
          <div className="sse-log__empty">
            {isStreaming ? 'Waiting for events…' : 'No events yet'}
          </div>
        ) : (
          events.map((event, idx) => (
            <div key={`${event.timestamp}-${idx}`} className="sse-event" role="listitem">
              <div className="sse-event__meta">
                {event.id && (
                  <span className="sse-event__id" title="Event ID">id:{event.id}</span>
                )}
                {event.event && (
                  <span className="sse-event__type" title="Event type">{event.event}</span>
                )}
                <span className="sse-event__time">{formatTimestamp(event.timestamp)}</span>
              </div>
              <pre className="sse-event__data">{event.data}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
