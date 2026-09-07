export function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_CRYSTALSKETCH_API_URL ?? "").trim().replace(/\/+$/, "");
  return `${base}${path}`;
}
