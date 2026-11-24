import { T, useGT } from "gt-react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title={gt("About")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const gt = useGT();
  const version = Constants.expoConfig?.version ?? "0.0.0";
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const build = Application.nativeBuildVersion;
  const versionWithBuild = build ? `${version} (${build})` : version;
  const versionLabel = variantLabel ? `${versionWithBuild} · ${variantLabel}` : versionWithBuild;

  return (
    <SettingsSection title={gt("App", { $context: "settings section about this mobile app" })}>
      <SettingsRow
        icon="internaldrive"
        label={gt("Client Storage")}
        target="SettingsClientStorage"
      />
      <SettingsRow icon="stethoscope" label={gt("Diagnostics")} target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label={gt("Open source licenses")}
        target="SettingsOpenSourceLicenses"
      />
      <View className="flex-row items-center gap-4 p-4">
        <SymbolView
          name="info.circle"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-lg text-foreground">
          <T>Version</T>
        </Text>
        <View className="items-end">
          <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
          <Text className="text-xs text-foreground-muted/70">{gt("V3 Code · zero telemetry")}</Text>
        </View>
      </View>
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
