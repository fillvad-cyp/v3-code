import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useGT } from "gt-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

export function SettingsDiagnosticsRouteScreen() {
  const insets = useSafeAreaInsets();
  const gt = useGT();

  return (
    <SettingsScreen title={gt("Diagnostics")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("Privacy")}>
          <View className="items-center gap-2 px-6 py-8">
            <SymbolView
              name="checkmark.circle"
              size={28}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="regular"
            />
            <Text className="text-center text-base text-foreground">
              {gt("Telemetry and crash reporting are permanently disabled")}
            </Text>
            <Text className="text-center text-sm text-foreground-muted">
              {gt("V3 Code never sends crash logs, analytics, or traces to external servers.")}
            </Text>
          </View>
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
