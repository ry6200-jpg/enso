import Link from "next/link";
import HoroscopeTab from "../components/HoroscopeTab";

/**
 * Phase 7 follow-up (UI fixes batch): the tab-navigation pattern (Chat /
 * Horoscope / People switched via in-page state) was removed entirely per
 * live feedback. Horoscope moves to its own route, matching how People
 * already worked — both are now reached the same way, via links in the
 * sidebar (app/components/ZodiacSidebar.tsx), not tabs.
 */
export default function HoroscopePage() {
  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-stone-200">
        <Link href="/" className="text-sm text-stone-500">
          ← Chat
        </Link>
        <span className="font-serif text-lg">Horoscope</span>
      </header>
      <HoroscopeTab />
    </div>
  );
}
