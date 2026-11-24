import { T } from "gt-react";
import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

/** Setup step for another computer running V3 Code. */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        <T>
          Install <code className="font-mono">v3</code> from your V3 Code build on that machine,
          then run the command above.
        </T>
      </p>
    </div>
  );
}
