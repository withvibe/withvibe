import {
  Controller,
  Get,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthGuard } from "@nestjs/passport";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import type { GoogleUser } from "./google.strategy";
import { DemoProvisionService } from "../demo/demo-provision.service";

@Controller("auth/google")
export class GoogleAuthController {
  private readonly webBaseUrl: string;

  constructor(
    private readonly auth: AuthService,
    private readonly demoProvision: DemoProvisionService,
    config: ConfigService
  ) {
    this.webBaseUrl =
      config.get<string>("WEB_PUBLIC_URL") || "http://localhost:3000";
  }

  /** Kicks off the Google OAuth flow. Passport handles the redirect. */
  @Get()
  @UseGuards(AuthGuard("google"))
  start(): void {
    // No-op — AuthGuard("google") issues the redirect to Google.
  }

  @Get("callback")
  @UseGuards(AuthGuard("google"))
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const profile = req.user as GoogleUser | undefined;
    if (!profile?.email) {
      throw new ServiceUnavailableException("Google profile unavailable");
    }
    const user = await this.auth.findOrCreateGoogleUser(
      profile.email,
      profile.name
    );
    // Demo mode: provision the visitor's workspace + aquarium env on first
    // sign-in (idempotent — existing users with a workspace are skipped).
    await this.demoProvision.provisionDemoWorkspace(user.id);
    const token = this.auth.signSessionToken(user);
    this.auth.setSessionCookie(res, token);
    res.redirect(`${this.webBaseUrl.replace(/\/$/, "")}/`);
  }
}
