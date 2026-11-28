import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { T, useGT, Var } from "gt-react-native";
import { useReducer } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text, AppTextInput, type AppTextInputProps } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { loginEnvironmentWithCode } from "../../state/use-remote-environment-registry";
import {
  initialMobileLoginState,
  normalizeLoginCode,
  normalizeLoginHost,
  transitionMobileLoginState,
} from "./EnvironmentLoginScreen.logic";

export type EnvironmentLoginRouteParams = {
  readonly host?: string;
  readonly environmentId?: EnvironmentId;
  readonly label?: string;
};

export function EnvironmentLoginRouteScreen({
  route,
}: StaticScreenProps<EnvironmentLoginRouteParams | undefined>) {
  const params = route.params ?? {};
  return (
    <EnvironmentLoginForm
      key={`${params.environmentId ?? ""}:${params.host ?? ""}`}
      initialHost={params.host ?? ""}
      environmentId={params.environmentId}
      environmentLabel={params.label}
    />
  );
}

function EnvironmentLoginForm({
  initialHost,
  environmentId,
  environmentLabel,
}: {
  readonly initialHost: string;
  readonly environmentId: EnvironmentId | undefined;
  readonly environmentLabel: string | undefined;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [state, dispatch] = useReducer(
    transitionMobileLoginState,
    { host: initialHost },
    initialMobileLoginState,
  );
  const hostLocked = environmentId !== undefined && initialHost.trim().length > 0;
  const isSubmitting = state.status === "submitting";
  const submitDisabled =
    isSubmitting ||
    normalizeLoginHost(state.host) === null ||
    normalizeLoginCode(state.code) === null;

  const handleSubmit = async () => {
    const host = normalizeLoginHost(state.host);
    if (host === null) {
      dispatch({
        type: "validation_failed",
        message: gt("Enter the environment address to continue."),
      });
      return;
    }
    const code = normalizeLoginCode(state.code);
    if (code === null) {
      dispatch({
        type: "validation_failed",
        message: gt("Enter a login code to continue."),
      });
      return;
    }

    dispatch({ type: "submit_started" });
    const outcome = await loginEnvironmentWithCode({
      host,
      code,
      ...(environmentId === undefined ? {} : { expectedEnvironmentId: environmentId }),
    });
    void Haptics.notificationAsync(
      outcome.ok
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Error,
    );
    if (!outcome.ok) {
      dispatch({ type: "submit_failed", message: outcome.error });
      return;
    }
    dispatch({ type: "submit_succeeded" });
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.dispatch(StackActions.replace("Home"));
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title={
          environmentLabel
            ? gt("Sign in to {environment}", { environment: environmentLabel })
            : gt("Sign in with code")
        }
        onClose={navigation.canGoBack() ? () => navigation.goBack() : undefined}
        closeAccessibilityLabel={gt("Close sign in")}
      />
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View collapsable={false} className="gap-5">
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            {environmentLabel ? (
              <T>
                Enter your one-time login code for <Var>{environmentLabel}</Var> to start a session.
              </T>
            ) : (
              <T>Enter your one-time login code to start a session.</T>
            )}
          </Text>

          <View
            collapsable={false}
            className={cn(
              "overflow-hidden rounded-[26px] border-continuous border bg-grouped-card",
              state.status === "error" && state.errorMessage
                ? "border-danger-foreground"
                : "border-transparent",
            )}
          >
            <LoginInputRow
              label={gt("Address")}
              editable={!hostLocked && !isSubmitting}
              keyboardType="url"
              placeholder="192.168.1.100:3873"
              value={state.host}
              onChangeText={(value) => dispatch({ type: "host_changed", value })}
            />
            <View className="ml-4 border-t border-border-subtle" />
            <LoginInputRow
              label={gt("Login code")}
              editable={!isSubmitting}
              autoCapitalize="characters"
              textContentType="oneTimeCode"
              placeholder={gt("Paste or type your login code")}
              returnKeyType="go"
              value={state.code}
              onChangeText={(value) => dispatch({ type: "code_changed", value })}
              onSubmitEditing={() => {
                if (!submitDisabled) void handleSubmit();
              }}
            />
          </View>

          {state.status === "error" && state.errorMessage ? (
            <Text
              accessibilityLiveRegion="polite"
              className="px-4 text-sm leading-normal text-danger-foreground"
            >
              {state.errorMessage}
            </Text>
          ) : (
            <Text className="px-4 text-sm leading-normal text-foreground-muted">
              <T>Ask the environment owner for a new one-time login code if yours has expired.</T>
            </Text>
          )}

          <Button
            label={isSubmitting ? gt("Signing in…") : gt("Sign in")}
            tone="primary"
            fullWidth
            disabled={submitDisabled}
            loading={isSubmitting}
            onPress={() => {
              void handleSubmit();
            }}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function LoginInputRow({
  label,
  ...inputProps
}: Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
}) {
  return (
    <View collapsable={false} className="min-h-[48px] flex-row items-center gap-3 px-4">
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className="w-24 text-base leading-[23px] text-foreground-muted"
      >
        {label}
      </Text>
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        autoCorrect={false}
        textAlignVertical="center"
        className="min-h-[48px] flex-1 self-stretch rounded-none border-0 bg-transparent p-0 text-base leading-[23px]"
      />
    </View>
  );
}
