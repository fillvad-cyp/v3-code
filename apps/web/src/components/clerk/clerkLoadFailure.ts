import { useState } from "react";

export function useClerkLoadFailed() {
  const [failed] = useState(false);
  return failed;
}

export function retryClerkLoad() {}
