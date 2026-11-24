import { useGT } from "gt-react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-4">
        <Text className="text-base text-foreground-muted">
          {gt("Cloud push notifications are disabled in V3 Code.")}
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
