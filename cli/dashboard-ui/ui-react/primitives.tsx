import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "outline" | "ghost";
type ButtonSize = "md" | "sm";

type ButtonProps = ComponentPropsWithoutRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={cx(
        "ui-btn",
        variant === "outline" && "ui-btn--outline",
        variant === "ghost" && "ui-btn--ghost",
        size === "sm" && "ui-btn--sm",
        className
      )}
      {...props}
    />
  );
});

type InputProps = ComponentPropsWithoutRef<"input"> & {
  size?: "md" | "sm";
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "md", ...props },
  ref
) {
  return <input ref={ref} className={cx("ui-input", size === "sm" && "ui-input--sm", className)} {...props} />;
});

type BadgeProps = ComponentPropsWithoutRef<"span"> & { children: ReactNode };

export function Badge({ className, ...props }: BadgeProps) {
  return <span className={cx("ui-badge", className)} {...props} />;
}

type CardProps = ComponentPropsWithoutRef<"section">;

export function Card({ className, ...props }: CardProps) {
  return <section className={cx("ui-card", className)} {...props} />;
}
