import { redirect } from "next/navigation";
import DashboardClient from "./dashboard-client";
import { getCurrentUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <DashboardClient currentUser={user} />;
}
