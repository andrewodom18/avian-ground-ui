import type { Metadata } from "next";
import { Dashboard } from "./Dashboard";

export const metadata: Metadata = {
  title: "AVIAN Ground | Operations",
  description: "Read-only AVIAN mesh health and field telemetry.",
  other: { "codex-preview": "development" },
};

export default function Home() {
  return <Dashboard />;
}
