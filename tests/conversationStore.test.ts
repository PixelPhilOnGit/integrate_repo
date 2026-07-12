import { describe, it, expect, beforeEach } from "vitest";

describe("ConversationStore", () => {
  let useConversationStore: any;

  beforeEach(async () => {
    // Reset Zustand store between tests
    const mod = await import("../src/stores/conversationStore");
    useConversationStore = mod.useConversationStore;
    // Reset store state
    useConversationStore.setState({
      messages: [],
      subtitles: [],
      recordingState: "idle",
      currentMode: "conversation",
      statusMessage: "",
    });
  });

  it("should start with empty messages", () => {
    const state = useConversationStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.subtitles).toEqual([]);
    expect(state.recordingState).toBe("idle");
  });

  it("should add a message to the conversation", () => {
    const { addMessage } = useConversationStore.getState();
    const message = {
      id: "test-1",
      timestamp: Date.now(),
      originalText: "Hello",
      translatedText: "你好",
      sourceLanguage: "en-US",
      targetLanguage: "zh-CN",
      isRetranslated: false,
    };

    addMessage(message);

    const state = useConversationStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].originalText).toBe("Hello");
    expect(state.messages[0].translatedText).toBe("你好");
  });

  it("should clear all messages", () => {
    const { addMessage, clearMessages } = useConversationStore.getState();
    addMessage({
      id: "1",
      timestamp: Date.now(),
      originalText: "Test",
      translatedText: "测试",
      sourceLanguage: "en-US",
      targetLanguage: "zh-CN",
      isRetranslated: false,
    });
    addMessage({
      id: "2",
      timestamp: Date.now(),
      originalText: "Test 2",
      translatedText: "测试2",
      sourceLanguage: "en-US",
      targetLanguage: "zh-CN",
      isRetranslated: false,
    });

    clearMessages();

    const state = useConversationStore.getState();
    expect(state.messages).toHaveLength(0);
  });

  it("should update recording state", () => {
    const { setRecordingState } = useConversationStore.getState();

    setRecordingState("recording");
    expect(useConversationStore.getState().recordingState).toBe("recording");

    setRecordingState("translating");
    expect(useConversationStore.getState().recordingState).toBe("translating");

    setRecordingState("idle");
    expect(useConversationStore.getState().recordingState).toBe("idle");
  });

  it("should add subtitles", () => {
    const { addSubtitle } = useConversationStore.getState();
    const subtitle = {
      id: "sub-1",
      timestamp: Date.now(),
      originalText: "Welcome everyone",
      translatedText: "欢迎大家",
      isFinal: true,
    };

    addSubtitle(subtitle);

    const state = useConversationStore.getState();
    expect(state.subtitles).toHaveLength(1);
    expect(state.subtitles[0].originalText).toBe("Welcome everyone");
  });

  it("should clear subtitles only", () => {
    const { addMessage, addSubtitle, clearSubtitles } =
      useConversationStore.getState();

    addMessage({
      id: "msg-1",
      timestamp: Date.now(),
      originalText: "Hello",
      translatedText: "你好",
      sourceLanguage: "en-US",
      targetLanguage: "zh-CN",
      isRetranslated: false,
    });
    addSubtitle({
      id: "sub-1",
      timestamp: Date.now(),
      originalText: "Sub",
      translatedText: "字幕",
      isFinal: true,
    });

    clearSubtitles();

    const state = useConversationStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.subtitles).toHaveLength(0);
  });
});
