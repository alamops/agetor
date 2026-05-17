import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function abbreviateHome(p: string, homeDir: string): string {
  if (!homeDir) return p;
  if (p === homeDir) return "~";
  if (p.startsWith(homeDir + "/")) return "~" + p.slice(homeDir.length);
  return p;
}
