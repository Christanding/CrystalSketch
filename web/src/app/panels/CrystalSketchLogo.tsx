import { cn } from "@/lib/utils";

export function CrystalSketchLogo({
  className,
}: {
  className?: string;
}) {
  return (
    <img
      aria-hidden="true"
      alt=""
        src={`${import.meta.env.BASE_URL ?? "/"}favicon.svg?v=crystalsketch`}
      draggable={false}
      className={cn("block", className)}
    />
  );
}
