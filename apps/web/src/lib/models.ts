// Mirrors apps/api/src/chat/models.ts. Kept in sync by hand — there are
// only four entries and they change roughly once per Claude release.

export type ConcreteModelId =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5";

export type ModelChoice = "auto" | ConcreteModelId;

export const MODEL_OPTIONS: {
  id: ModelChoice;
  label: string;
  description: string;
}[] = [
  {
    id: "auto",
    label: "Auto",
    description:
      "A cheap classifier picks Opus / Sonnet / Haiku per turn based on task complexity.",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Highest quality, slowest, most expensive.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Balanced default — strong reasoning at moderate cost.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Fast and cheap — best for short, simple turns.",
  },
];
