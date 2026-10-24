"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Columns2,
  ExternalLink,
  Loader2,
  Monitor,
  RotateCw,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContainerStatus } from "./_runtime";

/**
 * Mobile Simulator panel — wraps a running env's web service in a phone-style
 * device frame so a mobile (or any) app can be previewed at device size. The
 * regular Preview panel is unchanged; this is an additional view. In "Both"
 * mode it shows a desktop browser frame beside the phone, which is handy for
 * products that ship a web app and a mobile app from the same env.
 */

const DEVICES = [
  { id: "iphone15", label: "iPhone 15 Pro", w: 393, h: 852, kind: "ios" },
  { id: "iphonese", label: "iPhone SE", w: 375, h: 667, kind: "ios" },
  { id: "pixel8", label: "Pixel 8", w: 412, h: 915, kind: "android" },
  { id: "galaxys24", label: "Galaxy S24", w: 384, h: 854, kind: "android" },
] as const;

type DeviceId = (typeof DEVICES)[number]["id"];
type Layout = "phone" | "desktop" | "both";

type ServiceEntry = { key: string; url: string };

// Name hints used to guess which service is the phone app vs the web app when
// an env exposes several. Order = priority.
const MOBILE_HINTS = ["mobile", "expo", "ios", "android", "app", "rn"];
const WEB_HINTS = [
  "web",
  "frontend",
  "dashboard",
  "admin",
  "ui",
  "site",
  "console",
];

function buildServices(
  serviceUrls: Record<string, string> | null,
  containerPorts: Record<string, number> | null
): ServiceEntry[] {
  if (serviceUrls && Object.keys(serviceUrls).length > 0) {
    return Object.entries(serviceUrls).map(([key, url]) => ({ key, url }));
  }
  if (containerPorts && Object.keys(containerPorts).length > 0) {
    return Object.entries(containerPorts)
      .filter(([, v]) => typeof v === "number" && v > 0)
      .map(([key, port]) => ({ key, url: `http://localhost:${port}` }));
  }
  return [];
}

