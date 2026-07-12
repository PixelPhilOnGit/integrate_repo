import { useState, useCallback } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUiStore } from "@/stores/uiStore";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LanguageSelector } from "@/components/settings/LanguageSelector";
import {
  Mic,
  Subtitles,
  Settings,
  ArrowRight,
  Check,
  Key,
  Languages,
  Sparkles,
} from "lucide-react";

interface StepProps {
  onNext: () => void;
  onSkip?: () => void;
}

// Step 1: Welcome
function WelcomeStep({ onNext }: StepProps) {
  return (
    <div className="space-y-8 text-center">
      <div className="space-y-3">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Sparkles className="h-8 w-8 text-primary" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Welcome to VoiceLingua</h1>
        <p className="text-muted-foreground text-lg max-w-md mx-auto">
          Real-time voice translation, right on your desktop. Break language barriers
          effortlessly.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-xl mx-auto">
        <Card className="text-center">
          <CardContent className="pt-6">
            <Mic className="h-8 w-8 mx-auto text-primary mb-3" />
            <h3 className="font-semibold text-sm">Conversation</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Push-to-talk, instant translate
            </p>
          </CardContent>
        </Card>
        <Card className="text-center">
          <CardContent className="pt-6">
            <Subtitles className="h-8 w-8 mx-auto text-primary mb-3" />
            <h3 className="font-semibold text-sm">Simultaneous</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Real-time subtitles for any audio
            </p>
          </CardContent>
        </Card>
        <Card className="text-center">
          <CardContent className="pt-6">
            <Settings className="h-8 w-8 mx-auto text-primary mb-3" />
            <h3 className="font-semibold text-sm">Flexible</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Your API key, your languages
            </p>
          </CardContent>
        </Card>
      </div>

      <Button onClick={onNext} size="lg" className="gap-2">
        Get Started <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

// Step 2: API Key
function ApiKeyStep({ onNext, onSkip }: StepProps) {
  const { apiKey, apiBaseUrl, updateSetting } = useSettingsStore();
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");

  const handleTest = async () => {
    if (!apiKey.trim()) return;
    setTestStatus("testing");
    try {
      const { testConnection } = await import("@/services/translationService");
      const ok = await testConnection({
        apiKey,
        apiBaseUrl,
        model: "deepseek-chat",
        temperature: 0.1,
        maxTokens: 50,
      });
      setTestStatus(ok ? "success" : "error");
      if (ok) {
        await updateSetting("apiKey", apiKey);
        setTimeout(onNext, 800);
      }
    } catch {
      setTestStatus("error");
    }
  };

  return (
    <div className="space-y-6 max-w-md mx-auto text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Key className="h-7 w-7 text-primary" />
      </div>
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Configure API Key</h2>
        <p className="text-muted-foreground">
          VoiceLingua uses DeepSeek API for fast, affordable translations.
          Get your API key at{" "}
          <a
            href="https://platform.deepseek.com/api_keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            platform.deepseek.com
          </a>
        </p>
      </div>

      <div className="space-y-4 text-left">
        <div className="space-y-2">
          <Label htmlFor="apiKey">API Key</Label>
          <Input
            id="apiKey"
            type="password"
            placeholder="sk-..."
            value={apiKey}
            onChange={(e) => updateSetting("apiKey", e.target.value)}
          />
        </div>

        <Button
          onClick={handleTest}
          disabled={!apiKey.trim() || testStatus === "testing"}
          className="w-full"
          variant={testStatus === "success" ? "outline" : "default"}
        >
          {testStatus === "testing" && "Testing..."}
          {testStatus === "idle" && "Test Connection"}
          {testStatus === "success" && "✓ Connected!"}
          {testStatus === "error" && "Connection failed — check your key"}
        </Button>
      </div>

      <div className="flex justify-center gap-4">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip for now
        </Button>
        {testStatus === "success" && (
          <Button onClick={onNext} size="sm" className="gap-2">
            Next <ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

// Step 3: Language
function LanguageStep({ onNext }: StepProps) {
  return (
    <div className="space-y-6 max-w-md mx-auto text-center">
      <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Languages className="h-7 w-7 text-primary" />
      </div>
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">Choose Languages</h2>
        <p className="text-muted-foreground">
          Select your source and target languages. You can change these anytime.
        </p>
      </div>

      <LanguageSelector />

      <Button onClick={onNext} size="lg" className="gap-2">
        Continue <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

// Step 4: Done
function CompletionStep() {
  const { updateSetting } = useSettingsStore();
  const { setOnboardingOpen } = useUiStore();

  const handleFinish = async () => {
    await updateSetting("onboardingCompleted", true);
    setOnboardingOpen(false);
  };

  return (
    <div className="space-y-8 text-center">
      <div className="mx-auto w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
        <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
      </div>
      <div className="space-y-2">
        <h2 className="text-3xl font-bold">You're All Set!</h2>
        <p className="text-muted-foreground text-lg max-w-sm mx-auto">
          Start translating in real-time. Press and hold the microphone button or
          use the Space key for push-to-talk.
        </p>
      </div>

      <Button onClick={handleFinish} size="lg" className="gap-2">
        <Sparkles className="h-5 w-5" /> Start Translating
      </Button>
    </div>
  );
}

// Main Onboarding Component
export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const { setOnboardingOpen } = useUiStore();

  const handleSkip = useCallback(async () => {
    // Allow user to skip onboarding
    setOnboardingOpen(false);
  }, [setOnboardingOpen]);

  const steps = [
    <WelcomeStep key="welcome" onNext={() => setStep(1)} />,
    <ApiKeyStep key="api" onNext={() => setStep(2)} onSkip={() => setStep(2)} />,
    <LanguageStep key="lang" onNext={() => setStep(3)} />,
    <CompletionStep key="done" />,
  ];

  return (
    <div className="fixed inset-0 z-50 bg-background flex items-center justify-center">
      {/* Skip button (top-right) */}
      {step < 3 && (
        <button
          onClick={handleSkip}
          className="absolute top-4 right-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Skip
        </button>
      )}

      {/* Step indicators */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-2 h-2 rounded-full transition-colors ${
              i === step ? "bg-primary" : i < step ? "bg-primary/40" : "bg-muted"
            }`}
          />
        ))}
      </div>

      {/* Current step */}
      <div className="max-w-lg w-full px-8">{steps[step]}</div>
    </div>
  );
}
