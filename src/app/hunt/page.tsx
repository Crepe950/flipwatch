import type { Metadata } from "next";
import { HuntChat } from "@/components/hunt/hunt-chat";
import { PageHeader } from "@/components/ui/page-header";
import { aiStatus } from "@/lib/ai";
import { listHunts, type HuntResult } from "@/lib/ai/deal-hunt";
import { getDb } from "@/lib/db";
import { homeAreaOption, LOCATION_PRESETS } from "@/lib/locations";
import { getDefaultLocation } from "@/lib/queries/settings";

export const metadata: Metadata = { title: "Deal Hunt" };

export default async function HuntPage() {
  const db = await getDb();
  const [rows, home] = await Promise.all([listHunts(db), getDefaultLocation(db)]);
  const turns = rows.map((h) => ({
    id: h.id,
    parentId: h.parentId,
    prompt: h.prompt,
    status: h.status,
    stage: h.stage,
    error: h.error,
    createdAt: h.createdAt.toISOString(),
    result: (h.result as HuntResult | null) ?? null,
  }));
  const ai = aiStatus();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Deal Hunt"
        description="Tell the AI what you're after. It searches Facebook, Craigslist and Kijiji right now, checks market prices and ranks the best deals."
      />
      <HuntChat
        turns={turns}
        aiConfigured={ai.configured}
        aiMessage={ai.message ?? null}
        presets={[homeAreaOption(home.label), ...LOCATION_PRESETS.map((p) => p.label).filter((label) => label !== home.label)]}
        defaultArea={{ preset: homeAreaOption(home.label), radiusKm: home.radiusKm }}
      />
    </div>
  );
}
