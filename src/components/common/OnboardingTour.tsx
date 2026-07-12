/**
 * First-launch onboarding tour that guides the user through setting up the
 * application: API key, language pair, and key feature highlights.
 *
 * Renders as a full-screen overlay with step navigation and skip option.
 * Once completed it sets `onboardingCompleted` in settings so it won't
 * show again.
 */

import { useState, useCallback } from 'react';
import {
  Languages,
  Mic,
  Download,
  X,
  ChevronLeft,
  ChevronRight,
  Check,
} from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { ApiKeyForm } from '@/components/settings/ApiKeyForm';
import { LanguageSelector } from '@/components/settings/LanguageSelector';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

interface FeatureCard {
  icon: React.ReactNode;
  title: string;
  description: string;
}

const FEATURES: FeatureCard[] = [
  {
    icon: <Languages className="h-6 w-6" />,
    title: 'Real-time Translation',
    description: 'Translate speech between multiple languages in real time.',
  },
  {
    icon: <Mic className="h-6 w-6" />,
    title: 'Voice Input',
    description: 'Push-to-talk and automatic speech recognition.',
  },
  {
    icon: <Download className="h-6 w-6" />,
    title: 'Export & Share',
    description: 'Save conversations and subtitles as text files.',
  },
];

const TOTAL_STEPS = 4;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OnboardingTour() {
  const onboardingCompleted = useSettingsStore((s) => s.onboardingCompleted);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const [step, setStep] = useState(1);

  // ---- Don't render if already completed ----
  if (onboardingCompleted) {
    return null;
  }

  // ---- Navigation ----

  const handleNext = useCallback(() => {
    setStep((prev) => Math.min(prev + 1, TOTAL_STEPS));
  }, []);

  const handleBack = useCallback(() => {
    setStep((prev) => Math.max(prev - 1, 1));
  }, []);

  const handleSkip = useCallback(() => {
    updateSetting('onboardingCompleted', true);
  }, [updateSetting]);

  const handleComplete = useCallback(() => {
    updateSetting('onboardingCompleted', true);
  }, [updateSetting]);

  // ---- Step renderers ----

  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="rounded-full bg-primary/10 p-4">
              <Languages className="h-10 w-10 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                Voice Translator
              </h1>
              <p className="mt-2 text-sm text-muted-foreground max-w-sm">
                Translate spoken language in real time. Hold the mic button,
                speak, and get instant translations.
              </p>
            </div>
            <div className="grid gap-3 w-full">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3 text-left"
                >
                  <div className="mt-0.5 shrink-0 rounded-md bg-primary/10 p-1.5 text-primary">
                    {feature.icon}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {feature.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {feature.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

      case 2:
        return (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Configure API Key</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Voice Translator uses DeepSeek for translations. Enter your API
                key below to get started.
              </p>
            </div>
            <ApiKeyForm />
          </div>
        );

      case 3:
        return (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Choose Languages</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Select your default source and target language pair. You can
                change this later at any time.
              </p>
            </div>
            <LanguageSelector />
          </div>
        );

      case 4:
        return (
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="rounded-full bg-green-500/10 p-4">
              <Check className="h-10 w-10 text-green-500" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">You're all set!</h2>
              <p className="mt-2 text-sm text-muted-foreground max-w-sm">
                You've configured the essentials. Start translating right away
                or explore the settings later.
              </p>
            </div>
            <ul className="w-full space-y-2 text-left">
              <li className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-500 shrink-0" />
                Hold the mic button to speak
              </li>
              <li className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-500 shrink-0" />
                Switch between Conversation and Simultaneous modes
              </li>
              <li className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-500 shrink-0" />
                Export your translations anytime
              </li>
            </ul>
          </div>
        );

      default:
        return null;
    }
  };

  // ---- Render ----

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 dark:bg-black/70">
      <Card className="relative mx-4 max-w-lg w-full shadow-2xl">
        {/* Skip button */}
        <button
          type="button"
          onClick={handleSkip}
          className="absolute right-3 top-3 rounded-full p-1.5 text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted transition-colors"
          aria-label="Skip onboarding"
        >
          <X className="h-4 w-4" />
        </button>

        <CardHeader className="pb-2">
          <CardTitle className="sr-only">Setup guide</CardTitle>
          <CardDescription className="sr-only">
            Step {step} of {TOTAL_STEPS}
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-4">
          {renderStep()}

          {/* Step indicator dots */}
          <div className="mt-6 flex items-center justify-center gap-1.5">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <span
                key={i}
                className={cn(
                  'h-2 w-2 rounded-full transition-colors duration-200',
                  i + 1 === step ? 'bg-primary' : 'bg-muted-foreground/20',
                )}
              />
            ))}
          </div>

          {/* Navigation buttons */}
          <div className="mt-4 flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBack}
              disabled={step === 1}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>

            <span className="text-xs text-muted-foreground">
              {step} / {TOTAL_STEPS}
            </span>

            {step < TOTAL_STEPS ? (
              <Button size="sm" onClick={handleNext} className="gap-1">
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="sm" onClick={handleComplete} className="gap-1">
                <Check className="h-4 w-4" />
                Start Translating
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
