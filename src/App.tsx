import { useEffect } from "react";
import { useTheme } from "@/hooks/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { AppShell } from "@/components/layout/AppShell";
import { OnboardingTour } from "@/components/common/OnboardingTour";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function App() {
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  useTheme();

  useEffect(() => {
    loadSettings().catch(console.error);
  }, [loadSettings]);

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <AppShell />
        <OnboardingTour />
        <Toaster />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
