import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

export function Brand({
  className,
  size = "sm",
}: {
  className?: string;
  size?: "sm" | "lg";
}) {
  if (size === "lg") {
    return (
      <div className={cn("flex flex-col items-center gap-3", className)}>
        <Terminal className="size-10 text-primary" />
        <span className="font-mono text-2xl font-bold">WithVibe</span>
      </div>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-mono text-xl font-bold",
        className
      )}
    >
      <Terminal className="size-6 text-primary" />
      WithVibe
    </span>
  );
}
