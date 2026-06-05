import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Single source of truth for DEMO_MODE. When enabled (server `.env`
 * `DEMO_MODE=true`), the deployment is a public demo: every visitor gets their
 * own isolated workspace running one cloned `vibe-aquarium` env, and all other
 * env / template / repo creation is blocked server-side.
 *
 * ALL security checks read this flag (never the `NEXT_PUBLIC_DEMO_MODE` client
 * mirror, which is cosmetic only).
 */
@Injectable()
export class DemoModeService {
  /** Slug of the only env/template a demo visitor is allowed to spin up. */
  static readonly DEMO_TEMPLATE_SLUG = "vibe-aquarium";

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<string>("DEMO_MODE") === "true";
  }

  get templateSlug(): string {
    return DemoModeService.DEMO_TEMPLATE_SLUG;
  }
}
