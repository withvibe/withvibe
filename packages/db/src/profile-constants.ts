export const POSITIONS = [
  // Engineering
  "frontend_engineer",
  "backend_engineer",
  "fullstack_engineer",
  "mobile_engineer",
  "devops_sre",
  "qa_engineer",
  "security_engineer",
  "support_engineer",

  // Data / ML
  "data_engineer",
  "ml_ai_engineer",
  "data_scientist",

  // Engineering leadership
  "tech_lead",
  "engineering_manager",

  // Product / Design
  "product_manager",
  "designer",

  // Executive
  "vp_rnd",
  "cto",
  "ceo",

  // Go-to-market
  "marketing",
  "growth",
  "sales",
  "customer_success",
  "customer_strategy",
  "technical_support",

  // Business ops
  "operations",
  "finance",
  "people_hr",
] as const;

export type Position = (typeof POSITIONS)[number];

export const POSITION_LABELS: Record<Position, string> = {
  frontend_engineer: "Frontend Engineer",
  backend_engineer: "Backend Engineer",
  fullstack_engineer: "Fullstack Engineer",
  mobile_engineer: "Mobile Engineer",
  devops_sre: "DevOps / SRE",
  qa_engineer: "QA Engineer",
  security_engineer: "Security Engineer",
  support_engineer: "Support Engineer",
  data_engineer: "Data Engineer",
  ml_ai_engineer: "ML / AI Engineer",
  data_scientist: "Data Scientist",
  tech_lead: "Tech Lead",
  engineering_manager: "Engineering Manager",
  product_manager: "Product Manager",
  designer: "Designer",
  vp_rnd: "VP R&D",
  cto: "CTO",
  ceo: "CEO",
  marketing: "Marketing",
  growth: "Growth",
  sales: "Sales",
  customer_success: "Customer Success",
  customer_strategy: "Customer Strategy",
  technical_support: "Technical Support",
  operations: "Operations",
  finance: "Finance",
  people_hr: "People / HR",
};

export const MAX_FREE_TEXT_LENGTH = 80;
export const MAX_BIO_LENGTH = 500;
export const MAX_POSITIONS = 5;

export function isKnownPosition(value: string): value is Position {
  return (POSITIONS as readonly string[]).includes(value);
}

export function positionLabel(value: string): string {
  return isKnownPosition(value) ? POSITION_LABELS[value] : value;
}
