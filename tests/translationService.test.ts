import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the translation service module
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("TranslationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call DeepSeek API with correct request format", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "你好世界" } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
    });

    // Dynamic import to test the actual module
    const { translate } = await import("../src/services/translationService");

    const result = await translate("Hello world", "en-US", "zh-CN", {
      apiKey: "test-key",
      apiBaseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      temperature: 0.1,
      maxTokens: 1024,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const url = callArgs[0];
    const options = callArgs[1];

    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(options.method).toBe("POST");
    expect(options.headers["Authorization"]).toBe("Bearer test-key");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.temperature).toBe(0.1);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("Hello world");

    expect(result).toBe("你好世界");
  });

  it("should throw on API error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: { message: "Invalid API key" } }),
    });

    const { translate } = await import("../src/services/translationService");

    await expect(
      translate("test", "en-US", "zh-CN", {
        apiKey: "invalid-key",
        apiBaseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        temperature: 0.1,
        maxTokens: 1024,
      })
    ).rejects.toThrow();
  });

  it("should retry on network errors up to 3 times", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "test" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });

    const { translate } = await import("../src/services/translationService");

    const result = await translate(
      "test",
      "en-US",
      "zh-CN",
      {
        apiKey: "key",
        apiBaseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        temperature: 0.1,
        maxTokens: 1024,
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toBe("test");
  });

  it("should return false on connection test failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const { testConnection } = await import("../src/services/translationService");

    const result = await testConnection({
      apiKey: "bad-key",
      apiBaseUrl: "https://invalid.url",
      model: "deepseek-chat",
      temperature: 0.1,
      maxTokens: 50,
    });

    expect(result).toBe(false);
  });
});
