"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";

const ConciergePanel = dynamic(
  () => import("@/components/concierge-panel").then((module) => module.ConciergePanel),
  { ssr: false },
);

export function ConciergeShell() {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const previousPath = useRef(pathname);

  useEffect(() => {
    if (previousPath.current !== pathname) {
      previousPath.current = pathname;
      setOpen(false);
    }
  }, [pathname]);

  function launch() {
    setActivated(true);
    setOpen(true);
  }

  return (
    <>
      <button
        ref={launcherRef}
        className="concierge-launcher"
        type="button"
        aria-label="Open Home Watch Concierge"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={activated ? "home-watch-concierge" : undefined}
        onClick={launch}
      >
        <MessageCircleQuestion aria-hidden="true" size={22} strokeWidth={1.8} />
        <span>Quick answers</span>
      </button>
      {activated ? (
        <ConciergePanel
          open={open}
          launcherRef={launcherRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
