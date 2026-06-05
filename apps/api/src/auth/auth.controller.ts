import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { CurrentUser } from "./current-user.decorator";
import type { AuthUser } from "./jwt.strategy";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AuthService } from "./auth.service";
import { LoginDto, RegisterDto } from "./dto/auth.dto";
import { PrismaService } from "../prisma/prisma.service";
import { DemoProvisionService } from "../demo/demo-provision.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly demoProvision: DemoProvisionService
  ) {}

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ) {
    const input = parse(RegisterDto, body);
    const user = await this.auth.register(input);
    // Demo mode: spin up the visitor's isolated workspace + aquarium env now
    // (no-op otherwise). Awaited so the post-register redirect lands them in
    // the new workspace; the env clone/build continues asynchronously. The
    // call is best-effort and never throws.
    await this.demoProvision.provisionDemoWorkspace(user.id);
    const token = this.auth.signSessionToken(user);
    this.auth.setSessionCookie(res, token);
    return { id: user.id, email: user.email };
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response
  ) {
    const input = parse(LoginDto, body);
    const user = await this.auth.login(input);
    const token = this.auth.signSessionToken(user);
    this.auth.setSessionCookie(res, token);
    return { id: user.id, email: user.email };
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response) {
    this.auth.clearSessionCookie(res);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const row = await this.prisma.client.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        name: true,
        defaultWorkspaceId: true,
        positions: true,
        bio: true,
      },
    });
    return row;
  }
}

function parse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestException(
        err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      );
    }
    throw err;
  }
}
