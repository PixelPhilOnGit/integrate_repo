/**
 * Zustand store for the active conversation and simultaneous-interpretation
 * subtitle state.
 *
 * Manages:
 * - Message history for conversation mode
 * - Subtitle frames for simultaneous mode
 * - Recording pipeline state (idle / recording / recognising / translating / playing)
 * - Current application mode selection
 * - User-facing status message for transient feedback
 *
 * @example
 * ```ts
 * const messages = useConversationStore((s) => s.messages);
 * const { addMessage, setMode } = useConversationStore();
 * ```
 */

import { create } from 'zustand';
import type {
  Message,
  Subtitle,
  RecordingState,
  AppMode,
} from '@/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationActions {
  /**
   * Append a message to the conversation history.
   * `id` and `timestamp` are auto-generated; supply everything else.
   * Returns the generated message id.
   */
  addMessage: (partial: Omit<Message, 'id' | 'timestamp'>) => string;

  /**
   * Update an existing message by ID (e.g. to update translated text
   * after retranslation or to clear an error).
   */
  updateMessage: (id: string, updates: Partial<Message>) => void;

  /** Remove every message from the history. */
  clearMessages: () => void;

  /**
   * Mark the most recent user message for retranslation by clearing its
   * translated text and setting isRetranslated to true. Has no effect when
   * the message list is empty.
   */
  retranslateLast: () => void;

  /** Update the current recording pipeline state. */
  setRecordingState: (state: RecordingState) => void;

  /**
   * Append a subtitle frame for simultaneous mode.
   * `id` and `timestamp` are auto-generated.
   * Returns the generated subtitle id.
   */
  addSubtitle: (partial: Omit<Subtitle, 'id' | 'timestamp'>) => string;

  /** Remove all subtitle frames. */
  clearSubtitles: () => void;

  /**
   * Remove a specific subtitle by ID. Useful for replacing interim
   * subtitles with final versions during simultaneous interpretation.
   */
  removeSubtitle: (id: string) => void;

  /**
   * Update an existing subtitle by ID (e.g. to add translation).
   */
  updateSubtitle: (id: string, updates: Partial<Subtitle>) => void;

  /** Switch the active application mode. */
  setMode: (mode: AppMode) => void;

  /** Set the transient user-facing status message. */
  setStatusMessage: (message: string) => void;

  /** Toggle or set the simultaneous mode listening state. */
  setListening: (listening: boolean) => void;

  /**
   * Return a snapshot of the current subtitles, useful when the user
   * wants to export / copy the simultaneous-interpretation output.
   */
  exportSubtitles: () => Subtitle[];

  /**
   * Export all conversation messages as formatted text suitable for
   * saving to a .txt file.
   */
  exportMessages: () => string;
}

export type ConversationStore = {
  messages: Message[];
  subtitles: Subtitle[];
  recordingState: RecordingState;
  currentMode: AppMode;
  statusMessage: string;
  isListening: boolean;
} & ConversationActions;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique identifier. Uses crypto.randomUUID when available and
 * falls back to a timestamp-based scheme for older environments.
 */
function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 500;
const MAX_SUBTITLES = 200;

export const useConversationStore = create<ConversationStore>()((set, get) => ({
  messages: [],
  subtitles: [],
  recordingState: 'idle' as RecordingState,
  currentMode: 'conversation' as AppMode,
  statusMessage: '',
  isListening: false,

  addMessage: (partial) => {
    const id = generateId();
    const timestamp = Date.now();
    const message: Message = { ...partial, id, timestamp };

    set((state) => {
      const messages = [...state.messages, message];
      // Keep the list bounded to avoid unbounded memory growth
      if (messages.length > MAX_MESSAGES) {
        return { messages: messages.slice(-MAX_MESSAGES) };
      }
      return { messages };
    });

    return id;
  },

  updateMessage: (id, updates) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    }));
  },

  clearMessages: () => {
    set({ messages: [] });
  },

  retranslateLast: () => {
    const { messages } = get();
    if (messages.length === 0) return;

    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];

    // Only retranslate if the message is not already flagged and has
    // content to retranslate
    if (last.isRetranslated) return;

    const updated: Message = {
      ...last,
      translatedText: '',
      isRetranslated: true,
      error: undefined,
    };

    const messagesCopy = [...messages];
    messagesCopy[lastIndex] = updated;
    set({ messages: messagesCopy });
  },

  setRecordingState: (recordingState) => {
    set({ recordingState });
  },

  addSubtitle: (partial) => {
    const id = generateId();
    const timestamp = Date.now();
    const subtitle: Subtitle = { ...partial, id, timestamp };

    set((state) => {
      const subtitles = [...state.subtitles, subtitle];
      if (subtitles.length > MAX_SUBTITLES) {
        return { subtitles: subtitles.slice(-MAX_SUBTITLES) };
      }
      return { subtitles };
    });

    return id;
  },

  clearSubtitles: () => {
    set({ subtitles: [] });
  },

  removeSubtitle: (id: string) => {
    set((state) => ({
      subtitles: state.subtitles.filter((s) => s.id !== id),
    }));
  },

  updateSubtitle: (id: string, updates: Partial<Subtitle>) => {
    set((state) => ({
      subtitles: state.subtitles.map((s) =>
        s.id === id ? { ...s, ...updates } : s,
      ),
    }));
  },

  setMode: (currentMode) => {
    set({ currentMode });
  },

  setStatusMessage: (statusMessage) => {
    set({ statusMessage });
  },

  setListening: (isListening) => {
    set({ isListening });
  },

  exportSubtitles: () => {
    return [...get().subtitles];
  },

  exportMessages: () => {
    const { messages } = get();
    if (messages.length === 0) return '';

    const header = 'Voice Translation — Conversation Export\n';
    const separator = '='.repeat(50) + '\n\n';
    const body = messages
      .map((m) => {
        const time = new Date(m.timestamp).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        });
        return (
          `[${time}]\n` +
          `  Original:  ${m.originalText}\n` +
          `  Translated: ${m.translatedText}\n` +
          (m.error ? `  Error: ${m.error}\n` : '') +
          (m.isRetranslated ? '  (retranslated)\n' : '') +
          '\n'
        );
      })
      .join('');
    return header + separator + body;
  },
}));
