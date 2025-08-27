"use client";

import { useSession } from "next-auth/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();

  const publicPages = ["/", "/login", "/signup"];


  useEffect(() => {
    if (
      status === "unauthenticated" &&
      !publicPages.includes(pathname || "")
    ) {
      router.push("/login");
    }
  }, [status, pathname, router]);

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-lg">Loading...</p>
      </div>
    );
  }

  if (publicPages.includes(pathname || "") || status === "authenticated") {
    return <>{children}</>;
  }

  return null;
}
