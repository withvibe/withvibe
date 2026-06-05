import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { AccountService } from "./account.service";

@Controller("account")
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.account.me(user.id);
  }

  @Patch()
  update(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      name?: unknown;
      positions?: unknown;
      bio?: unknown;
      defaultWorkspaceId?: unknown;
      anthropicApiKey?: unknown;
    }
  ) {
    return this.account.update(user.id, body);
  }
}
