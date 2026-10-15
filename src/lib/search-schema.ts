import { z } from "zod";
import { CATEGORIES, MARKETPLACES } from "./types";

export const searchLocationSchema = z.object({
  label: z.string().trim().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusKm: z.number().min(1).max(500),
  countryCode: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().max(12).nullish(),
  craigslistSite: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/i, "Craigslist site is the subdomain, e.g. 'vancouver'")
    .nullish(),
  facebookLocation: z.string().trim().max(80).nullish(),
  kijijiLocationId: z.string().trim().regex(/^\d*$/).nullish(),
  kijijiLocationSlug: z.string().trim().max(80).nullish(),
});

const cents = z.number().int().min(0).max(100_000_000);

/** Validated shape for creating/updating a saved search. Money is in cents. */
export const searchInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    query: z.string().trim().min(1).max(200),
    excludeTerms: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    titleMustMatch: z.boolean().default(false),
    minPriceCents: cents.nullish(),
    maxPriceCents: cents.nullish(),
    expectedResaleCents: cents.nullish(),
    marketplaces: z.array(z.enum(MARKETPLACES)).min(1, "Pick at least one marketplace"),
    location: searchLocationSchema,
    category: z.enum(CATEGORIES).nullish(),
    pollIntervalSec: z.number().int().min(30).max(86_400).default(120),
    maxListingAgeHours: z.number().int().min(1).max(24 * 30).default(24),
    notifyChannelIds: z.array(z.number().int().positive()).nullish(),
    notifyMinDealScore: z.number().int().min(0).max(100).nullish(),
    notifyMinAiScore: z.number().int().min(0).max(100).nullish(),
    notifyMinProfitPct: z.number().int().min(1).max(300).nullish(),
    aiInstructions: z.string().trim().max(1000).nullish(),
    notifyPriceDrops: z.boolean().default(true),
    aiEvaluate: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .refine((s) => s.minPriceCents == null || s.maxPriceCents == null || s.minPriceCents <= s.maxPriceCents, {
    message: "Min price must be less than or equal to max price",
    path: ["maxPriceCents"],
  });

export type SearchInput = z.infer<typeof searchInputSchema>;
