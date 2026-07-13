import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { signOut } from "./actions";

const NAV = [
  { href: "/", label: "LOOP" },
  { href: "/traces", label: "TRACES" },
  { href: "/inbox", label: "INBOX" },
  { href: "/settings", label: "KEYS" },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { email, org } = await requireOrg();

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            HAYEK
          </Link>
          <nav className="flex items-center gap-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="num rounded px-2 py-1 text-xs tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="num">{org.orgName}</span>
          <span className="text-border">·</span>
          <span>{email}</span>
          <form action={signOut}>
            <button className="rounded px-2 py-1 hover:bg-muted hover:text-foreground">sign out</button>
          </form>
        </div>
      </header>
      <div className="px-6 py-6">{children}</div>
    </div>
  );
}
