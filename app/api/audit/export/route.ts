import { handleAudit } from "@/lib/audit/runtime";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => handleAudit(request, true);
export const POST = (request: Request) => handleAudit(request, true);
