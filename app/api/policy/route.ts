/** Community runtime retains all policy execution enforcement. The enterprise
 * management transport is supplied only by an explicit composition override. */
export const dynamic = "force-dynamic";
function unavailable() {
  return Response.json({error:"policyManagementUnavailable"}, {status:503,
    headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
}
export const GET=unavailable;
export const POST=unavailable;
