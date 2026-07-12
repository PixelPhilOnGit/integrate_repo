import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Mock the translation pipeline hook
const mockStartConversation = vi.fn();
const mockStopConversation = vi.fn();

let mockPipelineState = "idle";

vi.mock("@/hooks/useTranslationPipeline", () => ({
  useTranslationPipeline: () => ({
    pipelineState: mockPipelineState,
    startConversation: mockStartConversation,
    stopConversation: mockStopConversation,
    cancel: vi.fn(),
    isActive: mockPipelineState !== "idle",
  }),
}));

// Mock lucide-react icons
vi.mock("lucide-react", () => ({
  Mic: () => <span data-testid="icon-mic" />,
  Square: () => <span data-testid="icon-square" />,
  Loader2: () => <span data-testid="icon-loader" />,
  Volume2: () => <span data-testid="icon-volume" />,
}));

import { RecordButton } from "../src/components/conversation/RecordButton";

describe("RecordButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipelineState = "idle";
  });

  it("should render the idle state with mic icon", () => {
    render(<RecordButton />);
    expect(screen.getByRole("button")).toBeInTheDocument();
    expect(screen.getByText("Hold to speak")).toBeInTheDocument();
    expect(screen.getByTestId("icon-mic")).toBeInTheDocument();
  });

  it("should have correct aria label in idle state", () => {
    render(<RecordButton />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "Hold to start recording");
  });

  it("should not be disabled when idle", () => {
    render(<RecordButton />);
    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();
  });

  it("should call startConversation on mouse down when idle", () => {
    render(<RecordButton />);
    fireEvent.mouseDown(screen.getByRole("button"));
    expect(mockStartConversation).toHaveBeenCalled();
  });

  it("should call stopConversation on mouse up when recording", () => {
    mockPipelineState = "recording";
    render(<RecordButton />);
    fireEvent.mouseUp(screen.getByRole("button"));
    expect(mockStopConversation).toHaveBeenCalled();
  });
});
