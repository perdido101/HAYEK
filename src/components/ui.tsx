import * as React from "react";
import { cn } from "@/lib/utils";

/* A small vault-styled primitive set. Hairline borders, panel surfaces, mono
 * numerals. Deliberately minimal — this is an instrument panel, not a design
 * system showcase. */

export function Button({
  className,
  variant = "default",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "ghost" | "pass" }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
        variant === "default" && "border-border bg-muted hover:bg-border text-foreground",
        variant === "ghost" && "border-transparent hover:bg-muted text-muted-foreground hover:text-foreground",
        variant === "pass" && "border-transparent bg-[hsl(var(--pass))] text-black hover:opacity-90",
        className,
      )}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-md border border-border bg-panel", className)} {...props} />;
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full rounded border border-input bg-background px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded border border-input bg-background px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground focus:border-ring",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  className,
  tone = "muted",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: "muted" | "pass" | "fail" }) {
  return (
    <span
      className={cn(
        "num inline-flex items-center rounded border px-1.5 py-0.5 text-xs",
        tone === "muted" && "border-border text-muted-foreground",
        tone === "pass" && "border-transparent bg-[hsl(var(--pass)/0.15)] text-[hsl(var(--pass))]",
        tone === "fail" && "border-transparent bg-[hsl(var(--fail)/0.15)] text-[hsl(var(--fail))]",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-xs text-muted-foreground", className)} {...props} />;
}
