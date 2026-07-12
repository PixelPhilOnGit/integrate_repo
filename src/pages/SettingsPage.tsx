import { ApiKeyForm } from "@/components/settings/ApiKeyForm";
import { WhisperApiForm } from "@/components/settings/WhisperApiForm";
import { LanguageSelector } from "@/components/settings/LanguageSelector";
import { ThemeSelector } from "@/components/settings/ThemeSelector";
import { AsrSettings } from "@/components/settings/AsrSettings";
import { ShortcutConfig } from "@/components/settings/ShortcutConfig";
import { UsageStats } from "@/components/settings/UsageStats";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Key, Languages, Palette, Mic, Keyboard, BarChart3 } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">
            Configure your translation experience
          </p>
        </div>

        <Separator />

        <Tabs defaultValue="api" className="w-full">
          <TabsList className="w-full justify-start gap-2 flex-wrap h-auto p-1">
            <TabsTrigger value="api" className="gap-2">
              <Key className="h-4 w-4" />
              <span className="hidden sm:inline">API</span>
            </TabsTrigger>
            <TabsTrigger value="languages" className="gap-2">
              <Languages className="h-4 w-4" />
              <span className="hidden sm:inline">Languages</span>
            </TabsTrigger>
            <TabsTrigger value="appearance" className="gap-2">
              <Palette className="h-4 w-4" />
              <span className="hidden sm:inline">Appearance</span>
            </TabsTrigger>
            <TabsTrigger value="speech" className="gap-2">
              <Mic className="h-4 w-4" />
              <span className="hidden sm:inline">Speech</span>
            </TabsTrigger>
            <TabsTrigger value="shortcuts" className="gap-2">
              <Keyboard className="h-4 w-4" />
              <span className="hidden sm:inline">Shortcuts</span>
            </TabsTrigger>
            <TabsTrigger value="usage" className="gap-2">
              <BarChart3 className="h-4 w-4" />
              <span className="hidden sm:inline">Usage</span>
            </TabsTrigger>
          </TabsList>

          <div className="mt-6">
            <TabsContent value="api" className="space-y-6">
              <ApiKeyForm />
              <WhisperApiForm />
            </TabsContent>

            <TabsContent value="languages">
              <LanguageSelector />
            </TabsContent>

            <TabsContent value="appearance">
              <ThemeSelector />
            </TabsContent>

            <TabsContent value="speech">
              <AsrSettings />
            </TabsContent>

            <TabsContent value="shortcuts">
              <ShortcutConfig />
            </TabsContent>

            <TabsContent value="usage">
              <UsageStats />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
