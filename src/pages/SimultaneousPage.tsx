import { SubtitleOverlay } from "@/components/simultaneous/SubtitleOverlay";
import { SimultaneousControls } from "@/components/simultaneous/SimultaneousControls";

export default function SimultaneousPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3">
        <SimultaneousControls />
      </div>
      <div className="flex-1 min-h-0">
        <SubtitleOverlay />
      </div>
    </div>
  );
}
