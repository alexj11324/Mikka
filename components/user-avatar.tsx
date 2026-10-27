"use client";

import { UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { avatarImageSrc } from "@/lib/default-avatar";
import { useTranslations } from "next-intl";

export function UserAvatar({
  user,
  size = "default",
}: {
  user: { email: string; name?: string | null; image?: string | null };
  size?: "default" | "sm" | "md";
}) {
  const t = useTranslations('Common')
  const initial = user.email.split("@")[0].match(/[a-z]/i)?.[0].toUpperCase();

  return (
    <Avatar
      size={size === "sm" ? "sm" : "default"}
      className={cn(size === "md" && "size-7")}
      role="img"
      aria-label={t('avatarLabel', { email: user.email })}
    >
      {user.image && (
        <AvatarImage src={avatarImageSrc(user.image)} alt="" referrerPolicy="no-referrer" />
      )}
      <AvatarFallback>
        {initial || <UserRound aria-hidden="true" />}
      </AvatarFallback>
    </Avatar>
  );
}
