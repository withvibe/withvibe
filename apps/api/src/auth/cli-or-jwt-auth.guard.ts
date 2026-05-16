import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * Accepts either a JWT (cookie or Authorization bearer) OR a CLI token
 * (Authorization bearer prefixed `wv_cli_`). Used on endpoints the CLI
 * hits directly — the web browser pathway sends a cookie/JWT, the CLI
 * pathway sends its own opaque token.
 */
@Injectable()
export class CliOrJwtAuthGuard extends AuthGuard(["jwt", "cli-token"]) {}
