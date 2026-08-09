// Mirrors apps/api/src/chat/models.ts. Kept in sync by hand — the two lists
// must agree, or the picker offers an id the api then rejects.

export type ConcreteModelId =
  | "claude-fable-5"
  | "claude-opus-5"
  | "claude-opus-4-8"
  | "claude-opus-4-7"
  | "claude-sonnet-5"
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
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    description:
      "Balanced default — near-Opus quality on coding and agentic work at Sonnet cost.",
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    description:
      "Highest quality for complex agentic coding and long-horizon work. Slower and ~2x Sonnet cost.",
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    description:
      "The most capable model, for the most demanding reasoning. Slowest and most expensive; needs an API key whose org allows 30-day data retention.",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Fast and cheap — best for short, simple turns.",
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    description: "Previous-generation Opus.",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Previous-generation Opus.",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Previous-generation Sonnet.",
  },
];
