import { useGT } from "gt-react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";

export function OutdatedServerUpdateSection({
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const gt = useGT();
  return (
    <SettingsSection title={gt("V3 Code")}>
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">{gt("Update required")}</Text>
        <Text className="text-sm text-foreground-muted">
          {gt(
            "This app needs a newer version of {product} on {environment}. Automatic updates are disabled in V3 Code.",
            { product: "V3 Code", environment: label },
          )}
        </Text>
      </View>
    </SettingsSection>
  );
}
