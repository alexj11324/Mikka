import "server-only";
import { auth } from "@/lib/auth";
import { appOrigin } from "@/lib/mcp/resource";
import { policyStore } from "./runtime";
import { documentSchema, PolicyError } from "./contract";
import type { CorePolicyAdminRuntime } from "../business/core-policy-admin";
/** Public capability facade: never expose pool or private signing material. */
export function corePolicyAdminRuntime(): CorePolicyAdminRuntime {
  return {
    origin: appOrigin ?? "",
    contract: { documentSchema, PolicyError },
    authenticate: async request => {
      const session = await auth.api.getSession({headers: request.headers, query:{disableCookieCache:true}});
      return session ? {userId:session.user.id} : null;
    },
    admin: () => {
      const store=policyStore();
      return {
        signer: Object.freeze({keyId:store.signer.keyId,publicKey:store.signer.publicKey}),
        read: (workspace,actor,version)=>store.read(workspace,actor,version),
        current: (actor,workspace)=>store.current(actor,workspace),
        publish: (workspace,actor,version,document,rollback)=>store.publish(workspace,actor,version,
          document===undefined ? undefined : documentSchema.parse(document),rollback),
      };
    },
  };
}
