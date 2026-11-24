import { useState } from "react";

const DISABLED_AUTH_PROMPT = {
  openAuthPrompt: () => {},
};

export function useT3ConnectAuthPrompt() {
  const [prompt] = useState(DISABLED_AUTH_PROMPT);
  return prompt;
}
