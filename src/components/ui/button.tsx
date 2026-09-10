"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  buttonClass,
  type ButtonSize,
  type ButtonVariant,
} from "./button-styles";

/**
 * Buttons. `SubmitButton` reads the enclosing form's pending state, so every
 * server-action form gets a spinner and a disabled state without any local
 * useState.
 *
 * The style function itself lives in ./button-styles so server components can
 * call it — see the note there.
 */

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function SubmitButton({
  variant = "primary",
  size = "md",
  className,
  children,
  pendingLabel,
  ...props
}: ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || props.disabled}
      className={buttonClass(variant, size, className)}
      {...props}
    >
      {pending ? <Loader2 className="animate-spin" /> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
