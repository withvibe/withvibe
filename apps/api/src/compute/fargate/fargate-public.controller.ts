import { Controller, Get, Header } from "@nestjs/common";
import { BRIDGE_SOURCE } from "./bridge-source";

/**
 * Unauthenticated: the runner container in a Fargate task fetches the exec
 * bridge from here at boot (`curl $WV_BRIDGE_URL | node`), so the bridge is
 * versioned with the api instead of being baked into the runner image. The
 * source contains no secrets — tokens and TLS material arrive via the task
 * definition's environment, never from this endpoint.
 */
@Controller("fargate")
export class FargatePublicController {
  @Get("bridge.js")
  @Header("content-type", "application/javascript; charset=utf-8")
  @Header("cache-control", "no-store")
  bridge(): string {
    return BRIDGE_SOURCE;
  }
}