function pickByHints(
  services: ServiceEntry[],
  hints: string[],
  exclude?: string
): ServiceEntry | undefined {
  for (const hint of hints) {
    const hit = services.find(
      (s) => s.key !== exclude && s.key.toLowerCase().includes(hint)
    );
    if (hit) return hit;
  }
  return undefined;
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function MobileSimulatorPanel({
  containerStatus,
  serviceReady = true,
  containerPorts,
  serviceUrls,
}: {
  containerStatus: ContainerStatus;
  serviceReady?: boolean;
  containerPorts: Record<string, number> | null;
  serviceUrls: Record<string, string> | null;
}) {
  const services = useMemo(
    () => buildServices(serviceUrls, containerPorts),
    [serviceUrls, containerPorts]
  );

  const defaults = useMemo(() => {
    const phone =
      pickByHints(services, MOBILE_HINTS) ?? services[0] ?? null;
    const web =
      pickByHints(services, WEB_HINTS, phone?.key) ??
      services.find((s) => s.key !== phone?.key) ??
      services[0] ??
      null;
    return { phone, web };
  }, [services]);

  const [layout, setLayout] = useState<Layout>("phone");
  const [deviceId, setDeviceId] = useState<DeviceId>("iphone15");
  const [landscape, setLandscape] = useState(false);
  const [phoneKey, setPhoneKey] = useState<string | null>(null);
  const [webKey, setWebKey] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const device = DEVICES.find((d) => d.id === deviceId)!;
  const phoneService =
    services.find((s) => s.key === phoneKey) ?? defaults.phone;
  const webService = services.find((s) => s.key === webKey) ?? defaults.web;

  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const w = landscape ? device.h : device.w;
  const h = landscape ? device.w : device.h;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const recompute = () => {
      const pad = 48;
      const availW =
        layout === "both" ? el.clientWidth * 0.42 : el.clientWidth;
      const availH = el.clientHeight;
      const next = Math.min(
        1,
        (availW - pad) / (w + 24),
        (availH - pad) / (h + 24)
      );
      setScale(next > 0 ? next : 0.1);
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, layout]);

  const running = containerStatus === "running";
  const busy =
    containerStatus === "starting" ||
    containerStatus === "building" ||
    containerStatus === "stopping";

  if (!running && !busy) {
    return <Placeholder>Start the container to open the simulator.</Placeholder>;
  }
  if (!phoneService && !webService) {
    return (
      <Placeholder>
        Container is running but exposes no web service to preview. Add a port
        mapping in your docker-compose.yml (or enable subdomain routing).
      </Placeholder>
    );
  }

  const phoneSrc = phoneService
    ? `${phoneService.url}${phoneService.url.includes("?") ? "&" : "?"}_r=${reloadNonce}`
    : "about:blank";
  const webSrc = webService
    ? `${webService.url}${webService.url.includes("?") ? "&" : "?"}_r=${reloadNonce}`
    : "about:blank";

  const showPhone = layout === "phone" || layout === "both";
  const showDesktop = layout === "desktop" || layout === "both";

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs shrink-0">
        <div className="inline-flex overflow-hidden rounded-md border border-border/60">
          <ToolbarToggle
            active={layout === "phone"}
            onClick={() => setLayout("phone")}
          >
            <Smartphone className="size-3.5" /> Phone
          </ToolbarToggle>
          <ToolbarToggle
            active={layout === "desktop"}
            onClick={() => setLayout("desktop")}
          >
            <Monitor className="size-3.5" /> Desktop
          </ToolbarToggle>
          <ToolbarToggle
            active={layout === "both"}
            onClick={() => setLayout("both")}
          >
            <Columns2 className="size-3.5" /> Both
          </ToolbarToggle>
        </div>

        {showPhone && (
          <>
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value as DeviceId)}
              className="rounded-md border border-border/60 bg-background px-2 py-1 font-mono"
            >
              {DEVICES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setLandscape((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 hover:text-foreground"
              title="Rotate"
            >
              <RotateCw className="size-3.5" /> Rotate
            </button>
          </>
        )}

        {services.length > 1 && (
          <div className="flex items-center gap-2 font-mono text-muted-foreground">
            {showPhone && (
              <label className="inline-flex items-center gap-1">
                <Smartphone className="size-3" />
                <select
                  value={phoneService?.key}
                  onChange={(e) => setPhoneKey(e.target.value)}
                  className="rounded border border-border/60 bg-background px-1 py-0.5"
                >
                  {services.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.key}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {showDesktop && (
              <label className="inline-flex items-center gap-1">
                <Monitor className="size-3" />
                <select
                  value={webService?.key}
                  onChange={(e) => setWebKey(e.target.value)}
                  className="rounded border border-border/60 bg-background px-1 py-0.5"
                >
                  {services.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.key}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setReloadNonce((n) => n + 1)}
            className="hover:text-foreground"
          >
            Reload
          </button>
          <a
            href={(showPhone ? phoneService : webService)?.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            Open in new tab
            <ExternalLink className="size-3" />
          </a>
        </div>
      </div>

      {/* stage */}
      <div
        ref={stageRef}
        className="relative flex flex-1 min-h-0 items-center justify-center gap-6 overflow-auto bg-neutral-950 p-6"
      >
        {showDesktop && webService && (
          <div className="flex h-full max-h-[760px] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-2xl">
            <div className="flex h-8 items-center gap-2 border-b border-neutral-700 bg-neutral-800 px-3">
              <span className="size-2.5 rounded-full bg-[#ff5f57]" />
              <span className="size-2.5 rounded-full bg-[#febc2e]" />
              <span className="size-2.5 rounded-full bg-[#28c840]" />
              <span className="ml-2 truncate font-mono text-[11px] text-neutral-400">
                {webService.url}
              </span>
            </div>
            <iframe
              key={`web-${reloadNonce}`}
              src={webSrc}
              title="Desktop preview"
              className="flex-1 w-full bg-white"
            />
          </div>
        )}

        {showPhone && phoneService && (
          <div
            className="relative shrink-0"
            style={{
              width: (w + 22) * scale,
              height: (h + 22) * scale,
            }}
          >
            <div
              className={cn(
                "absolute left-0 top-0 origin-top-left bg-black shadow-2xl",
                device.kind === "android" ? "rounded-[34px] p-2" : "rounded-[46px] p-2.5"
              )}
              style={{
                width: w + 22,
                height: h + 22,
                transform: `scale(${scale})`,
              }}
            >
              <div
                className={cn(
                  "absolute left-1/2 top-4 z-10 -translate-x-1/2 bg-black",
                  device.kind === "android"
                    ? "size-3 rounded-full"
                    : "h-7 w-28 rounded-2xl"
                )}
              />
              <iframe
                key={`phone-${reloadNonce}`}
                src={phoneSrc}
                title="Mobile preview"
                className={cn(
                  "size-full bg-white",
                  device.kind === "android" ? "rounded-[26px]" : "rounded-[38px]"
                )}
              />
            </div>
          </div>
        )}

        {running && !serviceReady && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/85 text-center backdrop-blur-sm">
            <Loader2 className="size-6 animate-spin text-primary" />
            <div>
              <p className="font-mono text-sm font-medium">Service starting…</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                The container is up, but the app inside is still booting. The
                simulator loads automatically when it&apos;s ready.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 font-mono transition-colors",
        active
          ? "bg-foreground text-background"
          : "bg-background text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
