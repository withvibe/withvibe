import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/** Use on any controller/route that requires a valid bridge JWT. */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {}
