import { useConversationStore } from "@/stores/conversationStore";
import { ConversationList } from "@/components/conversation/ConversationList";
import { RecordButton } from "@/components/conversation/RecordButton";
import { ConversationToolbar } from "@/components/conversation/ConversationToolbar";
import { StatusIndicator } from "@/components/common/StatusIndicator";
import { WaveformAnimation } from "@/components/common/WaveformAnimation";

export default function ConversationPage() {
  const recordingState = useConversationStore((s) => s.recordingState);

  return (
    <div className="flex flex-col h-full">
      <ConversationToolbar />
      <div className="px-4 py-1.5">
        <StatusIndicator state={recordingState} />
      </div>
      {recordingState === "recording" && (
        <div className="px-4 py-2">
          <WaveformAnimation isActive={true} />
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ConversationList />
      </div>
      <div className="flex justify-center py-6 border-t">
        <RecordButton />
      </div>
    </div>
  );
}
