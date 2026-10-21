"use client";

import { UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function UserAvatar({
  user,
  size = "default",
}: {
  user: { email: string; image?: string | null };
  size?: "default" | "sm" | "md";
}) {
  const initial = user.email.split("@")[0].match(/[a-z]/i)?.[0].toUpperCase();

  return (
    <Avatar
      size={size === "sm" ? "sm" : "default"}
      className={cn(size === "md" && "size-7")}
      role="img"
      aria-label={`${user.email} 的头像`}
    >
      {user.image && (
        <AvatarImage src={user.image} alt="" referrerPolicy="no-referrer" />
      )}
      <AvatarFallback>
        {initial || <UserRound aria-hidden="true" />}
      </AvatarFallback>
    </Avatar>
  );
}
