import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthUser } from "./jwt.strategy";

/**
 * Pulls the authenticated user off the request. Populated by JwtStrategy.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard)
 *   @Get("/me")
 *   me(@CurrentUser() user: AuthUser) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!req.user) {
      throw new Error("CurrentUser used on a route without JwtAuthGuard");
    }
    return req.user;
  }
);
