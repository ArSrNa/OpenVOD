import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ConsoleShell } from "@/components/ConsoleShell";

export default async function ConsolePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return <ConsoleShell userName={session.user.name} />;
}
