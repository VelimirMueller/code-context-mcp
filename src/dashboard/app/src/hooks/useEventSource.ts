'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

interface StepProgressData {
  step: string;
  title: string;
  description: string;
  current: number;
  total: number;
  status: 'pending' | 'in_progress' | 'completed' | 'error';
  error?: string;
}

export interface ClaudeOutputChunk {
  text: string;
  type: 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'step' | 'system';
  step?: string;
}

type SSEEvent = {
  type:
    | 'file_changed'
    | 'sprint_updated'
    | 'ticket_updated'
    | 'agent_status'
    | 'updated'
    | 'ping'
    | 'bridge_action'
    | 'input_requested'
    | 'response_ready'
    | 'step_progress'
    | 'claude_output'
    | 'claude_step';
  entityType?: string;
  entityId?: number | string;
  change?: unknown;
  payload?: unknown;
  stepProgress?: StepProgressData;
  claudeOutput?: ClaudeOutputChunk;
  claudeStep?: {
    name: string;
    status: 'pending' | 'in_progress' | 'completed' | 'error';
    title?: string;
    description?: string;
  };
};

export type SSEConnectionState = 'connected' | 'disconnected' | 'reconnecting';

interface UseEventSourceOptions {
  url?: string;
  onEvent?: (event: SSEEvent) => void;
  enabled?: boolean;
}

export function useEventSource({
  url = '/api/events',
  onEvent,
  enabled = true,
}: UseEventSourceOptions = {}) {
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(1000);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [connectionState, setConnectionState] = useState<SSEConnectionState>('disconnected');

  const connect = useCallback(() => {
    if (!enabled) return;

    esRef.current?.close();
    setConnectionState('reconnecting');
    // Same-origin: the browser sends the HttpOnly session cookie (#243).
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      retryDelay.current = 1000;
      setConnectionState('connected');
    };

    es.onmessage = (e: MessageEvent) => {
      const data = e.data as string;

      // Try JSON first (future-proof)
      try {
        const event = JSON.parse(data) as SSEEvent;
        onEventRef.current?.(event);
        return;
      } catch {
        // Not JSON — handle as plain text event
      }

      // Plain text events from server
      if (data === 'updated') {
        onEventRef.current?.({ type: 'file_changed' });
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setConnectionState('disconnected');
      const delay = Math.min(retryDelay.current, 30_000);
      retryDelay.current = Math.min(delay * 2, 30_000);
      retryRef.current = setTimeout(connect, delay);
    };
  }, [url, enabled]);

  useEffect(() => {
    connect();
    return () => {
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);

  return { connectionState };
}
