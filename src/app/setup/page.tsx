import type { Metadata } from "next";
import { SetupWizard } from "@/components/setup/setup-wizard";
import { aiStatus } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { publicRuntimeSettings } from "@/lib/runtime-settings";
import { requireAuth } from "../login/session";
import { loadArea } from "./load-area";

export const metadata: Metadata = { title: "Set up FlipWatch" };

export default async function SetupPage() {
  await requireAuth();
  const db = await getDb();
  return <SetupWizard settings={publicRuntimeSettings()} area={await loadArea(db)} aiReady={aiStatus().configured} />;
}
