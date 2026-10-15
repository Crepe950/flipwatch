/** Quick-start searches offered on the empty state; they prefill /searches/new via query params. */
export interface SearchTemplate {
  id: string;
  title: string;
  description: string;
  params: Record<string, string>;
}

export const SEARCH_TEMPLATES: SearchTemplate[] = [
  {
    id: "ps5",
    title: "PS5 under $400",
    description: "Consoles priced to flip, skipping broken units and empty boxes.",
    params: { name: "PS5 under $400", q: "ps5", max: "400", category: "video_games", exclude: "broken,for parts,box only,controller only" },
  },
  {
    id: "herman-miller",
    title: "Herman Miller chairs",
    description: "Aerons and Embodys regularly resell for 2–3× a quick-sale ask.",
    params: {
      name: "Herman Miller chairs",
      q: "herman miller",
      max: "600",
      resale: "900",
      category: "furniture",
      exclude: "replica,style",
      strict: "1",
    },
  },
  {
    id: "free",
    title: "Free stuff",
    description: "Everything listed for free nearby — first come, first served.",
    params: { name: "Free stuff", q: "free", max: "0", category: "free" },
  },
];

export function templateHref(template: SearchTemplate): string {
  return `/searches/new?${new URLSearchParams(template.params).toString()}`;
}
