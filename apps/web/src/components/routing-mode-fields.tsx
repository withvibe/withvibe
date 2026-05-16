"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

export type RoutingMode = "port" | "subdomain";

export function RoutingModeFields({
  routingMode,
  routingBaseDomain,
  onChange,
  disabled,
  disabledReason,
}: {
  routingMode: RoutingMode;
  routingBaseDomain: string;
  onChange: (next: { routingMode: RoutingMode; routingBaseDomain: string }) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  function setMode(next: RoutingMode) {
    if (disabled) return;
    // Seed "localhost" the first time the user flips to subdomain so the
    // common dev-on-laptop path works without an extra field interaction.
    const nextBase =
      next === "subdomain" && routingBaseDomain.trim().length === 0
        ? "localhost"
        : routingBaseDomain;
    onChange({ routingMode: next, routingBaseDomain: nextBase });
  }

  function setBase(value: string) {
    if (disabled) return;
    onChange({ routingMode, routingBaseDomain: value });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label className="text-sm">Routing mode</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={routingMode === "port" ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => setMode("port")}
          >
            Port
          </Button>
          <Button
            type="button"
            variant={routingMode === "subdomain" ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => setMode("subdomain")}
          >
            Subdomain
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Port mode publishes each service on a host port (e.g.{" "}
          <code className="font-mono">localhost:3001</code>). Subdomain mode
          routes through Traefik on a wildcard hostname.
        </p>
        {disabled && disabledReason && (
          <p className="text-xs text-muted-foreground italic">
            {disabledReason}
          </p>
        )}
      </div>

      {routingMode === "subdomain" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="routingBaseDomain" className="text-sm">
              Base domain
            </Label>
            <Input
              id="routingBaseDomain"
              value={routingBaseDomain}
              disabled={disabled}
              onChange={(e) => setBase(e.target.value)}
              placeholder="localhost"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Services are reachable at{" "}
              <code className="font-mono">
                https://&lt;service&gt;.env-&lt;id&gt;.{routingBaseDomain || "<base>"}
              </code>
              .
            </p>
          </div>

          <Alert>
            <AlertDescription>
              Subdomain mode requires Traefik installed on the host. See setup
              docs.
            </AlertDescription>
          </Alert>
        </>
      )}
    </div>
  );
}
