"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Copies text to the clipboard.
 *
 * Used for the manual-upload caption, where the whole point is that the operator
 * pastes exactly what the automated path would have sent — retyping it would
 * lose the platform-specific truncation.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2_000);
          })
          // A blocked clipboard is not worth an error dialog: the text is on
          // screen and can be selected by hand.
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}
